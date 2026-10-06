// src/app/api/execute/serviceBuilders.ts
// The storefront services that were rebuilt to match what they advertise. Each one
// follows the XRPL reference for the transaction it builds (AccountSet, Payment,
// TrustSet, SignerListSet…), and where correctness depends
// on live ledger state (existing trust-line limit, an existing regular key) it READS that state instead of guessing.
//
// Multi-step services return `steps`, signed in order; the plan (step ids) is fixed at
// step 1 and later steps are built by id (ctx.planIds).

import { createHash } from 'crypto';
import { LSF, ammExists, findPaths, getAccount, getAmm, getDelegate, getLines } from '@/lib/serviceChain';
import { buildDelegateGrant, grantedPermissions, parsePermissions } from '@/lib/delegation';
import { serviceAvailability } from '@/lib/serviceAmendments';
import {
  BAD, CAUTION, CAUTION_STEPS, NEED, SAFE, SAFE_STEPS,
  amountOf, assetFrom, currencyCode, hexOf, isAddr, isDomain, positiveDecimal, str, truthy,
  type Builder, type BuildStep,
} from './buildKit';

// AccountSet asf* flags (SetFlag / ClearFlag values)
const ASF = { DISABLE_MASTER: 4, NO_FREEZE: 6, DEFAULT_RIPPLE: 8 } as const;
// tx flags
const TF_DISALLOW_XRP = 0x00100000; // AccountSet tfDisallowXRP
const TF_SET_NO_RIPPLE = 0x00020000; // TrustSet
const TF_CLEAR_NO_RIPPLE = 0x00040000; // TrustSet

const LEDGER_UNREACHABLE =
  'could not read your account from the ledger just now — try again in a moment (this transaction is not built blind).';

const md5Hex = (email: string) => createHash('md5').update(email.trim().toLowerCase()).digest('hex').toUpperCase();

/** Round a number of IOU units up to a plain-decimal string with 15 significant digits. */
function iouValue(n: number): string {
  const up = n * (1 + 1e-9);
  let s = up.toPrecision(15);
  if (/e/i.test(s)) s = up.toFixed(15).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function domainAndEmail(p: Record<string, unknown>): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } | { need: string[] } {
  const domain = str(p.domain || p.data).toLowerCase();
  if (!domain) return { need: ['domain'] };
  if (!isDomain(domain)) return { ok: false, error: 'domain must be a hostname like example.com — lowercase, no https://, no path' };
  const fields: Record<string, unknown> = { Domain: hexOf(domain) };
  const email = str(p.email);
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'that email address looks invalid' };
    // XRPL's EmailHash is a 128-bit value, conventionally the MD5 of the lowercased email (Gravatar-style)
    fields.EmailHash = md5Hex(email);
  }
  return { ok: true, fields };
}

export const richBuilders: Record<string, Builder> = {

  // ── Multi-Sig Fortress ─────────────────────────────────────────────────────
  // SignerListSet alone does NOT stop the master key (or a regular key) from signing by
  // itself. To make multi-signing the ONLY way to move funds we must also remove any
  // regular key and disable the master key — in that order, and only after the signer
  // list exists (asfDisableMaster needs an alternative way to sign).
  multisig: async (account, p, ctx) => {
    const signersRaw = str(p.signers);
    const quorum = Number(p.quorum);
    if (!signersRaw || !quorum) return NEED(['signers', 'quorum']);
    const list = [...new Set(signersRaw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (list.length < 1 || list.length > 32 || list.some((a) => !isAddr(a))) return BAD('signers must be 1–32 unique XRPL addresses');
    if (list.includes(account)) return BAD('your own address cannot be on its own signer list');
    if (!Number.isInteger(quorum) || quorum < 1) return BAD('quorum must be a whole number of at least 1');
    if (quorum > list.length) return BAD(`quorum (${quorum}) cannot exceed the number of signers (${list.length}) — the list could never sign anything`);

    const steps: BuildStep[] = [{
      id: 'signerlist',
      label: `Set the signer list (${quorum}-of-${list.length})`,
      txjson: {
        TransactionType: 'SignerListSet',
        Account: account,
        SignerQuorum: quorum,
        SignerEntries: list.map((a) => ({ SignerEntry: { Account: a, SignerWeight: 1 } })),
      },
    }];

    const disableMaster = truthy(p.disableMaster);
    if (disableMaster) {
      let clearRegularKey: boolean;
      if (ctx?.planIds) clearRegularKey = ctx.planIds.includes('clear-regkey');
      else {
        const acct = await getAccount(account);
        if (!acct) return BAD(LEDGER_UNREACHABLE);
        if (!acct.found) return BAD('that account is not activated on XRPL mainnet');
        clearRegularKey = acct.regularKey != null;
      }
      if (clearRegularKey) {
        steps.push({ id: 'clear-regkey', label: 'Remove your regular key', txjson: { TransactionType: 'SetRegularKey', Account: account } });
      }
      steps.push({ id: 'disable-master', label: 'Disable the master key', txjson: { TransactionType: 'AccountSet', Account: account, SetFlag: ASF.DISABLE_MASTER } });
    }
    return CAUTION_STEPS(steps, disableMaster ? 'Multi-Sig lockdown (signer list + disable master key)' : 'Multi-Sig (signer list only)');
  },

  // ── Issuer Trustless Declaration = asfNoFreeze (IRREVERSIBLE) ──────────────
  issuerdecl: async (account) => {
    const acct = await getAccount(account);
    if (!acct) return BAD(LEDGER_UNREACHABLE + ' It is irreversible, so it is never built without checking your account first.');
    if (!acct.found) return BAD('that account is not activated on XRPL mainnet');
    if (acct.flags & LSF.NO_FREEZE) return BAD('No Freeze is already enabled on this account — there is nothing to do.');
    if (acct.flags & LSF.GLOBAL_FREEZE)
      return BAD('Global Freeze is currently ON for this account. Enabling No Freeze now would make that Global Freeze permanent — it could never be turned off. Turn Global Freeze off first, then come back.');
    return CAUTION({ TransactionType: 'AccountSet', Account: account, SetFlag: ASF.NO_FREEZE }, 'Renounce freeze authority (asfNoFreeze — permanent)');
  },

  // ── Full Issuer Config ─────────────────────────────────────────────────────
  // One AccountSet: Default Ripple (so issued balances can flow between holders) plus any of
  // Domain, TransferRate, TickSize, and optionally DisallowXRP. (An AccountSet can set only ONE
  // asf flag, so DefaultRipple is the flag; the others are fields.)
  issuercfg: (account, p) => {
    const domain = str(p.domain).toLowerCase();
    const fee = str(p.transferFee);
    const tick = str(p.tickSize);
    if (!domain && !fee && !tick) return NEED(['domain', 'transferFee', 'tickSize']);
    const tx: Record<string, unknown> = { TransactionType: 'AccountSet', Account: account, SetFlag: ASF.DEFAULT_RIPPLE };
    if (domain) {
      if (!isDomain(domain)) return BAD('domain must be a hostname like example.com — lowercase, no https://, no path');
      tx.Domain = hexOf(domain);
    }
    if (fee) {
      const pct = Number(fee);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return BAD('transfer fee must be between 0% and 100%');
      tx.TransferRate = Math.round((1 + pct / 100) * 1_000_000_000); // billionths; 1e9 = no fee, 2e9 = 100%
    }
    if (tick) {
      const t = Number(tick);
      if (!Number.isInteger(t) || !(t === 0 || (t >= 3 && t <= 15))) return BAD('tick size must be 0 (off) or a whole number from 3 to 15');
      tx.TickSize = t;
    }
    if (truthy(p.disallowXRP)) tx.Flags = TF_DISALLOW_XRP;
    return SAFE(tx, 'Full Issuer Config (Default Ripple + domain / fee / tick size)');
  },

  // ── Rippling Controller ────────────────────────────────────────────────────
  // issuer mode: the account-wide DefaultRipple flag (enable = SetFlag, disable = ClearFlag).
  // holder mode: the NoRipple flag on ONE trust line (enable rippling = ClearNoRipple).
  rippling: async (account, p) => {
    const enable = !['false', 'off', 'no', '0'].includes(str(p.enable).toLowerCase());
    if (str(p.mode).toLowerCase() !== 'holder') {
      return SAFE(
        { TransactionType: 'AccountSet', Account: account, [enable ? 'SetFlag' : 'ClearFlag']: ASF.DEFAULT_RIPPLE },
        enable ? 'Enable Default Ripple (issuer)' : 'Disable Default Ripple (issuer)'
      );
    }
    const cur = currencyCode(str(p.currency));
    const peer = str(p.issuer);
    if (!cur || cur === 'XRP' || !isAddr(peer)) return NEED(['currency', 'issuer']);
    const lines = await getLines(account, peer);
    if (!lines) return BAD(LEDGER_UNREACHABLE);
    const line = lines.find((l) => l.currency.toUpperCase() === cur.toUpperCase());
    if (!line) return BAD('you have no trust line for that currency with that issuer');
    return SAFE(
      { TransactionType: 'TrustSet', Account: account, LimitAmount: { currency: line.currency, issuer: peer, value: line.limit }, Flags: enable ? TF_CLEAR_NO_RIPPLE : TF_SET_NO_RIPPLE },
      enable ? 'Allow rippling on this trust line' : 'Block rippling on this trust line (NoRipple)'
    );
  },

  // ── On-Chain Identity ──────────────────────────────────────────────────────
  identity: (account, p) => {
    const r = domainAndEmail(p);
    if ('need' in r) return NEED(r.need);
    if (!r.ok) return BAD(r.error);
    return SAFE({ TransactionType: 'AccountSet', Account: account, ...r.fields }, 'Set On-Chain Identity (Domain + email hash)');
  },

  // ── Compliance Bundle: identity + domain + DID ─────────────────────────────
  compliance: (account, p) => {
    const r = domainAndEmail(p);
    if ('need' in r) return NEED(r.need);
    if (!r.ok) return BAD(r.error);
    const didUri = str(p.didUri || p.uri);
    if (!didUri) return NEED(['didUri']);
    if (Buffer.byteLength(didUri, 'utf8') > 256) return BAD('the DID document URI must be 256 bytes or fewer');
    return SAFE_STEPS([
      { id: 'identity', label: 'Set your domain + email hash', txjson: { TransactionType: 'AccountSet', Account: account, ...r.fields } },
      { id: 'did', label: 'Create your DID', txjson: { TransactionType: 'DIDSet', Account: account, URI: hexOf(didUri) } },
    ], 'Compliance Bundle (identity + domain + DID)');
  },

  // ── Trust Line + Send Currency ─────────────────────────────────────────────
  // Two transactions from YOUR account: (1) TrustSet so you can hold the token, (2) a Payment
  // of that token to the destination. Step 2 needs you to already hold enough of the token, so
  // it is checked against the ledger right before it is built.
  trustsend: async (account, p, ctx) => {
    const issuer = str(p.issuer);
    const cur = currencyCode(str(p.currency));
    const dest = str(p.destination);
    const amount = str(p.amount);
    const limit = str(p.limit) || '1000000000';
    if (!issuer || !str(p.currency) || !dest || !amount) return NEED(['issuer', 'currency', 'destination', 'amount']);
    if (!isAddr(issuer) || !isAddr(dest)) return BAD('invalid issuer or destination address');
    if (!cur || cur === 'XRP') return BAD('currency must be an issued currency code, not XRP');
    if (!positiveDecimal(amount) || !positiveDecimal(limit)) return BAD('amount and limit must be positive numbers');
    if (Number(limit) < Number(amount)) return BAD('your trust limit must be at least the amount you want to send');

    if (ctx?.step === 2) {
      const mine = await getLines(account, issuer);
      if (mine) {
        const l = mine.find((x) => x.currency.toUpperCase() === cur.toUpperCase());
        if (!l || Number(l.balance) < Number(amount))
          return BAD(`you hold ${l ? l.balance : '0'} of that currency but are sending ${amount}. Get the tokens into your wallet first, then continue — your trust line from step 1 is already set.`);
      }
      if (dest !== issuer) {
        const theirs = await getLines(dest, issuer);
        if (theirs && !theirs.some((x) => x.currency.toUpperCase() === cur.toUpperCase() && Number(x.limit) > 0))
          return BAD('the destination has no trust line for that currency with that issuer, so it cannot receive it');
      }
    }
    return SAFE_STEPS([
      { id: 'trustset', label: 'Set your trust line', txjson: { TransactionType: 'TrustSet', Account: account, LimitAmount: { currency: cur, issuer, value: limit } } },
      { id: 'payment', label: `Send ${amount} to the destination`, txjson: { TransactionType: 'Payment', Account: account, Destination: dest, Amount: { currency: cur, issuer, value: amount } } },
    ], 'Trust Line + Send Currency (2 steps)');
  },

  // ── Deposit Preauthorization (DepositPreauth) ──────────────────────────────
  // With Deposit Authorization on (the Deposit Auth Guard service), an account rejects payments
  // from everyone EXCEPT accounts it has preauthorized. This creates (or removes) one such
  // preauthorization. Each entry counts toward the owner reserve (0.2 XRP).
  depositpreauth: async (account, p) => {
    const sender = str(p.sender);
    if (!sender) return NEED(['sender']);
    if (!isAddr(sender)) return BAD('invalid sender address');
    if (sender === account) return BAD('you cannot preauthorize your own account');
    const remove = ['remove', 'unauthorize', 'revoke'].includes(str(p.action).toLowerCase());

    if (!remove) {
      const target = await getAccount(sender);
      if (target && !target.found) return BAD('that sender account is not activated on XRPL mainnet, so it cannot be preauthorized yet');
    }
    const mine = await getAccount(account);
    const authOn = mine ? (mine.flags & LSF.DEPOSIT_AUTH) !== 0 : null;
    const label = remove
      ? 'Revoke a deposit preauthorization'
      : authOn === false
        ? 'Preauthorize a sender (Deposit Auth is not on yet — it takes effect once you enable it)'
        : 'Preauthorize a sender for Deposit Auth';
    return SAFE({ TransactionType: 'DepositPreauth', Account: account, [remove ? 'Unauthorize' : 'Authorize']: sender }, label);
  },

  // ── Permission Delegation (XLS-75) ─────────────────────────────────────────
  // DelegateSet granting `delegate` the right to sign the chosen transaction types for this account. Amendment-gated
  // (PermissionDelegationV1_1, fail closed — see serviceAmendments.ts). Revoking is free and separate:
  // POST /api/delegate/revoke. Rules + per-permission copy: src/lib/delegation.ts.
  delegate: async (account, p) => {
    const avail = await serviceAvailability('delegate');
    if (!avail.available) return BAD(avail.message ?? 'Permission delegation is not available yet.');

    const delegate = str(p.delegate);
    if (!delegate) return NEED(['delegate', 'permissions']);
    if (!isAddr(delegate)) return BAD('the delegate must be a valid XRPL address (r…) whose checksum verifies');
    if (delegate === account) return BAD('the delegate must be a different account from yours');
    const perms = parsePermissions(p.permissions);
    if (!perms.ok) return str(p.permissions) ? BAD(perms.error) : NEED(['permissions']);

    // Read before building: the ledger refuses a delegate that doesn't exist (tecNO_TARGET) after you've paid, and an
    // existing grant to the same account is REPLACED, not merged — the label says which.
    const [me, them, existing] = await Promise.all([getAccount(account), getAccount(delegate), getDelegate(account, delegate)]);
    if (!me || !them || existing === null) return BAD(LEDGER_UNREACHABLE);
    if (!me.found) return BAD('your account is not activated on the XRP Ledger');
    if (!them.found) return BAD('the delegate account does not exist on the XRP Ledger yet — it must be activated (funded) before you can delegate to it');

    const built = buildDelegateGrant(account, delegate, perms.values);
    if (!built.ok) return BAD(built.error);
    const before = existing ? grantedPermissions(existing) : [];
    const label = existing
      ? `Replace delegate permissions (${before.length} → ${perms.values.length})`
      : `Grant delegate ${perms.values.length} permission${perms.values.length === 1 ? '' : 's'}`;
    return CAUTION(built.txjson, label);
  },
};
