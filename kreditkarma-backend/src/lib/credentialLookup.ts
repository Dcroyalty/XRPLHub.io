// src/lib/credentialLookup.ts
// LIVE reads over XRPL mainnet Credential objects. No indexer, no cache —
// every call opens a mainnet connection and asks the ledger directly, because
// this backs the two surfaces where a stale answer is actually dangerous:
// "does this account hold a valid credential" and "is this account eligible
// for this domain". A revoked/expired credential must never read as valid
// because our database hadn't caught up yet.
//
// SPEC NOTE (confirmed against the primary XLS-70 text, not the xrpl.org
// summary, which says something different and is wrong on this point): a
// Credential object lives in BOTH the Subject's and Issuer's owner
// directories for its whole life — acceptance only moves who pays the
// reserve, not which directories list it. So account_objects on an address
// returns every credential where it's either party, pending or accepted,
// with no risk of missing a not-yet-accepted one.

import { convertHexToString } from "xrpl";
import { connectMainnetOrThrow, validatedLedgerCloseTimeRipple } from "./credentials";

export interface LiveCredential {
  objectIndex: string;
  issuer: string;
  subject: string;
  credentialType: string;    // hex
  credentialTypeDecoded: string;
  accepted: boolean;
  expirationRipple: number | null;
  expirationISO: string | null;
  expired: boolean;          // computed against the validated ledger's close time, not wall clock
  uri: string | null;
  uriDecoded: string | null;
}

function safeDecode(hex: string): string {
  try {
    return convertHexToString(hex);
  } catch {
    return hex;
  }
}

function toLiveCredential(node: Record<string, unknown>, nowRipple: number): LiveCredential {
  const flags = Number(node.Flags ?? 0);
  const accepted = (flags & 0x00010000) !== 0; // lsfAccepted
  const expRipple = typeof node.Expiration === "number" ? node.Expiration : null;
  const uriHex = typeof node.URI === "string" ? node.URI : null;
  const typeHex = String(node.CredentialType ?? "");
  return {
    objectIndex: String(node.index ?? ""),
    issuer: String(node.Issuer ?? ""),
    subject: String(node.Subject ?? ""),
    credentialType: typeHex,
    credentialTypeDecoded: safeDecode(typeHex),
    accepted,
    expirationRipple: expRipple,
    expirationISO: expRipple != null ? rippleToISO(expRipple) : null,
    expired: expRipple != null && expRipple <= nowRipple,
    uri: uriHex,
    uriDecoded: uriHex ? safeDecode(uriHex) : null,
  };
}

function rippleToISO(ripple: number): string {
  // Ripple epoch starts 2000-01-01T00:00:00Z, 946684800s after Unix epoch.
  return new Date((ripple + 946_684_800) * 1000).toISOString();
}

/** Every Credential object naming `role` as either party, paginated. */
async function fetchAccountCredentials(address: string) {
  const client = await connectMainnetOrThrow();
  try {
    const nowRipple = await validatedLedgerCloseTimeRipple(client);
    const nodes: Record<string, unknown>[] = [];
    let marker: unknown = undefined;
    do {
      const res = await client.request({
        command: "account_objects",
        account: address,
        type: "credential",
        ledger_index: "validated",
        limit: 200,
        ...(marker ? { marker } : {}),
      } as unknown as Parameters<typeof client.request>[0]);
      const result = res.result as { account_objects?: Record<string, unknown>[]; marker?: unknown };
      nodes.push(...(result.account_objects ?? []));
      marker = result.marker;
    } while (marker);
    return { nodes, nowRipple };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Every credential where `address` is the Subject — held, pending or accepted. */
export async function listCredentialsHeldBy(address: string): Promise<LiveCredential[]> {
  const { nodes, nowRipple } = await fetchAccountCredentials(address);
  return nodes
    .filter((n) => String(n.Subject) === address)
    .map((n) => toLiveCredential(n, nowRipple));
}

/** Every credential `address` has issued, regardless of accept status. */
export async function listCredentialsIssuedBy(address: string): Promise<LiveCredential[]> {
  const { nodes, nowRipple } = await fetchAccountCredentials(address);
  return nodes
    .filter((n) => String(n.Issuer) === address)
    .map((n) => toLiveCredential(n, nowRipple));
}

// ── PermissionedDomain (live) ────────────────────────────────────────────────

export interface DomainInfo {
  found: boolean;
  domainId: string;
  owner?: string;
  acceptedCredentials?: { issuer: string; credentialType: string; credentialTypeDecoded: string }[];
}

/** Fetch a PermissionedDomain by its raw 256-bit DomainID (ledger index). */
export async function getDomain(domainId: string): Promise<DomainInfo> {
  const client = await connectMainnetOrThrow();
  try {
    let node: Record<string, unknown> | null = null;
    try {
      const res = await client.request({
        command: "ledger_entry",
        ledger_index: "validated",
        index: domainId,
      } as unknown as Parameters<typeof client.request>[0]);
      node = (res.result as { node?: Record<string, unknown> }).node ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/entryNotFound|not.*found/i.test(msg)) return { found: false, domainId };
      throw err;
    }
    if (!node || node.LedgerEntryType !== "PermissionedDomain") return { found: false, domainId };

    const accepted = (node.AcceptedCredentials as Record<string, unknown>[] | undefined) ?? [];
    return {
      found: true,
      domainId,
      owner: String(node.Owner ?? ""),
      acceptedCredentials: accepted.map((entry) => {
        const c = (entry.Credential ?? {}) as Record<string, unknown>;
        const typeHex = String(c.CredentialType ?? "");
        return { issuer: String(c.Issuer ?? ""), credentialType: typeHex, credentialTypeDecoded: safeDecode(typeHex) };
      }),
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export interface EligibilityResult {
  eligible: boolean;
  domain: DomainInfo;
  address: string;
  satisfiedBy: LiveCredential | null; // the credential that granted membership, if any
  heldCredentials: LiveCredential[];  // everything the address holds, for transparency
  reason: string;
}

/**
 * Domain membership per XLS-80d: OR semantics — eligible if `address` holds
 * ANY ONE accepted, non-expired credential whose (Issuer, CredentialType)
 * matches ANY entry in the domain's AcceptedCredentials.
 */
export async function checkDomainEligibility(address: string, domainId: string): Promise<EligibilityResult> {
  const [domain, heldCredentials] = await Promise.all([
    getDomain(domainId),
    listCredentialsHeldBy(address),
  ]);

  if (!domain.found) {
    return {
      eligible: false, domain, address, satisfiedBy: null, heldCredentials,
      reason: "No PermissionedDomain exists at that DomainID on the validated ledger.",
    };
  }

  const accepts = domain.acceptedCredentials ?? [];
  const satisfiedBy =
    heldCredentials.find(
      (c) =>
        c.accepted &&
        !c.expired &&
        accepts.some((a) => a.issuer === c.issuer && a.credentialType === c.credentialType)
    ) ?? null;

  return {
    eligible: satisfiedBy !== null,
    domain,
    address,
    satisfiedBy,
    heldCredentials,
    reason: satisfiedBy
      ? `Eligible — holds an accepted, unexpired credential (issuer ${satisfiedBy.issuer}, type ${satisfiedBy.credentialTypeDecoded}) matching this domain's AcceptedCredentials.`
      : "Not eligible — no held credential is both accepted and unexpired with an (Issuer, CredentialType) matching this domain's AcceptedCredentials.",
  };
}
