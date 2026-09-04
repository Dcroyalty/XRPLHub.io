// src/app/api/execute/serviceCatalog.ts
// Machine-readable catalogue of the 35 build_xrpl_transaction services: what
// each one produces, its safety tier, and every parameter with type + example.
// Consumed by the MCP server (list_xrpl_services + build_xrpl_transaction docs),
// llms.txt, and the OpenAPI doc so an agent never has to guess params.
//
// Keep the `required` lists in sync with src/app/api/execute/txBuilder.ts.

export interface ServiceParam {
  name: string;
  type: "string" | "number" | "boolean" | "address";
  required: boolean;
  desc: string;
  example: string;
}

export interface ServiceDef {
  id: string;
  label: string;
  category: string;
  tier: "safe" | "caution" | "blocked";
  gives: string; // what the caller gets back
  params: ServiceParam[];
}

const P = (
  name: string,
  type: ServiceParam["type"],
  required: boolean,
  desc: string,
  example: string
): ServiceParam => ({ name, type, required, desc, example });

export const SERVICE_CATALOG: ServiceDef[] = [
  // ── Wallet security ──────────────────────────────────────────────
  { id: "multisig", label: "Multi-sig (SignerListSet)", category: "Wallet security", tier: "caution",
    gives: "A SignerListSet txjson that puts the account under N-of-M control.",
    params: [
      P("signers", "string", true, "Comma-separated signer addresses", "rAAA...,rBBB...,rCCC..."),
      P("quorum", "number", true, "Signatures required to move funds", "2"),
    ] },
  { id: "regkey", label: "Set regular key", category: "Wallet security", tier: "caution",
    gives: "A SetRegularKey txjson adding a backup signing key (master key still works).",
    params: [P("regularKey", "address", true, "Backup key address", "rBackupKeyAddr...")] },
  { id: "depositauth", label: "Enable Deposit Auth", category: "Wallet security", tier: "safe",
    gives: "An AccountSet txjson that blocks unsolicited incoming payments.", params: [] },
  { id: "desttag", label: "Require destination tag", category: "Wallet security", tier: "safe",
    gives: "An AccountSet txjson requiring a destination tag on incoming payments.", params: [] },
  { id: "lockdown", label: "XRP Lockdown (disable master key)", category: "Wallet security", tier: "blocked",
    gives: "Nothing — disabling the master key can permanently lock you out, so this is not auto-built. Contact support@xrplhub.io for a guided manual process.",
    params: [] },

  // ── Token issuer ────────────────────────────────────────────────
  { id: "issuerdecl", label: "Default Ripple (issuer)", category: "Token issuer", tier: "safe",
    gives: "An AccountSet txjson enabling Default Ripple so issued balances can flow.", params: [] },
  { id: "issuercfg", label: "Issuer config", category: "Token issuer", tier: "safe",
    gives: "An AccountSet txjson applying issuer defaults (Default Ripple).", params: [] },
  { id: "tokenfee", label: "Set transfer fee", category: "Token issuer", tier: "safe",
    gives: "An AccountSet txjson setting a transfer fee on your issued token.",
    params: [P("transferFee", "number", true, "Fee percent, 0–100", "0.5")] },
  { id: "trustline", label: "Set trust line", category: "Token issuer", tier: "safe",
    gives: "A TrustSet txjson opening a trust line to an issuer.",
    params: [
      P("issuer", "address", true, "Token issuer address", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"),
      P("currency", "string", true, "3-char code or 40-char hex", "USD"),
      P("limit", "string", false, "Trust limit (default 1000000000)", "1000000"),
    ] },
  { id: "trustsend", label: "Trust line + send currency", category: "Token issuer", tier: "safe",
    gives: "Step 1 TrustSet txjson (the follow-up Payment is a separate signed step).",
    params: [
      P("issuer", "address", true, "Token issuer address", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"),
      P("currency", "string", true, "3-char code or 40-char hex", "USD"),
      P("limit", "string", false, "Trust limit (default 1000000000)", "1000000"),
    ] },
  { id: "rippling", label: "Rippling control", category: "Token issuer", tier: "safe",
    gives: "An AccountSet txjson enabling or disabling rippling.",
    params: [P("enable", "boolean", false, "true = allow rippling (default true)", "true")] },
  { id: "mptissue", label: "Issue Multi-Purpose Token", category: "Token issuer", tier: "safe",
    gives: "An MPTokenIssuanceCreate txjson for a new transferable MPT.",
    params: [
      P("maximumAmount", "string", false, "Max supply (default 1000000000)", "1000000000"),
      P("assetScale", "number", false, "Decimal places (default 0)", "2"),
    ] },
  { id: "mptsend", label: "Send MPT", category: "Token issuer", tier: "safe",
    gives: "A Payment txjson sending a Multi-Purpose Token.",
    params: [
      P("destination", "address", true, "Recipient address", "rDest..."),
      P("mptIssuanceId", "string", true, "MPT issuance ID", "00000000ABCDEF..."),
      P("amount", "string", true, "Amount to send", "100"),
    ] },
  { id: "globalfreeze", label: "Global freeze", category: "Token issuer", tier: "safe",
    gives: "An AccountSet txjson freezing all balances of your issued token.", params: [] },
  { id: "freezeline", label: "Freeze a trust line", category: "Token issuer", tier: "safe",
    gives: "A TrustSet txjson freezing one holder's trust line.",
    params: [
      P("holder", "address", true, "Holder address to freeze", "rHolder..."),
      P("currency", "string", true, "3-char code or 40-char hex", "USD"),
    ] },

  // ── DeFi ────────────────────────────────────────────────────────
  { id: "dexorder", label: "DEX order (OfferCreate)", category: "DeFi", tier: "safe",
    gives: "An OfferCreate txjson for a limit order on the XRPL DEX.",
    params: [
      P("takerGetsValue", "string", true, "Amount you give", "10"),
      P("takerGetsCurrency", "string", false, "Currency you give (default XRP)", "XRP"),
      P("takerGetsIssuer", "address", false, "Issuer if not XRP", "rIssuer..."),
      P("takerPaysValue", "string", true, "Amount you want", "10"),
      P("takerPaysCurrency", "string", false, "Currency you want (default XRP)", "USD"),
      P("takerPaysIssuer", "address", false, "Issuer if not XRP", "rIssuer..."),
    ] },
  { id: "dextrade", label: "DEX trade execution", category: "DeFi", tier: "safe",
    gives: "An OfferCreate txjson (same shape as dexorder).",
    params: [
      P("takerGetsValue", "string", true, "Amount you give", "10"),
      P("takerPaysValue", "string", true, "Amount you want", "10"),
      P("takerPaysCurrency", "string", false, "Currency you want (default XRP)", "USD"),
      P("takerPaysIssuer", "address", false, "Issuer if not XRP", "rIssuer..."),
    ] },
  { id: "smartswap", label: "Smart swap router", category: "DeFi", tier: "safe",
    gives: "An OfferCreate txjson routed as a swap.",
    params: [
      P("takerGetsValue", "string", true, "Amount you give", "10"),
      P("takerPaysValue", "string", true, "Amount you want", "10"),
      P("takerPaysCurrency", "string", false, "Currency you want (default XRP)", "USD"),
      P("takerPaysIssuer", "address", false, "Issuer if not XRP", "rIssuer..."),
    ] },
  { id: "ammlaunch", label: "Create AMM pool", category: "DeFi", tier: "safe",
    gives: "An AMMCreate txjson launching a new liquidity pool.",
    params: [
      P("assetValue", "string", true, "Amount of asset 1", "1000"),
      P("assetCurrency", "string", false, "Asset 1 currency (default XRP)", "XRP"),
      P("assetIssuer", "address", false, "Asset 1 issuer if not XRP", "rIssuer..."),
      P("asset2Value", "string", true, "Amount of asset 2", "500"),
      P("asset2Currency", "string", false, "Asset 2 currency", "USD"),
      P("asset2Issuer", "address", false, "Asset 2 issuer if not XRP", "rIssuer..."),
      P("tradingFee", "number", false, "Fee in 1/1000 (default 500 = 0.5%)", "500"),
    ] },
  { id: "ammentry", label: "AMM liquidity deposit", category: "DeFi", tier: "safe",
    gives: "An AMMDeposit txjson adding two-sided liquidity to an existing pool.",
    params: [
      P("assetValue", "string", true, "Amount of asset 1", "1000"),
      P("assetCurrency", "string", false, "Asset 1 currency (default XRP)", "XRP"),
      P("asset2Value", "string", true, "Amount of asset 2", "500"),
      P("asset2Currency", "string", false, "Asset 2 currency", "USD"),
      P("asset2Issuer", "address", false, "Asset 2 issuer if not XRP", "rIssuer..."),
    ] },
  { id: "paychannel", label: "Create payment channel", category: "DeFi", tier: "safe",
    gives: "A PaymentChannelCreate txjson for streaming/off-ledger payments.",
    params: [
      P("destination", "address", true, "Channel recipient", "rDest..."),
      P("amount", "string", true, "XRP to fund the channel", "100"),
      P("publicKey", "string", true, "Channel public key (ED/02 hex)", "ED0123..."),
      P("settleDelay", "number", false, "Settle delay seconds (default 86400)", "86400"),
    ] },
  { id: "tickets", label: "Create tickets", category: "DeFi", tier: "safe",
    gives: "A TicketCreate txjson reserving sequence numbers for later txs.",
    params: [P("ticketCount", "number", false, "Tickets to create, 1–250 (default 1)", "5")] },

  // ── NFT ─────────────────────────────────────────────────────────
  { id: "nftmint", label: "Mint NFT", category: "NFT", tier: "safe",
    gives: "An NFTokenMint txjson (transferable, optional royalty).",
    params: [
      P("uri", "string", true, "Metadata URI", "ipfs://Qm... or https://..."),
      P("royalty", "number", false, "Royalty percent 0–50 (default 0)", "5"),
      P("taxon", "number", false, "Collection taxon (default 0)", "0"),
    ] },
  { id: "nftburn", label: "Burn NFT", category: "NFT", tier: "safe",
    gives: "An NFTokenBurn txjson.",
    params: [P("nftokenId", "string", true, "NFToken ID to burn", "000800001234...")] },
  { id: "nftoffer", label: "Create NFT sell offer", category: "NFT", tier: "safe",
    gives: "An NFTokenCreateOffer (sell) txjson.",
    params: [
      P("nftokenId", "string", true, "NFToken ID to sell", "000800001234..."),
      P("amount", "string", true, "Sale price in XRP", "25"),
    ] },

  // ── Payments ────────────────────────────────────────────────────
  { id: "checkcreate", label: "Create a check", category: "Payments", tier: "safe",
    gives: "A CheckCreate txjson (deferred payment the recipient cashes later).",
    params: [
      P("destination", "address", true, "Who can cash the check", "rDest..."),
      P("amount", "string", true, "Max XRP the check is worth", "10"),
    ] },
  { id: "checkcash", label: "Cash a check", category: "Payments", tier: "safe",
    gives: "A CheckCash txjson.",
    params: [
      P("checkId", "string", true, "Check object ID", "C4B900F...ledgerObjectHash"),
      P("amount", "string", true, "XRP amount to receive", "10"),
    ] },
  { id: "checkcancel", label: "Cancel a check", category: "Payments", tier: "safe",
    gives: "A CheckCancel txjson.",
    params: [P("checkId", "string", true, "Check object ID", "C4B900F...ledgerObjectHash")] },
  { id: "desttagreq", label: "Require destination tags", category: "Payments", tier: "safe",
    gives: "An AccountSet txjson requiring a destination tag on incoming payments.", params: [] },
  { id: "escrow", label: "Create escrow", category: "Payments", tier: "safe",
    gives: "An EscrowCreate txjson time-locking XRP until finishAfter.",
    params: [
      P("destination", "address", true, "Escrow recipient", "rDest..."),
      P("amount", "string", true, "XRP to lock", "25"),
      P("finishAfter", "number", true, "Unlock time — Ripple-epoch seconds", "788000000"),
    ] },

  // ── Identity / compliance ──────────────────────────────────────
  { id: "identity", label: "Set on-chain identity (Domain)", category: "Identity", tier: "safe",
    gives: "An AccountSet txjson writing your domain to the account Domain field.",
    params: [P("data", "string", true, "Your domain", "xrplhub.io")] },
  { id: "did", label: "Create / update DID", category: "Identity", tier: "safe",
    gives: "A DIDSet txjson pointing at your DID document.",
    params: [P("uri", "string", true, "DID document URI", "https://example.com/did.json")] },
  { id: "compliance", label: "Compliance bundle", category: "Identity", tier: "safe",
    gives: "An AccountSet txjson applying compliance defaults (require destination tag).", params: [] },
  { id: "credentialissue", label: "Issue a credential", category: "Identity", tier: "safe",
    gives: "A CredentialCreate txjson attesting a CredentialType about a subject wallet.",
    params: [
      P("subject", "address", true, "Wallet the credential is about", "rSubject..."),
      P("credentialType", "string", true, "Credential type string (hex-encoded for you)", "kyc-basic"),
    ] },
  { id: "permdomain", label: "Set permissioned domain", category: "Identity", tier: "safe",
    gives: "A PermissionedDomainSet txjson accepting a credential (Issuer, CredentialType).",
    params: [
      P("credentialType", "string", true, "Accepted credential type", "kyc-basic"),
      P("acceptedIssuer", "address", false, "Accepted issuer (default: you)", "rIssuer..."),
    ] },
];

export const SERVICE_IDS = SERVICE_CATALOG.map((s) => s.id);

/** Buildable service ids — everything except the blocked ones (e.g. lockdown). */
export const BUILDABLE_SERVICE_IDS = SERVICE_CATALOG.filter((s) => s.tier !== "blocked").map((s) => s.id);

/** Compact one-line-per-service reference for embedding in tool descriptions. */
export function serviceParamLines(): string {
  return SERVICE_CATALOG.map((s) => {
    const req = s.params.filter((p) => p.required).map((p) => p.name);
    return `${s.id}: ${req.length ? req.join(", ") : "(no params)"}`;
  }).join(" | ");
}
