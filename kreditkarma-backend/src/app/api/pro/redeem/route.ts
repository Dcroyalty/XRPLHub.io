// src/app/api/pro/redeem/route.ts — after a Xaman Pro payment: POST { txHash, secret } → the uxus Pro key.
// Forwarded to uxus.finance/api/billing/xrpl-redeem, which reads the payment from the ledger and checks the secret.
import { NextResponse } from "next/server";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = rateLimit(req, "pro-redeem", 30, 10 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as { txHash?: unknown; secret?: unknown };
  try {
    const r = await fetch("https://uxus.finance/api/billing/xrpl-redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: b.txHash, secret: b.secret }), signal: AbortSignal.timeout(20_000), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    return NextResponse.json(j, { status: r.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "unreachable", message: "Couldn't reach the key service. Your payment is safe — try again in a minute." }, { status: 503 });
  }
}
