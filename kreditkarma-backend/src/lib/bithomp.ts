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
  currency?: string;
  outstandingAmount?: string;
  holders?: number;
  createdAt?: number;
  metadata?: Record<string, unknown> | null;
}

export function bithompConfigured(): boolean {
  return !!process.env.BITHOMP_API_KEY;
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
