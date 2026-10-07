// src/app/api/execute/serviceCatalog.ts
// The transactions XRPLHub still builds for its OWN products (owner decision 2026-10-07: the generic transaction
// catalog was removed — we keep only products nobody else offers). Each entry: what it produces, its safety tier, and
// every parameter. Keep the `required` lists in sync with src/app/api/execute/txBuilder.ts.
//   mptissue   — MPT issuance with a recorded backing declaration (feeds the io.xrplhub.mpt.v1.declared credential)
//   permdomain — Permissioned Domain gated on XRPLScore credentials (/api/domains/build)
// The admin-only health check (adminhealthcheck) is NOT listed here on purpose (servicePrices.ts ADMIN_ONLY_SERVICE_IDS).

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
  { id: "permdomain", label: "XRPLScore-gated Permissioned Domain", category: "Credentials", tier: "safe",
    gives: "A PermissionedDomainSet txjson that admits wallets holding an XRPLScore credential of the chosen tier or higher (plus any other credentials you add).",
    params: [
      P("minTier", "string", true, "Lowest XRPLScore tier to admit: min600, min650, min700 or min750; every higher tier is added for you", "min650"),
      P("alsoAccept", "string", false, "Other accepted credentials as rIssuer:type,rIssuer:type (10 credentials in total)", "rIssuer...:kyc-basic"),
      P("domainId", "string", false, "Update an existing domain you own (its 64-hex DomainID); omit to create a new one", "ABCD…"),
    ] },
];

/** Buildable ids — everything except blocked ones. */
export const BUILDABLE_SERVICE_IDS = SERVICE_CATALOG.filter((s) => s.tier !== "blocked").map((s) => s.id);
