// src/lib/delegationPermissions.ts
// The permissions the Permission Delegation service (XLS-75) lets a customer grant, with plain-English copy for each.
// Pure data with no server-only imports, so the homepage's picker and the server's builder + confirmation step read
// the SAME list. Rules, builders and the ledger behaviour this copy rests on: src/lib/delegation.ts.

export const MAX_DELEGATE_PERMISSIONS = 10;

/** spend = can move, sell or destroy what you hold · control = changes how your account or tokens behave · low = brings
 *  value in or only cleans up. */
export type DelegationRisk = "spend" | "control" | "low";

export interface DelegablePermission {
  value: string;
  label: string;
  risk: DelegationRisk;
  /** Exactly what the delegate can do with it, in plain English. Shown in the form and in the confirmation step. */
  allows: string;
  granular?: boolean;
}

// Curated: the permissions a customer can pick on the storefront. Anything not here is refused by the builder, so a
// typo or a spec-forbidden type can never reach the ledger after payment.
export const DELEGABLE_PERMISSIONS: readonly DelegablePermission[] = [
  // ── can move your assets ──
  { value: "Payment", label: "Send payments", risk: "spend",
    allows: "Send XRP, tokens or MPTs from your account to ANY address, in ANY amount your balance allows. This is full spending power over your account." },
  { value: "OfferCreate", label: "Place DEX orders", risk: "spend",
    allows: "Trade your XRP and tokens on the decentralized exchange at whatever price they choose. A badly priced order can sell your balance for almost nothing." },
  { value: "CheckCreate", label: "Write checks", risk: "spend",
    allows: "Write checks from your account that the named recipient can later cash for up to the amount written." },
  { value: "EscrowCreate", label: "Create escrows", risk: "spend",
    allows: "Lock your XRP (or escrow-enabled tokens) in an escrow payable to any destination they choose." },
  { value: "PaymentChannelCreate", label: "Open payment channels", risk: "spend",
    allows: "Open a payment channel funded with your XRP, to a destination they choose." },
  { value: "PaymentChannelFund", label: "Top up payment channels", risk: "spend",
    allows: "Add more of your XRP to an existing payment channel of yours." },
  { value: "AMMDeposit", label: "Deposit into AMM pools", risk: "spend",
    allows: "Move your assets into an AMM liquidity pool (you receive LP tokens in return)." },
  { value: "NFTokenCreateOffer", label: "Create NFT offers", risk: "spend",
    allows: "Offer your NFTs for sale at any price (including next to nothing), or offer your funds to buy NFTs." },
  { value: "NFTokenAcceptOffer", label: "Accept NFT offers", risk: "spend",
    allows: "Accept NFT offers on your behalf — buying NFTs with your funds or selling the NFTs you hold." },
  { value: "NFTokenBurn", label: "Burn NFTs", risk: "spend",
    allows: "Permanently destroy NFTs you own. A burned NFT cannot be recovered." },
  { value: "PaymentMint", label: "Issue your token (mint)", risk: "spend", granular: true,
    allows: "Only for tokens YOU issue: send them to holders, which creates new supply. Cannot send XRP or anyone else's tokens." },
  { value: "PaymentBurn", label: "Return tokens to their issuer (burn)", risk: "spend", granular: true,
    allows: "Send tokens you hold back to their issuer, which destroys them. Cannot send to anyone else." },
  { value: "Clawback", label: "Claw back your token", risk: "spend",
    allows: "Only for tokens YOU issue with clawback enabled: take them back from a holder's account." },

  // ── changes how your account or tokens behave ──
  { value: "TrustSet", label: "Manage trust lines", risk: "control",
    allows: "Create, change or remove trust lines on your account — and, for tokens you issue, authorize, freeze or unfreeze holders' lines." },
  { value: "TrustlineAuthorize", label: "Authorize holders of your token", risk: "control", granular: true,
    allows: "Only for tokens YOU issue that require authorization: approve a holder's trust line. Nothing else about trust lines." },
  { value: "TrustlineFreeze", label: "Freeze a holder's trust line", risk: "control", granular: true,
    allows: "Only for tokens YOU issue: freeze an individual holder's trust line." },
  { value: "TrustlineUnfreeze", label: "Unfreeze a holder's trust line", risk: "control", granular: true,
    allows: "Only for tokens YOU issue: lift a freeze on an individual holder's trust line." },
  { value: "MPTokenIssuanceLock", label: "Lock MPT holders", risk: "control", granular: true,
    allows: "Only for MPTs YOU issue with locking enabled: lock (freeze) a holder or the whole issuance." },
  { value: "MPTokenIssuanceUnlock", label: "Unlock MPT holders", risk: "control", granular: true,
    allows: "Only for MPTs YOU issue: unlock a holder or the whole issuance." },
  { value: "MPTokenAuthorize", label: "Opt in to MPTs", risk: "control",
    allows: "Opt your account into holding an MPT, or — for MPTs you issue — authorize a holder." },
  { value: "AccountDomainSet", label: "Change your account domain", risk: "control", granular: true,
    allows: "Change the Domain field on your account (what explorers show as your website). No other account setting." },
  { value: "AccountEmailHashSet", label: "Change your email hash", risk: "control", granular: true,
    allows: "Change the EmailHash (Gravatar) field on your account. No other account setting." },
  { value: "AccountMessageKeySet", label: "Change your message key", risk: "control", granular: true,
    allows: "Change the MessageKey field on your account. No other account setting." },
  { value: "AccountTransferRateSet", label: "Change your token's transfer fee", risk: "control", granular: true,
    allows: "Change the transfer fee charged when holders move tokens you issue. No other account setting." },
  { value: "AccountTickSizeSet", label: "Change your token's tick size", risk: "control", granular: true,
    allows: "Change the order-book price precision for tokens you issue. No other account setting." },
  { value: "NFTokenMint", label: "Mint NFTs", risk: "control",
    allows: "Mint new NFTs from your account. Each new NFT page uses your XRP reserve." },
  { value: "DepositPreauth", label: "Manage who may pay you", risk: "control",
    allows: "Add or remove accounts that may pay you while Deposit Authorization is on." },
  { value: "DIDSet", label: "Set your DID", risk: "control",
    allows: "Create or change the DID document pointer on your account." },
  { value: "CredentialCreate", label: "Issue credentials", risk: "control",
    allows: "Issue on-ledger credentials from your account about any subject." },
  { value: "CredentialAccept", label: "Accept credentials", risk: "control",
    allows: "Accept credentials that other issuers have issued to your account." },
  { value: "TicketCreate", label: "Create tickets", risk: "control",
    allows: "Reserve sequence numbers (tickets) on your account. Each ticket uses your XRP reserve." },

  // ── brings value in, or only cleans up ──
  { value: "CheckCash", label: "Cash checks written to you", risk: "low",
    allows: "Cash checks that others wrote to your account. The money comes in to you." },
  { value: "CheckCancel", label: "Cancel checks", risk: "low",
    allows: "Cancel checks you wrote or that were written to you (and anyone's expired check)." },
  { value: "OfferCancel", label: "Cancel DEX orders", risk: "low",
    allows: "Cancel your open DEX orders. Cannot place new ones." },
  { value: "NFTokenCancelOffer", label: "Cancel NFT offers", risk: "low",
    allows: "Cancel NFT offers you made. Cannot make or accept offers." },
  { value: "EscrowFinish", label: "Finish escrows", risk: "low",
    allows: "Release escrows that are ready to finish. The funds go to each escrow's destination, never to the delegate." },
  { value: "EscrowCancel", label: "Cancel expired escrows", risk: "low",
    allows: "Cancel escrows that have expired. The funds return to whoever created them." },
  { value: "AMMWithdraw", label: "Withdraw from AMM pools", risk: "low",
    allows: "Redeem your LP tokens, moving your liquidity back into your own account." },
];

/** What a delegation can NEVER do, whatever is granted — shown on every grant. */
export const DELEGATION_NEVER = [
  "change your keys: your master key, regular key and signer list stay exactly as they are",
  "change other account settings (only the specific fields of a granted Account… permission)",
  "delete your account, or grant delegations to anyone else",
];
