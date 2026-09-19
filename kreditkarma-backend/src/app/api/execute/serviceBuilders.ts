// src/app/api/execute/serviceBuilders.ts
// The storefront services that were rebuilt to match what they advertise. Each one
// follows the XRPL reference for the transaction it builds (AccountSet, AMMDeposit,
// Payment + ripple_path_find, TrustSet, SignerListSet…), and where correctness depends
// on live ledger state (existing trust-line limit, whether an AMM exists, a real
// payment path, an existing regular key) it READS that state instead of guessing.
//
// Multi-step services return `steps`, signed in order; the plan (step ids) is fixed at
// step 1 and later steps are built by id (ctx.planIds).

import { createHash } from 'crypto';
import { LSF, ammExists, findPaths, getAccount, getLines } from '@/lib/serviceChain';
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
const TF_SINGLE_ASSET = 0x00080000; // AMMDeposit
const TF_TWO_ASSET = 0x00100000; // AMMDeposit

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

  // ── AMM Liquidity Entry ────────────────────────────────────────────────────
  // AMMDeposit REQUIRES Asset and Asset2 (they identify the pool). Two amounts => tfTwoAsset;
  // one amount => tfSingleAsset.
  ammentry: async (account, p) => {
    const aVal = str(p.assetValue);
    const bVal = str(p.asset2Value);
    if (!aVal) return NEED(['assetValue']);
    if (!str(p.asset2Currency)) return NEED(['asset2Currency']);
    const a = assetFrom(str(p.assetCurrency) || 'XRP', str(p.assetIssuer));
    if (!a.ok) return BAD(a.error);
    const b = assetFrom(str(p.asset2Currency), str(p.asset2Issuer));
    if (!b.ok) return BAD(b.error);
    if (a.asset.currency === b.asset.currency && a.asset.issuer === b.asset.issuer) return BAD('the two pool assets must be different');
    if (!positiveDecimal(aVal) || (bVal && !positiveDecimal(bVal))) return BAD('amounts must be positive numbers');

    const tx: Record<string, unknown> = { TransactionType: 'AMMDeposit', Account: account, Asset: a.asset, Asset2: b.asset };
    if (bVal) {
      tx.Amount = amountOf(a.asset, aVal);
      tx.Amount2 = amountOf(b.asset, bVal);
      tx.Flags = TF_TWO_ASSET;
    } else {
      tx.Amount = amountOf(a.asset, aVal);
      tx.Flags = TF_SINGLE_ASSET;
    }
    const exists = await ammExists(a.asset, b.asset);
    if (exists === false) return BAD('there is no AMM pool for that pair — use AMM Pool Launch to create one first');
    return SAFE(tx, bVal ? 'AMM Liquidity Deposit (two assets)' : 'AMM Liquidity Deposit (single asset)');
  },

  // ── Smart Swap Router ──────────────────────────────────────────────────────
  // A cross-currency Payment. We ask the ledger's own pathfinder (ripple_path_find) for a
  // route that delivers EXACTLY the amount you want, then use its computed Paths (which span
  // order books and AMM pools) and cap what you can be charged with SendMax = quote + slippage.
  // No tfPartialPayment: it either delivers the full amount within the cap or fails.
  smartswap: async (account, p) => {
    const recvVal = str(p.receiveValue);
    if (!recvVal) return NEED(['receiveValue']);
    if (!str(p.receiveCurrency)) return NEED(['receiveCurrency']);
    const send = assetFrom(str(p.sendCurrency) || 'XRP', str(p.sendIssuer));
    if (!send.ok) return BAD(send.error);
    const recv = assetFrom(str(p.receiveCurrency), str(p.receiveIssuer));
    if (!recv.ok) return BAD(recv.error);
    if (send.asset.currency === recv.asset.currency && send.asset.issuer === recv.asset.issuer) return BAD('the currency you send and the currency you receive are the same');
    if (!positiveDecimal(recvVal)) return BAD('the amount to receive must be a positive number');
    const slip = str(p.slippagePct) === '' ? 1 : Number(p.slippagePct);
    if (!Number.isFinite(slip) || slip <= 0 || slip > 10) return BAD('slippage must be more than 0% and at most 10%');
    const dest = str(p.destination) || account;
    if (!isAddr(dest)) return BAD('invalid destination address');

    const destAmount = amountOf(recv.asset, recvVal) as string | { currency: string; issuer: string; value: string };
    const alts = await findPaths({ source: account, destination: dest, destinationAmount: destAmount, sourceCurrency: send.asset });
    if (!alts) return BAD('could not compute a route right now — the ledger path-finder is unavailable, try again shortly');

    const priced = alts
      .map((alt) => ({ alt, n: typeof alt.source_amount === 'string' ? Number(alt.source_amount) : Number(alt.source_amount.value) }))
      .filter((x) => Number.isFinite(x.n) && x.n > 0);
    if (priced.length === 0) return BAD('no route with enough liquidity was found for that swap (it may need a trust line, or the pools/order books are too thin)');
    const best = priced.reduce((m, x) => (x.n < m.n ? x : m));

    const src = best.alt.source_amount;
    const sendMax = typeof src === 'string'
      ? String(Math.ceil(Number(src) * (1 + slip / 100)))
      : { currency: src.currency, issuer: src.issuer ?? account, value: iouValue(best.n * (1 + slip / 100)) };
    const tx: Record<string, unknown> = { TransactionType: 'Payment', Account: account, Destination: dest, Amount: destAmount, SendMax: sendMax };
    if (best.alt.paths_computed.length > 0) tx.Paths = best.alt.paths_computed;
    return SAFE(tx, `Smart Swap (route found; you pay at most ${slip}% over the current quote)`);
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
};
