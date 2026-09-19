// src/app/api/execute/txBuilder.ts
// The autonomous execution brain. Maps each productId to the exact XRPL
// transaction the CUSTOMER signs in Xaman to receive their service.
//
// SAFETY TIERS:
//   'safe'      → additive or reversible; auto-builds, no special warning
//   'caution'   → can misconfigure account access; sellable but UI must show a hard warning gate
//   'blocked'   → irreversible account-killers; never auto-built (returns error)
//
// Every builder returns a txjson object for the customer's own wallet.
// Params come from the customer (validated here). Never trust raw input.

import { buildMptFlagsValue, flagSelectionFromParams } from '@/lib/mptFlags';
import { normalizeBacking, validateBacking, type BackingDeclaration } from '@/lib/mptBacking';
import { buildMptMetadata } from '@/lib/mptMeta';
import { parseMptLocks, type BuildContext } from '@/lib/mptPermanence';

export type { SafetyTier, BuildResult, BuildStep } from './buildKit';
import {
  BAD, BLOCKED, CAUTION, NEED, SAFE, isAddr, str, xrpToDrops,
  type Builder, type BuildResult, type BuildStep, type Params,
} from './buildKit';
import { richBuilders } from './serviceBuilders';

// ── Per-product builders ──────────────────────────────────────────────
// account = the customer's own wallet (the signer). A builder may be async (it can read the
// ledger) and may return several steps. The services in serviceBuilders.ts (multisig,
// issuerdecl, issuercfg, rippling, identity, compliance, ammentry, smartswap, trustsend)
// replace the older single-transaction versions that used to live here.
const builders: Record<string, Builder> = {
  ...richBuilders,

  // ── WALLET SECURITY ───────────────────────────────────────────────
  regkey: (account, p) => {
    // SetRegularKey — caution: master key still works unless later disabled
    const key = str(p.regularKey);
    if (!key || !isAddr(key)) return NEED(['regularKey']);
    return CAUTION({ TransactionType: 'SetRegularKey', Account: account, RegularKey: key }, 'Set Regular Key');
  },
  depositauth: (account) => SAFE({ TransactionType: 'AccountSet', Account: account, SetFlag: 9 }, 'Enable Deposit Auth'), // asfDepositAuth
  desttag: (account) => SAFE({ TransactionType: 'AccountSet', Account: account, SetFlag: 1 }, 'Require Destination Tag'), // asfRequireDest
  lockdown: () => BLOCKED('XRP Lockdown disables the master key and can permanently lock you out of your account. For your protection, this cannot be auto-executed. Contact support@xrplhub.io for a guided, manual process.'),

  // ── TOKEN ISSUER ──────────────────────────────────────────────────
  tokenfee: (account, p) => {
    const fee = Number(p.transferFee); // 0..1000000000 (0%..100% as billionths over 1e9 base); UI passes percent
    if (p.transferFee === undefined) return NEED(['transferFee']);
    // percent → TransferRate: 1.0 + pct/100, expressed as integer billionths
    const rate = Math.round((1 + Number(fee) / 100) * 1_000_000_000);
    if (rate < 1_000_000_000 || rate > 2_000_000_000) return BAD('transfer fee must be between 0% and 100%');
    return SAFE({ TransactionType: 'AccountSet', Account: account, TransferRate: rate }, 'Set Transfer Fee');
  },
  trustline: (account, p) => {
    const issuer = str(p.issuer), currency = str(p.currency), limit = str(p.limit || '1000000000');
    if (!issuer || !currency) return NEED(['issuer', 'currency']);
    if (!isAddr(issuer)) return BAD('invalid issuer address');
    return SAFE({ TransactionType: 'TrustSet', Account: account, LimitAmount: { currency, issuer, value: limit } }, 'Set Trust Line');
  },
  mptissue: (account, p, ctx) => {
    // Full MPTokenIssuanceCreate builder. Choices here are hard or impossible to
    // undo (which ones depends on the live DynamicMPT amendment state — see
    // src/lib/mptPermanence.ts) so this is `caution` tier — the execute route
    // forces a confirmation manifest before signing. See src/lib/mptFlags.ts,
    // src/lib/mptBacking.ts, src/lib/mptMeta.ts.
    const name = str(p.name);
    const ticker = str(p.ticker);
    const max = str(p.maximumAmount);
    if (!name || !ticker || !max) return NEED(['name', 'ticker', 'maximumAmount']);
    if (name.length > 64) return BAD('name must be 64 characters or fewer');
    if (ticker.length > 6 || !/^[A-Za-z0-9]+$/.test(ticker)) return BAD('ticker must be 1–6 letters or digits');

    let maxBig: bigint;
    try {
      maxBig = BigInt(max);
    } catch {
      return BAD('maximum supply must be a whole number');
    }
    const MAX_MPT_SUPPLY = BigInt('9223372036854775807'); // 0x7FFF_FFFF_FFFF_FFFF
    if (maxBig <= BigInt(0) || maxBig > MAX_MPT_SUPPLY) return BAD('maximum supply must be between 1 and 9223372036854775807');

    const scale = Number(p.assetScale ?? 0);
    if (!Number.isInteger(scale) || scale < 0 || scale > 19) return BAD('decimal places (assetScale) must be a whole number 0–19');

    const sel = flagSelectionFromParams(p as Record<string, unknown>);
    const flags = buildMptFlagsValue(sel);

    // TransferFee is only valid with tfMPTCanTransfer (else temMALFORMED on-ledger).
    let transferFee: number | undefined;
    if (p.transferFee !== undefined && p.transferFee !== '' && Number(p.transferFee) > 0) {
      if (!sel.canTransfer) return BAD('a transfer fee requires "holders can transfer" to be enabled');
      const pct = Number(p.transferFee);
      if (!Number.isFinite(pct) || pct < 0 || pct > 50) return BAD('transfer fee must be between 0% and 50%');
      transferFee = Math.round(pct * 1000); // percent -> tenths of a basis point
    }

    const backing = normalizeBacking({
      backingType: str(p.backingType) as BackingDeclaration['backingType'],
      backingStatement: str(p.backingStatement) ?? '',
      verifiedBy: str(p.verifiedBy),
      redeemable: str(p.redeemable) as BackingDeclaration['redeemable'],
    });
    const bErr = validateBacking(backing);
    if (bErr) return BAD(bErr);

    const weblink = str(p.metadataUrl) || undefined;
    if (weblink && !/^https?:\/\/.+/i.test(weblink)) return BAD('metadata URL must start with http:// or https://');

    const md = buildMptMetadata({ name, ticker: ticker.toUpperCase(), weblink, backing });
    if (md.bytes > 1024) return BAD('metadata is too large (>1024 bytes) — shorten the name or the backing statement');

    const txjson: Record<string, unknown> = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: account,
      MaximumAmount: maxBig.toString(),
      AssetScale: scale,
      Flags: flags,
      MPTokenMetadata: md.hex,
    };
    if (transferFee !== undefined) txjson.TransferFee = transferFee;

    // ImmutableFlags (XLS-94 locks). Only ever added when DynamicMPT is confirmed
    // ACTIVE in ctx — otherwise the ledger rejects the field (temDISABLED) after
    // the customer has paid — and never as 0 (temINVALID_FLAG).
    const locks = parseMptLocks(p as Record<string, unknown>, ctx);
    if (!locks.ok) return BAD(locks.error);
    if (locks.value) txjson.ImmutableFlags = locks.value;

    return CAUTION(txjson, 'Multi-Purpose Token Issuance');
  },
  mptsend: (account, p) => {
    const dest = str(p.destination), issuanceId = str(p.mptIssuanceId), amount = str(p.amount);
    if (!dest || !issuanceId || !amount) return NEED(['destination', 'mptIssuanceId', 'amount']);
    if (!isAddr(dest)) return BAD('invalid destination address');
    return SAFE({ TransactionType: 'Payment', Account: account, Destination: dest, Amount: { mpt_issuance_id: issuanceId, value: amount } }, 'Send MPT');
  },
  globalfreeze: (account) => SAFE({ TransactionType: 'AccountSet', Account: account, SetFlag: 7 }, 'Global Freeze (asfGlobalFreeze)'), // asfGlobalFreeze=7
  freezeline: (account, p) => {
    const issuer = str(p.holder), currency = str(p.currency);
    if (!issuer || !currency) return NEED(['holder', 'currency']);
    if (!isAddr(issuer)) return BAD('invalid holder address');
    return SAFE({ TransactionType: 'TrustSet', Account: account, LimitAmount: { currency, issuer, value: '0' }, Flags: 0x00100000 }, 'Freeze Trust Line (tfSetFreeze)');
  },

  // ── DEFI ──────────────────────────────────────────────────────────
  dexorder: (account, p) => {
    const getsCur = str(p.takerGetsCurrency), getsVal = str(p.takerGetsValue), getsIss = str(p.takerGetsIssuer);
    const paysCur = str(p.takerPaysCurrency), paysVal = str(p.takerPaysValue), paysIss = str(p.takerPaysIssuer);
    if (!getsVal || !paysVal) return NEED(['takerGetsValue', 'takerPaysValue']);
    const gets = getsCur === 'XRP' || !getsCur ? xrpToDrops(Number(getsVal)) : { currency: getsCur, issuer: getsIss, value: getsVal };
    const pays = paysCur === 'XRP' || !paysCur ? xrpToDrops(Number(paysVal)) : { currency: paysCur, issuer: paysIss, value: paysVal };
    return SAFE({ TransactionType: 'OfferCreate', Account: account, TakerGets: gets, TakerPays: pays }, 'DEX Order (OfferCreate)');
  },
  dextrade: (account, p) => builders.dexorder(account, p),
  ammlaunch: (account, p) => {
    const aCur = str(p.assetCurrency), aVal = str(p.assetValue), aIss = str(p.assetIssuer);
    const bCur = str(p.asset2Currency), bVal = str(p.asset2Value), bIss = str(p.asset2Issuer);
    if (!aVal || !bVal) return NEED(['assetValue', 'asset2Value']);
    const a = aCur === 'XRP' || !aCur ? xrpToDrops(Number(aVal)) : { currency: aCur, issuer: aIss, value: aVal };
    const b = bCur === 'XRP' || !bCur ? xrpToDrops(Number(bVal)) : { currency: bCur, issuer: bIss, value: bVal };
    return SAFE({ TransactionType: 'AMMCreate', Account: account, Amount: a, Amount2: b, TradingFee: Number(p.tradingFee || 500) }, 'Create AMM Pool');
  },
  paychannel: (account, p) => {
    const dest = str(p.destination), amount = str(p.amount), pubkey = str(p.publicKey);
    if (!dest || !amount || !pubkey) return NEED(['destination', 'amount', 'publicKey']);
    if (!isAddr(dest)) return BAD('invalid destination address');
    return SAFE({ TransactionType: 'PaymentChannelCreate', Account: account, Destination: dest, Amount: xrpToDrops(Number(amount)), SettleDelay: Number(p.settleDelay || 86400), PublicKey: pubkey }, 'Create Payment Channel');
  },
  tickets: (account, p) => {
    const count = Number(p.ticketCount || 1);
    if (count < 1 || count > 250) return BAD('ticket count must be 1–250');
    return SAFE({ TransactionType: 'TicketCreate', Account: account, TicketCount: count }, 'Create Tickets');
  },

  // ── NFT ───────────────────────────────────────────────────────────
  nftmint: (account, p) => {
    const uri = str(p.uri);
    const royalty = Number(p.royalty || 0); // percent
    if (!uri) return NEED(['uri']);
    const transferFee = Math.round(royalty * 1000); // percent → 0..50000 (XRPL NFT fee is in 1/100,000)
    if (transferFee < 0 || transferFee > 50000) return BAD('royalty must be 0–50%');
    const uriHex = Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
    return SAFE({ TransactionType: 'NFTokenMint', Account: account, URI: uriHex, NFTokenTaxon: Number(p.taxon || 0), TransferFee: transferFee, Flags: 8 }, 'Mint NFT'); // tfTransferable
  },
  nftburn: (account, p) => {
    const id = str(p.nftokenId);
    if (!id) return NEED(['nftokenId']);
    return SAFE({ TransactionType: 'NFTokenBurn', Account: account, NFTokenID: id }, 'Burn NFT');
  },
  nftoffer: (account, p) => {
    const id = str(p.nftokenId), amount = str(p.amount);
    if (!id || !amount) return NEED(['nftokenId', 'amount']);
    return SAFE({ TransactionType: 'NFTokenCreateOffer', Account: account, NFTokenID: id, Amount: xrpToDrops(Number(amount)), Flags: 1 }, 'Create NFT Sell Offer'); // tfSellNFToken
  },

  // ── PAYMENTS ──────────────────────────────────────────────────────
  checkcreate: (account, p) => {
    const dest = str(p.destination), amount = str(p.amount);
    if (!dest || !amount) return NEED(['destination', 'amount']);
    if (!isAddr(dest)) return BAD('invalid destination address');
    return SAFE({ TransactionType: 'CheckCreate', Account: account, Destination: dest, SendMax: xrpToDrops(Number(amount)) }, 'Create Check');
  },
  checkcash: (account, p) => {
    const checkId = str(p.checkId), amount = str(p.amount);
    if (!checkId || !amount) return NEED(['checkId', 'amount']);
    return SAFE({ TransactionType: 'CheckCash', Account: account, CheckID: checkId, Amount: xrpToDrops(Number(amount)) }, 'Cash Check');
  },
  checkcancel: (account, p) => {
    const checkId = str(p.checkId);
    if (!checkId) return NEED(['checkId']);
    return SAFE({ TransactionType: 'CheckCancel', Account: account, CheckID: checkId }, 'Cancel Check');
  },
  desttagreq: (account) => SAFE({ TransactionType: 'AccountSet', Account: account, SetFlag: 1 }, 'Require Destination Tags'),
  escrow: (account, p) => {
    const dest = str(p.destination), amount = str(p.amount), finishAfter = Number(p.finishAfter);
    if (!dest || !amount || !finishAfter) return NEED(['destination', 'amount', 'finishAfter']);
    if (!isAddr(dest)) return BAD('invalid destination address');
    return SAFE({ TransactionType: 'EscrowCreate', Account: account, Destination: dest, Amount: xrpToDrops(Number(amount)), FinishAfter: finishAfter }, 'Create Escrow');
  },

  // ── IDENTITY / COMPLIANCE ─────────────────────────────────────────
  did: (account, p) => {
    const uri = str(p.uri);
    if (!uri) return NEED(['uri']);
    const hex = Buffer.from(uri, 'utf8').toString('hex').toUpperCase();
    return SAFE({ TransactionType: 'DIDSet', Account: account, URI: hex }, 'Create / Update DID');
  },
  credentialissue: (account, p) => {
    const subject = str(p.subject), credType = str(p.credentialType);
    if (!subject || !credType) return NEED(['subject', 'credentialType']);
    if (!isAddr(subject)) return BAD('invalid subject address');
    const typeHex = Buffer.from(credType, 'utf8').toString('hex').toUpperCase();
    return SAFE({ TransactionType: 'CredentialCreate', Account: account, Subject: subject, CredentialType: typeHex }, 'Issue Credential');
  },
  permdomain: (account, p) => {
    const credType = str(p.credentialType), issuer = str(p.acceptedIssuer || account);
    if (!credType) return NEED(['credentialType']);
    const typeHex = Buffer.from(credType, 'utf8').toString('hex').toUpperCase();
    return SAFE({ TransactionType: 'PermissionedDomainSet', Account: account, AcceptedCredentials: [{ Credential: { Issuer: issuer, CredentialType: typeHex } }] }, 'Set Permissioned Domain');
  },
};

/**
 * `ctx` carries live amendment states for builders that depend on them (today only
 * mptissue, via mptBuildContext()), and — for multi-step services — the plan fixed at
 * step 1 (planIds) and the step being built (step). Omitted = "unknown": builders then
 * never emit anything that needs an amendment to be active.
 *
 * Always resolves to a BuildResult with `steps` set on success (single-step services get
 * one step with id "main"); `txjson` is the first step's, for callers that only handle one.
 */
export async function buildServiceTx(productId: string, account: string, params: Params, ctx?: import('@/lib/mptPermanence').BuildContext): Promise<BuildResult> {
  if (!isAddr(account)) return BAD('invalid signer wallet address');
  const b = builders[productId];
  if (!b) return BAD(`product "${productId}" has no execution builder yet`);
  const r = await b(account, params, ctx);
  if (!r.ok) return r;
  const steps: BuildStep[] = r.steps ?? [{ id: 'main', label: r.label ?? productId, txjson: r.txjson as Record<string, unknown> }];
  return { ...r, steps, txjson: steps[0].txjson };
}
