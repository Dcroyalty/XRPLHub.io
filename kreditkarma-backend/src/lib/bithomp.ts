// src/lib/bithomp.ts
// Minimal server-side Bithomp API client. Used only for the MPT-index
// cross-check in GET /api/mpt/:issuanceId — so a response can honestly say
// "not on the validated ledger, but Bithomp's index has it" rather than
// implying an issuance never existed.
//
// Free tier: 10 req/min, 2K/day. Key comes from BITHOMP_API_KEY (see .env).
// If the key is unset the lookup degrades to null — the route still works,
// it just can't add the Bithomp signal.

const BASE = "https://bithomp.com/api/v2";

export interface BithompMpt {
  mptokenIssuanceID: string;
  issuer: string;
  sequence?: number;
  currency?: string;
  outstandingAmount?: string;
  maximumAmount?: string | null;
  scale?: number | null;
  transferFee?: number | null;
  flags?: Record<string, boolean> | null;
  holders?: number;
  mptokens?: number;
  createdAt?: number;
  metadata?: Record<string, unknown> | null;
}

export function bithompConfigured(): boolean {
  return !!process.env.BITHOMP_API_KEY;
}

/**
 * Every MPT issuance Bithomp has for one issuer. The `?issuer=` filter is
 * free and (per Bithomp docs + our reconciliation) uncapped — `marker`
 * pagination past the first page is paid-tier only, so if `marker` comes back
 * the count is a floor. Returns null only on hard failure (the caller keeps
 * whatever it already had).
 */
export async function bithompMptsByIssuer(
  issuer: string,
  limit = 250
): Promise<{ issuances: BithompMpt[]; capped: boolean } | null> {
  const key = process.env.BITHOMP_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}/mptokens?issuer=${encodeURIComponent(issuer)}&limit=${limit}`, {
      headers: { "x-bithomp-token": key },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { error?: string; issuances?: BithompMpt[]; marker?: string };
    if (j.error) return null;
    return { issuances: j.issuances ?? [], capped: !!j.marker };
  } catch {
    return null;
  }
}

/**
 * Bithomp's newest MPT issuances across ALL issuers (first page, free). The
 * cheap way to discover an issuer we don't already know to ask about.
 */
export async function bithompRecentMpts(limit = 100): Promise<BithompMpt[] | null> {
  const key = process.env.BITHOMP_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}/mptokens?order=createdNew&limit=${limit}`, {
      headers: { "x-bithomp-token": key },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { error?: string; issuances?: BithompMpt[] };
    if (j.error) return null;
    return j.issuances ?? [];
  } catch {
    return null;
  }
}

/** Look one MPT issuance up in Bithomp's index by its MPTokenIssuanceID. */
export async function bithompMptLookup(issuanceId: string): Promise<BithompMpt | null> {
  const key = process.env.BITHOMP_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}/mpt/${encodeURIComponent(issuanceId)}`, {
      headers: { "x-bithomp-token": key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    if (j.error || !j.mptokenIssuanceID) return null;
    return j as unknown as BithompMpt;
  } catch {
    return null;
  }
}
