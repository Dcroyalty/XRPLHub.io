// src/lib/xrpPrice.ts
// Live XRP/USD spot for XRP-denominated checkout. Two independent sources;
// throws only if BOTH fail (caller then refuses XRP checkout and offers RLUSD).

async function coingecko(): Promise<number | null> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd",
      { signal: AbortSignal.timeout(6000), cache: "no-store" }
    );
    const j = (await r.json()) as { ripple?: { usd?: number } };
    const v = j?.ripple?.usd;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function coinbase(): Promise<number | null> {
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/XRP-USD/spot", {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    const j = (await r.json()) as { data?: { amount?: string } };
    const v = parseFloat(j?.data?.amount ?? "");
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** XRP/USD spot, or throws if every source is unreachable. */
export async function xrpUsd(): Promise<number> {
  const [a, b] = await Promise.all([coingecko(), coinbase()]);
  const rate = a ?? b;
  if (rate == null) throw new Error("XRP price unavailable from all sources");
  // Sanity band — refuse an obviously broken quote.
  if (rate < 0.05 || rate > 100) throw new Error(`XRP price out of sane range: ${rate}`);
  return rate;
}
