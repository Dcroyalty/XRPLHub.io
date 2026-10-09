// src/lib/walletPermissions.ts
// WALLET PERMISSIONS CHECK (2026-10-09) — "who can move money out of this wallet?", read straight from the ledger and
// explained in plain words. The XRPL counterpart of revoke.cash (docs/HUB-GAPS.md #1).
//
// What it reads (one account_info with signer lists + one page of account_objects):
//   - SIGNING POWER: master key on/off, a regular key, a signer list (multi-sign), and the "nobody can ever sign" case.
//   - DELEGATIONS (PermissionDelegation, live on mainnet since 2026-10-08): accounts this wallet lets send transactions
//     for it — and accounts that let THIS wallet act for them. Revoking = DelegateSet with an empty Permissions list.
//   - MONEY OTHERS CAN PULL without a new approval: checks this wallet wrote, payment channels it funds, escrows it
//     created, open DEX offers, NFT sell offers, and tickets (transactions signed earlier can still use them).
//
// No local imports (only types), so scripts/test-permissions-testnet.ts runs this exact file against XRPL Testnet.
// Read-only. The only actions it suggests are free transactions the owner signs: revoke a delegation, cancel a check.

export type Rpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export type Level = "danger" | "warning" | "info" | "ok";

export interface Finding {
  kind: "master_key" | "regular_key" | "signer_list" | "blackholed" | "delegation_given" | "delegation_received" | "check" | "payment_channel" | "escrow" | "dex_offer" | "nft_offer" | "tickets" | "deposit_preauth";
  level: Level;
  /** Who holds the power (an r-address), when there is one. */
  who: string | null;
  /** One plain-English sentence. */
  plain: string;
  /** Raw facts for developers. */
  detail: Record<string, unknown>;
  /** A free fix the owner can sign, when there is one. */
  fix?: { action: "revoke_delegation" | "cancel_check"; params: Record<string, string> };
}

export interface PermissionsReport {
  address: string;
  ledgerIndex: number | null;
  checkedAt: string;
  exists: boolean;
  /** One sentence for the top of the page. */
  headline: string;
  /** Other parties that can move money out of this wallet without the owner approving it again. */
  canMoveMoney: { who: string; how: string }[];
  findings: Finding[];
  /** account_objects returned more than one page: some objects were not read. */
  truncated: boolean;
  notes: string[];
}

const LSF_DISABLE_MASTER = 0x00100000;
const RIPPLE_EPOCH = 946_684_800;

// Granular permissions (xrpl.org Permission Values; values 65537–65548).
const GRANULAR: Record<number, [string, string, Level]> = {
  65537: ["TrustlineAuthorize", "approve who may hold this wallet's tokens", "warning"],
  65538: ["TrustlineFreeze", "freeze individual holders of this wallet's tokens", "warning"],
  65539: ["TrustlineUnfreeze", "unfreeze holders of this wallet's tokens", "warning"],
  65540: ["AccountDomainSet", "change this wallet's website (Domain) setting", "info"],
  65541: ["AccountEmailHashSet", "change this wallet's email-hash setting", "info"],
  65542: ["AccountMessageKeySet", "change this wallet's message key", "info"],
  65543: ["AccountTransferRateSet", "change the transfer fee on this wallet's tokens", "warning"],
  65544: ["AccountTickSizeSet", "change the tick size of this wallet's tokens", "info"],
  65545: ["PaymentMint", "send payments that create new tokens issued by this wallet", "danger"],
  65546: ["PaymentBurn", "send payments that destroy tokens issued by this wallet", "danger"],
  65547: ["MPTokenIssuanceLock", "lock balances of a token issued by this wallet", "warning"],
  65548: ["MPTokenIssuanceUnlock", "unlock balances of a token issued by this wallet", "warning"],
};
const GRANULAR_BY_NAME = Object.fromEntries(Object.entries(GRANULAR).map(([v, g]) => [g[0], Number(v)]));

// Transaction-type permissions that matter most, in plain words. Anything else is named by its type.
const TX_PLAIN: Record<string, [string, Level]> = {
  Payment: ["send payments from this wallet — any amount, to anyone", "danger"],
  CheckCreate: ["write checks from this wallet that others can cash", "danger"],
  CheckCash: ["cash checks written to this wallet", "warning"],
  EscrowCreate: ["lock this wallet's money in escrows", "danger"],
  EscrowFinish: ["release escrows", "warning"],
  PaymentChannelCreate: ["fund payment channels from this wallet", "danger"],
  PaymentChannelFund: ["add money to this wallet's payment channels", "danger"],
  OfferCreate: ["trade this wallet's money on the exchange", "danger"],
  AMMDeposit: ["put this wallet's money into liquidity pools", "danger"],
  AMMWithdraw: ["take money out of this wallet's liquidity pools", "warning"],
  NFTokenCreateOffer: ["offer this wallet's NFTs for sale", "danger"],
  NFTokenAcceptOffer: ["accept NFT offers for this wallet", "danger"],
  TrustSet: ["add or change token trust lines", "warning"],
  Clawback: ["take back tokens this wallet issued from holders", "danger"],
  MPTokenAuthorize: ["opt this wallet in or out of tokens", "info"],
  CredentialCreate: ["issue credentials in this wallet's name", "warning"],
  CredentialAccept: ["accept credentials for this wallet", "info"],
  DepositPreauth: ["change who may pay this wallet", "warning"],
  TicketCreate: ["create tickets for this wallet", "info"],
  OracleSet: ["publish price data in this wallet's name", "warning"],
};
// Transaction type codes (rippled TxFormats) for decoding numeric PermissionValues (value = type code + 1).
const TX_CODES: Record<number, string> = {
  0: "Payment", 1: "EscrowCreate", 2: "EscrowFinish", 3: "AccountSet", 4: "EscrowCancel", 5: "SetRegularKey", 7: "OfferCreate",
  8: "OfferCancel", 10: "TicketCreate", 12: "SignerListSet", 13: "PaymentChannelCreate", 14: "PaymentChannelFund",
  15: "PaymentChannelClaim", 16: "CheckCreate", 17: "CheckCash", 18: "CheckCancel", 19: "DepositPreauth", 20: "TrustSet",
  21: "AccountDelete", 25: "NFTokenMint", 26: "NFTokenBurn", 27: "NFTokenCreateOffer", 28: "NFTokenCancelOffer",
  29: "NFTokenAcceptOffer", 30: "Clawback", 31: "AMMClawback", 35: "AMMCreate", 36: "AMMDeposit", 37: "AMMWithdraw", 38: "AMMVote",
  39: "AMMBid", 40: "AMMDelete", 51: "OracleSet", 52: "OracleDelete", 54: "MPTokenIssuanceCreate", 55: "MPTokenIssuanceDestroy",
  56: "MPTokenIssuanceSet", 57: "MPTokenAuthorize", 58: "CredentialCreate", 59: "CredentialAccept", 60: "CredentialDelete",
  62: "PermissionedDomainSet", 63: "PermissionedDomainDelete", 64: "DelegateSet",
};

/** One delegated permission → { name, plain, level }. Accepts the JSON name rippled returns or the numeric value. */
export function describePermission(raw: unknown): { name: string; plain: string; level: Level } {
  const v = typeof raw === "number" ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : null;
  const name = v === null ? String(raw) : v > 65536 ? (GRANULAR[v]?.[0] ?? `Permission #${v}`) : (TX_CODES[v - 1] ?? `Transaction type #${v - 1}`);
  const g = GRANULAR[GRANULAR_BY_NAME[name] ?? -1];
  if (g) return { name, plain: g[1], level: g[2] };
  const t = TX_PLAIN[name];
  if (t) return { name, plain: t[0], level: t[1] };
  return { name, plain: `send ${name} transactions for this wallet`, level: "warning" };
}

const worst = (ls: Level[]): Level => (ls.includes("danger") ? "danger" : ls.includes("warning") ? "warning" : ls.includes("info") ? "info" : "ok");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function amountText(a: unknown): string {
  if (typeof a === "string") return `${Number(a) / 1e6} XRP`;
  const o = a as { value?: string; currency?: string } | null;
  if (!o?.currency) return "an amount";
  const cur = o.currency.length === 40 ? (Buffer.from(o.currency, "hex").toString("utf8").replace(/\0+$/, "") || o.currency.slice(0, 8)) : o.currency;
  return `${o.value} ${cur}`;
}
const rippleDate = (s: unknown) => (typeof s === "number" ? new Date((s + RIPPLE_EPOCH) * 1000).toISOString() : null);

/** Read the ledger and explain who can move money out of `address`. Throws only if the ledger can't be read. */
export async function checkWalletPermissions(rpc: Rpc, address: string, now = new Date()): Promise<PermissionsReport> {
  const info = await rpc("account_info", { account: address, ledger_index: "validated", signer_lists: true });
  if (!info) throw new Error("could not read the XRP Ledger");
  const base: PermissionsReport = { address, ledgerIndex: Number(info.ledger_index ?? 0) || null, checkedAt: now.toISOString(), exists: true, headline: "", canMoveMoney: [], findings: [], truncated: false, notes: [] };
  if (info.error === "actNotFound") return { ...base, exists: false, headline: "This wallet doesn't exist on the XRP Ledger yet, so nobody can move money out of it." };
  if (info.error) throw new Error(`ledger error: ${String(info.error)}`);

  const ad = info.account_data as { Flags?: number; RegularKey?: string; signer_lists?: unknown[] };
  const signerLists = ((info.signer_lists ?? ad.signer_lists) as { SignerQuorum?: number; SignerEntries?: { SignerEntry: { Account: string; SignerWeight: number } }[] }[] | undefined) ?? [];
  const masterOff = (Number(ad.Flags ?? 0) & LSF_DISABLE_MASTER) !== 0;
  const f: Finding[] = [];
  const movers: { who: string; how: string }[] = [];

  // ── signing power ────────────────────────────────────────────────────────────────────────────────────────────────
  f.push(masterOff
    ? { kind: "master_key", level: "info", who: address, plain: "This wallet's own key (the master key) is turned off. It can't sign anything by itself.", detail: { masterKeyDisabled: true } }
    : { kind: "master_key", level: "ok", who: address, plain: "This wallet's own key can sign for it (normal).", detail: { masterKeyDisabled: false } });
  if (ad.RegularKey) {
    f.push({ kind: "regular_key", level: "warning", who: ad.RegularKey, plain: `A second key (${short(ad.RegularKey)}) can sign ANYTHING for this wallet, including sending all of its money. That's fine only if that key is yours.`, detail: { regularKey: ad.RegularKey } });
    movers.push({ who: ad.RegularKey, how: "regular key: full control" });
  }
  for (const sl of signerLists) {
    const signers = (sl.SignerEntries ?? []).map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight }));
    f.push({ kind: "signer_list", level: "warning", who: null, plain: `A group of ${signers.length} signer${signers.length === 1 ? "" : "s"} can sign anything for this wallet together (they need a combined weight of ${sl.SignerQuorum}).`, detail: { quorum: sl.SignerQuorum, signers } });
    movers.push({ who: signers.map((s) => s.account).join(", "), how: `multi-sign group: full control together (quorum ${sl.SignerQuorum})` });
  }
  if (masterOff && !ad.RegularKey && !signerLists.length) {
    f.push({ kind: "blackholed", level: "info", who: null, plain: "Nobody can sign for this wallet — not the owner, not anyone. Money in it can never be moved by a new transaction (it is \"blackholed\").", detail: { blackholed: true } });
  }

  // ── objects: delegations, pulls, offers, tickets ────────────────────────────────────────────────────────────────
  const objs = await rpc("account_objects", { account: address, ledger_index: "validated", limit: 400 });
  if (!objs || objs.error) throw new Error("could not read this wallet's ledger objects");
  base.truncated = !!objs.marker;
  type Obj = Record<string, unknown> & { LedgerEntryType: string; index: string };
  const list = (objs.account_objects as Obj[]) ?? [];
  let tickets = 0;
  for (const o of list) {
    switch (o.LedgerEntryType) {
      case "Delegate": {
        const perms = ((o.Permissions as { Permission: { PermissionValue: unknown } }[]) ?? []).map((p) => describePermission(p.Permission?.PermissionValue));
        const given = o.Account === address;
        const other = String(given ? o.Authorize : o.Account);
        const level = worst(perms.map((p) => p.level));
        const what = perms.map((p) => p.plain).join("; ");
        if (given) {
          f.push({ kind: "delegation_given", level, who: other, plain: `${short(other)} can send transactions for this wallet without asking: ${what}.`, detail: { delegate: other, permissions: perms.map((p) => p.name), objectId: o.index }, fix: { action: "revoke_delegation", params: { account: address, delegate: other } } });
          if (level === "danger") movers.push({ who: other, how: `delegation: ${perms.filter((p) => p.level === "danger").map((p) => p.name).join(", ")}` });
        } else {
          f.push({ kind: "delegation_received", level: "info", who: other, plain: `This wallet can act for ${short(other)}: ${what}.`, detail: { delegator: other, permissions: perms.map((p) => p.name), objectId: o.index } });
        }
        break;
      }
      case "Check":
        if (o.Account === address) {
          const exp = rippleDate(o.Expiration);
          f.push({ kind: "check", level: "danger", who: String(o.Destination), plain: `${short(String(o.Destination))} can cash a check from this wallet for up to ${amountText(o.SendMax)}${exp ? ` until ${exp.slice(0, 10)}` : " (it never expires)"}.`, detail: { checkId: o.index, destination: o.Destination, sendMax: o.SendMax, expiration: exp }, fix: { action: "cancel_check", params: { account: address, checkId: String(o.index) } } });
          movers.push({ who: String(o.Destination), how: `check up to ${amountText(o.SendMax)}` });
        }
        break;
      case "PayChannel":
        if (o.Account === address) {
          const left = Number(o.Amount) - Number(o.Balance ?? 0);
          f.push({ kind: "payment_channel", level: "danger", who: String(o.Destination), plain: `${short(String(o.Destination))} can claim up to ${left / 1e6} XRP from a payment channel this wallet funded (with claims this wallet signed).`, detail: { channelId: o.index, destination: o.Destination, amount: o.Amount, balance: o.Balance, expiration: rippleDate(o.Expiration), cancelAfter: rippleDate(o.CancelAfter) } });
          movers.push({ who: String(o.Destination), how: `payment channel up to ${left / 1e6} XRP` });
        }
        break;
      case "Escrow":
        if (o.Account === address) {
          f.push({ kind: "escrow", level: "warning", who: String(o.Destination), plain: `${amountText(o.Amount)} is locked in an escrow that goes to ${short(String(o.Destination))}${o.FinishAfter ? ` after ${rippleDate(o.FinishAfter)?.slice(0, 10)}` : ""}${o.Condition ? " when a secret condition is met" : ""}.`, detail: { escrowId: o.index, destination: o.Destination, amount: o.Amount, finishAfter: rippleDate(o.FinishAfter), cancelAfter: rippleDate(o.CancelAfter), condition: !!o.Condition } });
        }
        break;
      case "Offer":
        f.push({ kind: "dex_offer", level: "warning", who: null, plain: `An open exchange order: anyone can take ${amountText(o.TakerGets)} from this wallet by paying ${amountText(o.TakerPays)}.`, detail: { offerId: o.index, takerGets: o.TakerGets, takerPays: o.TakerPays, expiration: rippleDate(o.Expiration) } });
        break;
      case "NFTokenOffer":
        if (o.Owner === address && (Number(o.Flags ?? 0) & 1) === 1) {
          f.push({ kind: "nft_offer", level: "warning", who: o.Destination ? String(o.Destination) : null, plain: `${o.Destination ? short(String(o.Destination)) : "Anyone"} can buy one of this wallet's NFTs for ${amountText(o.Amount)}.`, detail: { offerId: o.index, nftokenId: o.NFTokenID, amount: o.Amount, destination: o.Destination ?? null } });
        }
        break;
      case "Ticket":
        tickets++;
        break;
      case "DepositPreauth":
        if (o.Account === address && o.Authorize) f.push({ kind: "deposit_preauth", level: "info", who: String(o.Authorize), plain: `${short(String(o.Authorize))} is pre-approved to send money TO this wallet (this can't take money out).`, detail: { authorize: o.Authorize } });
        break;
    }
  }
  if (tickets) f.push({ kind: "tickets", level: "info", who: null, plain: `This wallet has ${tickets} ticket${tickets === 1 ? "" : "s"}. A transaction signed earlier (for example an Autopay payment) can still use ${tickets === 1 ? "it" : "them"}. Each holds 0.2 XRP.`, detail: { tickets } });
  if (base.truncated) base.notes.push("This wallet has more than 400 ledger objects; only the first 400 were read.");

  const others = movers.filter((m) => m.who !== address);
  const headline = !others.length
    ? (f.some((x) => x.kind === "blackholed") ? "Nobody can move money out of this wallet — not even its owner." : "Only this wallet's own key can move its money. Nobody else can.")
    : `${others.length} other ${others.length === 1 ? "party" : "parties"} can move money out of this wallet without asking again.`;
  const order: Level[] = ["danger", "warning", "info", "ok"];
  return { ...base, headline, canMoveMoney: others, findings: f.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level)) };
}

/** The free transaction that revokes every permission given to `delegate` (only valid while the delegation exists). */
export const buildRevokeDelegation = (account: string, delegate: string) => ({ TransactionType: "DelegateSet", Account: account, Authorize: delegate, Permissions: [] as unknown[] });

export const PERMISSIONS_INPUT_SCHEMA = {
  type: "object",
  properties: { address: { type: "string", description: "The XRPL account (r...) to check" } },
  required: ["address"],
} as const;
export const PERMISSIONS_OUTPUT_SCHEMA = {
  type: "object",
  description: "Who can move money out of an XRPL wallet: signing power (master key, regular key, signer list), permission delegations given and received, and money others can pull (checks, payment channels, escrows, open offers, tickets). Plain-English sentence per finding plus raw ledger facts.",
  properties: {
    address: { type: "string" }, ledgerIndex: { type: ["integer", "null"] }, exists: { type: "boolean" }, headline: { type: "string" },
    canMoveMoney: { type: "array", items: { type: "object", properties: { who: { type: "string" }, how: { type: "string" } } } },
    findings: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, level: { type: "string", enum: ["danger", "warning", "info", "ok"] }, who: { type: ["string", "null"] }, plain: { type: "string" }, detail: { type: "object" }, fix: { type: "object" } } } },
    truncated: { type: "boolean" },
  },
} as const;
