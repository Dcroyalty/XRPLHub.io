// src/lib/domainKit.ts
// Permissioned Domain integration kit: everything an institution needs to gate an XLS-80 PermissionedDomain on XRPLScore
// credentials (issuer rmWjCGe…, types io.xrplhub.score.v1.<tier>), in one place. Pure functions — no signing, no keys, no I/O.
//
// THE TRAP THIS EXISTS TO PREVENT (docs/CREDENTIAL-SPEC.md §3): a wallet holds only its HIGHEST tier. A domain that lists only
// `min650` silently rejects every wallet scoring 700+. Choosing a floor therefore means listing the floor AND every tier above it;
// this module does that for you, so "650 or better" cannot be typed wrong.

import { CRED_NAMESPACE, EXPECTED_ISSUER, credentialType, type ScoreTier } from "@/lib/credentials";
import { isValidXrplAddress } from "@/lib/address";

export const SCORE_TIERS: readonly ScoreTier[] = ["min600", "min650", "min700", "min750"];
export const TIER_FLOOR: Record<ScoreTier, number> = { min600: 600, min650: 650, min700: 700, min750: 750 };
/** XLS-80: a PermissionedDomain holds at most 10 accepted credentials. */
export const MAX_ACCEPTED_CREDENTIALS = 10;
const MAX_TYPE_BYTES = 64; // XLS-70 CredentialType limit

/** "min650" | "650" | 650 → "min650"; anything else → null. */
export function parseTier(v: unknown): ScoreTier | null {
  const s = String(v ?? "").trim().toLowerCase();
  const m = /^(?:min)?(600|650|700|750)$/.exec(s);
  return m ? (`min${m[1]}` as ScoreTier) : null;
}

/** The floor tier and every tier above it, lowest first. */
export function tiersFrom(min: ScoreTier): ScoreTier[] {
  return SCORE_TIERS.filter((t) => TIER_FLOOR[t] >= TIER_FLOOR[min]);
}

export interface AcceptedCredential {
  issuer: string;
  /** ASCII (as the institution thinks of it) */
  credentialType: string;
  credentialTypeHex: string;
}

const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

/** Parse "rIssuer:credential-type,rIssuer2:type2" or an array of {issuer, credentialType}. Throws Error with a plain message. */
export function parseExtraCredentials(input: unknown): AcceptedCredential[] {
  if (input === undefined || input === null || input === "") return [];
  let raw: Array<{ issuer?: unknown; credentialType?: unknown }>;
  if (Array.isArray(input)) raw = input as typeof raw;
  else if (typeof input === "string") {
    raw = input
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf(":");
        return { issuer: i < 0 ? "" : p.slice(0, i).trim(), credentialType: i < 0 ? "" : p.slice(i + 1).trim() };
      });
  } else throw new Error("alsoAccept must be a list of { issuer, credentialType } or the string \"rIssuer:type,rIssuer:type\".");
  return raw.map((r, n) => {
    const issuer = String(r.issuer ?? "").trim();
    const type = String(r.credentialType ?? "").trim();
    if (!isValidXrplAddress(issuer)) throw new Error(`alsoAccept[${n}]: issuer is not a valid XRPL address.`);
    if (!type) throw new Error(`alsoAccept[${n}]: credentialType is empty.`);
    const bytes = Buffer.byteLength(type, "utf8");
    if (bytes > MAX_TYPE_BYTES) throw new Error(`alsoAccept[${n}]: credentialType is ${bytes} bytes; the limit is ${MAX_TYPE_BYTES}.`);
    return { issuer, credentialType: type, credentialTypeHex: toHex(type) };
  });
}

export interface DomainPlan {
  ok: true;
  owner: string;
  minTier: ScoreTier;
  scoreFloor: number;
  updatesDomainId: string | null;
  accepted: AcceptedCredential[];
  txjson: { TransactionType: "PermissionedDomainSet"; Account: string; DomainID?: string; AcceptedCredentials: Array<{ Credential: { Issuer: string; CredentialType: string } }> };
}
export interface DomainPlanError {
  ok: false;
  error: string;
  needs?: string[];
}

/** Build the (unsigned) PermissionedDomainSet gating on `minTier` and above, plus any other issuers the institution also accepts. */
export function planScoreDomain(p: { owner: string; minTier: unknown; alsoAccept?: unknown; domainId?: unknown }): DomainPlan | DomainPlanError {
  if (!isValidXrplAddress(String(p.owner ?? ""))) return { ok: false, error: "account must be a valid XRPL address (the institution's domain-owner account)." };
  const minTier = parseTier(p.minTier);
  if (!minTier) return { ok: false, error: "minTier must be one of min600, min650, min700, min750.", needs: ["minTier"] };
  let extras: AcceptedCredential[];
  try {
    extras = parseExtraCredentials(p.alsoAccept);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "bad alsoAccept" };
  }
  let domainId: string | null = null;
  if (p.domainId !== undefined && p.domainId !== null && String(p.domainId).trim() !== "") {
    const d = String(p.domainId).trim().toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(d)) return { ok: false, error: "domainId must be the 64-hex-character DomainID of a domain you own (omit it to create a new domain)." };
    domainId = d;
  }
  const ours: AcceptedCredential[] = tiersFrom(minTier).map((t) => ({ issuer: EXPECTED_ISSUER, credentialType: credentialType(t), credentialTypeHex: toHex(credentialType(t)) }));
  const accepted = [...ours];
  for (const x of extras) {
    if (!accepted.some((a) => a.issuer === x.issuer && a.credentialTypeHex === x.credentialTypeHex)) accepted.push(x);
  }
  if (accepted.length > MAX_ACCEPTED_CREDENTIALS) {
    return { ok: false, error: `A domain accepts at most ${MAX_ACCEPTED_CREDENTIALS} credentials; ${minTier} and above uses ${ours.length}, so alsoAccept can add at most ${MAX_ACCEPTED_CREDENTIALS - ours.length}.` };
  }
  return {
    ok: true,
    owner: p.owner,
    minTier,
    scoreFloor: TIER_FLOOR[minTier],
    updatesDomainId: domainId,
    accepted,
    txjson: {
      TransactionType: "PermissionedDomainSet",
      Account: p.owner,
      ...(domainId ? { DomainID: domainId } : {}),
      AcceptedCredentials: accepted.map((a) => ({ Credential: { Issuer: a.issuer, CredentialType: a.credentialTypeHex } })),
    },
  };
}

/** What a member wallet must do, given the tier it qualifies for — used by the guide and the request flow. */
export const MEMBER_STEPS = [
  "Request the credential: POST /api/credentials/request { \"subject\": \"r…\" } — we score the wallet fresh, and if it clears 600 we queue the credential for the tier its score earns.",
  "We issue it (a CredentialCreate from our issuer wallet). It appears on the ledger as PENDING and is not usable yet.",
  "Accept it: sign one CredentialAccept transaction from the SAME wallet (GET /api/credentials/request?subject=r… returns the unsigned transaction). Accepting moves the 0.2 XRP owner reserve from us to the member's wallet.",
  "Once accepted and unexpired, the wallet satisfies any domain that lists its tier: check it with GET /api/domains/eligible?address=r…&domain=<DomainID>.",
] as const;

export const DOMAIN_KIT_NOTES = {
  issuer: EXPECTED_ISSUER,
  namespace: CRED_NAMESPACE,
  reserve: "Creating a PermissionedDomain adds one object to the owner's account: 0.2 XRP owner reserve (network reserve values as of today: 1 XRP base, 0.2 XRP per object) plus a ~0.00001 XRP fee.",
  expiry: "Each credential expires 90 days after issuance. A member that is not re-issued (score fell below the tier, or never re-requested) drops out of the domain automatically at expiry — you do nothing.",
  highestTierOnly: "A wallet holds only its highest tier, so the domain must list the floor tier AND every tier above it. This builder does that for you.",
  unsolicited: "Unsolicited ratings exist too: we have issued credentials to wallets that did not ask. Those are unaccepted, and an unaccepted credential never satisfies a domain. A member must request AND accept.",
  notAdvice: "A credential attests that XRPLScore was at or above the tier at issuance — an opinion computed from public XRP Ledger data, not a KYC/AML result, a creditworthiness determination, or a compliance status. Whether a wallet should be admitted to your venue remains your decision.",
} as const;
