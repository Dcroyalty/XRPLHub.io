// src/lib/mptHolders.ts
// MPT holder counts read from the LEDGER — Clio's `mpt_holders` (s1/s2.ripple.com run Clio; plain rippled answers
// unknownCmd, so this deliberately does NOT go through the general xrplNodes pool). Replaced the Bithomp-reported
// count on 2026-10-06: Bithomp's free key is non-commercial.
//
// The count is the number of MPToken objects (holders who opted in) with a NON-ZERO public balance. Opted-in
// accounts holding 0 are not counted. Confidential issuances are never counted (balances are encrypted) — callers
// skip them; see holderData() in mptIndex.ts.

const CLIO_RPC = ["https://s1.ripple.com:51234", "https://s2.ripple.com:51234"] as const;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 25; // 25k holders; beyond that we report "unknown" rather than a partial number

export interface MptHolderCount {
  count: number;        // holders with a non-zero balance
  optedIn: number;      // all MPToken objects, including zero balances
  ledgerIndex: number | null;
}

async function clio(params: Record<string, unknown>, node: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "mpt_holders", params: [params] }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: Record<string, unknown> };
    const res = j.result ?? null;
    if (!res || res.status !== "success") return null;
    return res;
  } catch {
    return null;
  }
}

/** Live holder count for one issuance, or null if no Clio node could answer completely. Never throws. */
export async function mptHolderCount(issuanceId: string): Promise<MptHolderCount | null> {
  for (const node of CLIO_RPC) {
    let marker: unknown = undefined;
    let ledgerIndex: number | null = null;
    let count = 0;
    let optedIn = 0;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await clio({
        mpt_issuance_id: issuanceId,
        limit: PAGE_LIMIT,
        // Pin later pages to the first page's ledger so the count is one consistent snapshot.
        ...(ledgerIndex != null ? { ledger_index: ledgerIndex } : { ledger_index: "validated" }),
        ...(marker !== undefined ? { marker } : {}),
      }, node);
      if (!res) break;
      if (ledgerIndex == null && typeof res.ledger_index === "number") ledgerIndex = res.ledger_index;
      const holders = Array.isArray(res.mptokens) ? (res.mptokens as Array<{ mpt_amount?: string }>) : [];
      for (const h of holders) {
        optedIn++;
        if (h.mpt_amount && h.mpt_amount !== "0") count++;
      }
      marker = res.marker;
      if (marker === undefined || marker === null) { complete = true; break; }
    }
    if (complete) return { count, optedIn, ledgerIndex };
  }
  return null;
}
