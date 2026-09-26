// src/app/api/execute/serviceCatalog.ts
// Machine-readable catalogue of the build_xrpl_transaction services: what
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
  { id: "multisig", label: "Multi-sig (signer list, optional master-key lockdown)", category: "Wallet security", tier: "caution",
    gives:
      "A SignerListSet txjson putting the account under N-of-M control. On its own it does NOT stop the master key from signing alone. " +
      "With disableMaster=true it is THREE signed steps — signer list, remove any regular key, then disable the master key — after which multi-signing is the only way to move funds. " +
      "Unrecoverable if the quorum can't be reached; the paid path forces a confirmation step.",
    params: [
      P("signers", "string", true, "Comma-separated signer addresses (1-32, unique, not your own)", "rAAA...,rBBB...,rCCC..."),
      P("quorum", "number", true, "Signatures required to move funds (at most the number of signers)", "2"),
      P("disableMaster", "boolean", false, "true = ALSO remove any regular key and disable the master key (3 steps). Without it the master key can still sign alone.", "false"),
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
  { id: "issuerdecl", label: "Renounce freeze authority (asfNoFreeze)", category: "Token issuer", tier: "caution",
    gives:
      "An AccountSet txjson enabling No Freeze (SetFlag 6). PERMANENT: the account can never freeze an individual trust line again, and Global Freeze can never be turned off once switched on. " +
      "Must be signed with the account's master key. Refused if Global Freeze is currently ON. The paid path forces a confirmation step.",
    params: [] },
  { id: "issuercfg", label: "Full issuer config", category: "Token issuer", tier: "safe",
    gives:
      "One AccountSet txjson: enables Default Ripple and sets any of Domain, TransferRate and TickSize (optionally DisallowXRP). Provide at least one of domain / transferFee / tickSize.",
    params: [
      P("domain", "string", false, "Lowercase hostname, e.g. example.com", "example.com"),
      P("transferFee", "number", false, "Transfer fee percent 0-100 (charged on holder-to-holder transfers of your token)", "0.5"),
      P("tickSize", "number", false, "Order-book price precision: 0 (off) or 3-15 significant digits", "5"),
      P("disallowXRP", "boolean", false, "Set the DisallowXRP flag (advisory: signals the account does not want XRP)", "false"),
    ] },
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
    gives:
      "TWO transactions, signed in order: (1) TrustSet, (2) a Payment of that issued currency from your account to the destination. " +
      "Step 2 needs you to already hold enough of the token and the destination to trust the issuer — both are checked against the ledger before it is built.",
    params: [
      P("issuer", "address", true, "Token issuer address", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"),
      P("currency", "string", true, "3-char code, or a longer code we hex-encode for you", "USD"),
      P("destination", "address", true, "Who receives the currency", "rDest..."),
      P("amount", "string", true, "How much to send", "10"),
      P("limit", "string", false, "Trust limit (default 1000000000; at least the amount)", "1000000"),
    ] },
  { id: "rippling", label: "Rippling control", category: "Token issuer", tier: "safe",
    gives:
      "issuer mode: an AccountSet txjson setting or clearing Default Ripple. holder mode: a TrustSet on one existing trust line that clears or sets NoRipple (your current limit is preserved).",
    params: [
      P("mode", "string", false, "issuer (default) or holder", "issuer"),
      P("enable", "boolean", false, "true = allow rippling (default true)", "true"),
      P("currency", "string", false, "holder mode: currency of the trust line", "USD"),
      P("issuer", "address", false, "holder mode: the counterparty (issuer) of the trust line", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"),
    ] },
  { id: "mptissue", label: "Issue Multi-Purpose Token", category: "Token issuer", tier: "caution",
    gives:
      "An MPTokenIssuanceCreate txjson. Supply cap, decimals and any flag switched ON are permanent in every case; " +
      "the transfer fee, the metadata (incl. the backing declaration) and flags left OFF are fixed only while the " +
      "DynamicMPT amendment (XLS-94) stays inactive — once it is active the issuer can change them unless locked " +
      "with ImmutableFlags. Which case applies right now is read live from the ledger: see GET /api/mpt/permanence " +
      "and the free preview at POST /api/execute/preview (the 'permanence' block); the paid path forces a " +
      "confirmation manifest before signing.",
    params: [
      P("name", "string", true, "Token name (<=64 chars), stored in on-ledger metadata", "ACME Points"),
      P("ticker", "string", true, "1-6 letters/digits, stored in on-ledger metadata", "ACME"),
      P("maximumAmount", "string", true, "Hard cap on total ever minted (1 .. 9223372036854775807). Creation mints 0.", "1000000000"),
      P("assetScale", "number", false, "Decimal places 0-19 (default 0). 2 = smallest unit is 0.01.", "2"),
      P("metadataUrl", "string", false, "Optional https link, stored in metadata as weblink", "https://acme.example"),
      P("canTransfer", "boolean", false, "Holders can send to each other. WITHOUT this: closed-loop / store credit only.", "true"),
      P("canTrade", "boolean", false, "Holders can use the DEX/AMM", "false"),
      P("canEscrow", "boolean", false, "Holders can escrow their balance", "false"),
      P("canLock", "boolean", false, "ISSUER POWER: you can freeze one holder or all holders", "false"),
      P("requireAuth", "boolean", false, "ISSUER POWER: nobody can hold it until you approve them", "false"),
      P("canClawback", "boolean", false, "ISSUER POWER: you can take the token back from any holder without consent. Once on it stays on; if left off it can only be switched on later if DynamicMPT is active and the flag is not locked.", "false"),
      P("transferFee", "number", false, "Secondary-sale fee 0-50%%, requires canTransfer", "0"),
      P("backingType", "string", false, "none | physical-custody | legal-entity | other-onchain | self-declared (default none)", "none"),
      P("backingStatement", "string", false, "What the issuer claims backs the token. XRPLHub does not verify this.", "1:1 USD held at ..."),
      P("verifiedBy", "string", false, "Who verifies the backing, if anyone. Never XRPLHub.", ""),
      P("redeemable", "string", false, "yes | no | unspecified — can a holder exchange the token for the underlying", "unspecified"),
      P("lockAll", "boolean", false, "Lock every item with ImmutableFlags (XLS-94) so it can never change. ONLY accepted while DynamicMPT is active — otherwise the build is refused (never silently dropped). Per-item: lockMetadata, lockTransferFee, lockCanLock, lockRequireAuth, lockCanEscrow, lockCanTrade, lockCanTransfer, lockCanClawback.", "false"),
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
  { id: "ammwithdraw", label: "AMM liquidity exit", category: "DeFi", tier: "safe",
    gives:
      "An AMMWithdraw txjson taking liquidity back out of an AMM pool. mode=all redeems ALL your LP tokens for both assets (tfWithdrawAll); single withdraws an amount of asset 1 (tfSingleAsset); two withdraws amounts of both (tfTwoAsset). Checked against the ledger: the pool must exist and you must hold its LP tokens.",
    params: [
      P("asset2Currency", "string", true, "Asset 2 currency (identifies the pool)", "RLUSD"),
      P("asset2Issuer", "address", false, "Asset 2 issuer if not XRP", "rIssuer..."),
      P("assetCurrency", "string", false, "Asset 1 currency (default XRP)", "XRP"),
      P("assetIssuer", "address", false, "Asset 1 issuer if not XRP", "rIssuer..."),
      P("mode", "string", false, "all (default), single, or two", "all"),
      P("assetValue", "string", false, "Amount of asset 1 to withdraw (single / two modes)", "10"),
      P("asset2Value", "string", false, "Amount of asset 2 to withdraw (two mode)", "14"),
    ] },
  { id: "smartswap", label: "Smart swap router (path payment)", category: "DeFi", tier: "safe",
    gives:
      "A cross-currency Payment routed by the ledger's own pathfinder across order books and AMM pools. You receive EXACTLY the amount you ask for; SendMax caps what you can be charged at the quote plus your slippage %. Refused if no route with liquidity exists.",
    params: [
      P("receiveValue", "string", true, "Amount you want to receive", "10"),
      P("receiveCurrency", "string", true, "Currency you want to receive", "USD"),
      P("receiveIssuer", "address", false, "Issuer of the currency you receive, if not XRP", "rIssuer..."),
      P("sendCurrency", "string", false, "Currency you pay with (default XRP)", "XRP"),
      P("sendIssuer", "address", false, "Issuer of the currency you pay with, if not XRP", "rIssuer..."),
      P("slippagePct", "number", false, "Max % over the current quote you accept (default 1, max 10)", "1"),
      P("destination", "address", false, "Deliver to this address (default: yourself)", "rDest..."),
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
    gives:
      "An AMMDeposit txjson (Asset + Asset2 identify the pool). Give both amounts for a two-sided deposit (tfTwoAsset) or only assetValue for a single-sided one (tfSingleAsset). Refused if no AMM exists for the pair.",
    params: [
      P("assetValue", "string", true, "Amount of asset 1", "1000"),
      P("assetCurrency", "string", false, "Asset 1 currency (default XRP)", "XRP"),
      P("assetIssuer", "address", false, "Asset 1 issuer if not XRP", "rIssuer..."),
      P("asset2Currency", "string", true, "Asset 2 currency (identifies the pool)", "USD"),
      P("asset2Issuer", "address", false, "Asset 2 issuer if not XRP", "rIssuer..."),
      P("asset2Value", "string", false, "Amount of asset 2 — omit for a single-sided deposit", "500"),
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
  { id: "depositpreauth", label: "Deposit preauthorization", category: "Wallet security", tier: "safe",
    gives:
      "A DepositPreauth txjson that preauthorizes (or revokes) ONE sender account for Deposit Authorization. With asfDepositAuth on (the Deposit Auth service), only preauthorized senders can pay you. Each entry counts toward your owner reserve (0.2 XRP).",
    params: [
      P("sender", "address", true, "The account to preauthorize (or to revoke)", "rSender..."),
      P("action", "string", false, "authorize (default) or remove", "authorize"),
    ] },
  { id: "escrow", label: "Create escrow", category: "Payments", tier: "safe",
    gives: "An EscrowCreate txjson time-locking XRP until finishAfter.",
    params: [
      P("destination", "address", true, "Escrow recipient", "rDest..."),
      P("amount", "string", true, "XRP to lock", "25"),
      P("finishAfter", "number", true, "Unlock time — Ripple-epoch seconds", "788000000"),
    ] },

  // ── Identity / compliance ──────────────────────────────────────
  { id: "identity", label: "Set on-chain identity (Domain + email hash)", category: "Identity", tier: "safe",
    gives:
      "An AccountSet txjson writing your domain to the account Domain field and, if given, the XRPL EmailHash (the MD5 of your lowercased email — the Gravatar convention). " +
      "Explorers may display these; a domain is only verified if you also publish an xrp-ledger.toml naming this account.",
    params: [
      P("domain", "string", true, "Your domain (lowercase hostname, no https://)", "xrplhub.io"),
      P("email", "string", false, "Email address to hash into EmailHash (MD5)", "you@example.com"),
    ] },
  { id: "did", label: "Create / update DID", category: "Identity", tier: "safe",
    gives: "A DIDSet txjson pointing at your DID document.",
    params: [P("uri", "string", true, "DID document URI", "https://example.com/did.json")] },
  { id: "compliance", label: "Compliance bundle (identity + domain + DID)", category: "Identity", tier: "safe",
    gives:
      "TWO transactions, signed in order: (1) AccountSet with your Domain and EmailHash, (2) DIDSet with your DID document URI.",
    params: [
      P("domain", "string", true, "Your domain (lowercase hostname, no https://)", "xrplhub.io"),
      P("email", "string", false, "Email address to hash into EmailHash (MD5)", "you@example.com"),
      P("didUri", "string", true, "URI of your DID document (<= 256 bytes)", "https://example.com/did.json"),
    ] },
  { id: "credentialissue", label: "Issue a credential", category: "Identity", tier: "safe",
    gives: "A CredentialCreate txjson attesting a CredentialType about a subject wallet.",
    params: [
      P("subject", "address", true, "Wallet the credential is about", "rSubject..."),
      P("credentialType", "string", true, "Credential type string (hex-encoded for you)", "kyc-basic"),
    ] },
  { id: "permdomain", label: "Set permissioned domain", category: "Identity", tier: "safe",
    gives: "A PermissionedDomainSet txjson accepting a credential (Issuer, CredentialType) — or, with minTier, gated on XRPLScore credentials (that tier and every tier above it).",
    params: [
      P("credentialType", "string", false, "Accepted credential type (required unless minTier is given)", "kyc-basic"),
      P("acceptedIssuer", "address", false, "Accepted issuer (default: you)", "rIssuer..."),
      P("minTier", "string", false, "Gate on XRPLScore credentials: lowest tier to admit (min600, min650, min700 or min750); every higher tier is added for you", "min650"),
      P("alsoAccept", "string", false, "With minTier: other accepted credentials as rIssuer:type,rIssuer:type (10 credentials in total)", "rIssuer...:kyc-basic"),
      P("domainId", "string", false, "Update an existing domain you own (its 64-hex DomainID); omit to create a new one", "ABCD…"),
    ] },
];

export const SERVICE_IDS = SERVICE_CATALOG.map((s) => s.id);

/** Buildable service ids — everything except the blocked ones (e.g. lockdown). */
export const BUILDABLE_SERVICE_IDS = SERVICE_CATALOG.filter((s) => s.tier !== "blocked").map((s) => s.id);

/** How many services the storefront sells. EVERY count shown anywhere is derived from this — never typed by hand. */
export const SERVICE_COUNT = BUILDABLE_SERVICE_IDS.length;

/** Compact one-line-per-service reference for embedding in tool descriptions. */
export function serviceParamLines(): string {
  return SERVICE_CATALOG.map((s) => {
    const req = s.params.filter((p) => p.required).map((p) => p.name);
    return `${s.id}: ${req.length ? req.join(", ") : "(no params)"}`;
  }).join(" | ");
}
