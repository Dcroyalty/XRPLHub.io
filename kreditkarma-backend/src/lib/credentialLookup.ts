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

import { convertHexToString, convertStringToHex } from "xrpl";
import { connectMainnetOrThrow, validatedLedgerCloseTimeRipple } from "./credentials";

// A full owner-directory walk (account_objects with a type filter) is O(the
// whole directory) server-side — rippled scans every entry looking for the
// handful that match the type. For a normal account that's one fast page; for
// an exchange-scale account (tens of thousands of trust lines) it's dozens of
// round trips and 15-40s. We cap the walk at this budget and return
// `complete: false` rather than let a request hang past the function timeout.
// The targeted path — probeCredentials / ?issuer= — sidesteps the walk
// entirely with direct ledger_entry lookups and is always fast + exact.
const OWNER_WALK_BUDGET_MS = 20_000;

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

/**
 * One XRPL request with a few retries. Public nodes intermittently answer
 * "tooBusy" (error_code 9) or drop a socket under load — transient, and a
 * short backoff clears it. Not for logic errors (entryNotFound etc.), which
 * the callers handle explicitly and which would never succeed on retry.
 */
async function requestWithRetry<T = unknown>(
  client: Awaited<ReturnType<typeof connectMainnetOrThrow>>,
  req: Record<string, unknown>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await client.request(req as Parameters<typeof client.request>[0])) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/entryNotFound|not.*found|actMalformed|invalidParams/i.test(msg)) throw err;
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Every Credential object naming the account as either party, paginated,
 *  bounded by OWNER_WALK_BUDGET_MS. `complete` is false if the budget ran out
 *  before the owner directory was fully scanned. */
async function fetchAccountCredentials(
  address: string
): Promise<{ nodes: Record<string, unknown>[]; nowRipple: number; complete: boolean }> {
  const client = await connectMainnetOrThrow({ fastWalk: true });
  try {
    const nowRipple = await validatedLedgerCloseTimeRipple(client);
    const nodes: Record<string, unknown>[] = [];
    let marker: unknown = undefined;
    let complete = true;
    const deadline = Date.now() + OWNER_WALK_BUDGET_MS;
    do {
      const res = await requestWithRetry<{ result: { account_objects?: Record<string, unknown>[]; marker?: unknown } }>(client, {
        command: "account_objects",
        account: address,
        type: "credential",
        ledger_index: "validated",
        limit: 400,
        ...(marker ? { marker } : {}),
      });
      const result = res.result;
      nodes.push(...(result.account_objects ?? []));
      marker = result.marker;
      if (marker && Date.now() >= deadline) {
        complete = false;
        break;
      }
    } while (marker);
    return { nodes, nowRipple, complete };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export interface HeldCredentialsResult {
  credentials: LiveCredential[];
  /** false when the owner directory was too large to scan fully within budget. */
  complete: boolean;
}

/** Every credential where `address` is the Subject, with a completeness flag. */
export async function listCredentialsHeldByDetailed(address: string): Promise<HeldCredentialsResult> {
  const { nodes, nowRipple, complete } = await fetchAccountCredentials(address);
  return {
    credentials: nodes.filter((n) => String(n.Subject) === address).map((n) => toLiveCredential(n, nowRipple)),
    complete,
  };
}

/** Every credential where `address` is the Subject — held, pending or accepted.
 *  Back-compat shape (array only); use listCredentialsHeldByDetailed when the
 *  caller needs to know the walk was truncated. */
export async function listCredentialsHeldBy(address: string): Promise<LiveCredential[]> {
  return (await listCredentialsHeldByDetailed(address)).credentials;
}

/** Every credential `address` has issued, regardless of accept status. */
export async function listCredentialsIssuedBy(address: string): Promise<LiveCredential[]> {
  const { nodes, nowRipple } = await fetchAccountCredentials(address);
  return nodes
    .filter((n) => String(n.Issuer) === address)
    .map((n) => toLiveCredential(n, nowRipple));
}

// ── Targeted lookups (no owner-directory walk) ───────────────────────────────

export interface CredentialPair {
  issuer: string;
  /** hex OR ascii — normalized here. */
  credentialType: string;
}

/**
 * Direct ledger_entry lookups for specific (issuer, credentialType) pairs
 * against one subject. O(pairs), one connection, no owner-directory scan —
 * safe for any account regardless of how many trust lines it holds. This is
 * the correct primitive for "does X hold a credential from issuer Y" and for
 * domain eligibility (probe exactly the domain's AcceptedCredentials).
 */
export async function probeCredentials(
  subject: string,
  pairs: CredentialPair[]
): Promise<{ credentials: LiveCredential[]; nowRipple: number }> {
  if (pairs.length === 0) {
    const client = await connectMainnetOrThrow();
    try {
      return { credentials: [], nowRipple: await validatedLedgerCloseTimeRipple(client) };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
  const client = await connectMainnetOrThrow();
  try {
    const nowRipple = await validatedLedgerCloseTimeRipple(client);
    const seen = new Set<string>();
    const out: LiveCredential[] = [];
    for (const p of pairs) {
      const typeHex = /^[0-9A-Fa-f]+$/.test(p.credentialType)
        ? p.credentialType.toUpperCase()
        : convertStringToHex(p.credentialType).toUpperCase();
      const key = `${p.issuer}:${typeHex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const res = await requestWithRetry<{ result: { node?: Record<string, unknown> } }>(client, {
          command: "ledger_entry",
          ledger_index: "validated",
          credential: { subject, issuer: p.issuer, credential_type: typeHex },
        });
        const node = res.result.node ?? null;
        if (node) out.push(toLiveCredential(node, nowRipple));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/entryNotFound|not.*found/i.test(msg)) throw err;
      }
    }
    return { credentials: out, nowRipple };
  } finally {
    await client.disconnect().catch(() => {});
  }
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
      const res = await requestWithRetry<{ result: { node?: Record<string, unknown> } }>(client, {
        command: "ledger_entry",
        ledger_index: "validated",
        index: domainId,
      });
      node = res.result.node ?? null;
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
  heldCredentials: LiveCredential[];  // the domain's AcceptedCredentials that this subject actually holds (direct-probed)
  reason: string;
}

/**
 * Domain membership per XLS-80d: OR semantics — eligible if `address` holds
 * ANY ONE accepted, non-expired credential whose (Issuer, CredentialType)
 * matches ANY entry in the domain's AcceptedCredentials.
 */
export async function checkDomainEligibility(address: string, domainId: string): Promise<EligibilityResult> {
  const domain = await getDomain(domainId);

  if (!domain.found) {
    return {
      eligible: false, domain, address, satisfiedBy: null, heldCredentials: [],
      reason: "No PermissionedDomain exists at that DomainID on the validated ledger.",
    };
  }

  const accepts = domain.acceptedCredentials ?? [];
  // Probe exactly the domain's AcceptedCredentials against this subject with
  // direct ledger_entry lookups — no owner-directory walk, so this stays fast
  // and exact even for exchange-scale accounts. heldCredentials here is
  // therefore scoped to the pairs this domain actually gates on.
  const { credentials: heldCredentials } = await probeCredentials(
    address,
    accepts.map((a) => ({ issuer: a.issuer, credentialType: a.credentialType }))
  );

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
