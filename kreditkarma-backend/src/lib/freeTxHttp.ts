// src/lib/freeTxHttp.ts
// The free REST endpoint for the 35 transaction services: GET or POST /api/tx (the old /api/x402/tx URL serves the same
// handler, so existing clients keep working — it no longer asks for a payment).
//   GET  /api/tx?productId=<id>&account=r...[&<params>][&confirmCaution=true]
//   POST /api/tx { productId, account, params: {...}, confirmCaution? }
// 200 -> the unsigned txjson (every step, in order, for multi-step services) + signWith.
// 409 confirmation_required -> caution tier: show `irreversible` to the wallet owner, then repeat with confirmCaution=true.
// Rate-limited per client. See src/lib/freeTx.ts.

import { NextResponse } from "next/server";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { buildFreeTx, sanitizeParams, FREE_TX_NOTE } from "@/lib/freeTx";
import { TX_RESERVED_QUERY_KEYS } from "@/lib/txPurchase";

export const FREE_TX_RATE_PER_MIN = 30;

async function readRequest(req: Request) {
  const url = new URL(req.url);
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return { productId: String(b.productId ?? b.product_id ?? ""), account: String(b.account ?? b.wallet_address ?? "").trim(), params: sanitizeParams(b.params), confirmCaution: b.confirmCaution === true || b.confirm_caution === true };
  }
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) if (!TX_RESERVED_QUERY_KEYS.has(k.toLowerCase())) params[k] = v;
  return {
    productId: url.searchParams.get("productId") ?? "",
    account: (url.searchParams.get("account") ?? "").trim(),
    params: sanitizeParams(params),
    confirmCaution: url.searchParams.get("confirmCaution") === "true",
  };
}

export async function handleFreeTxRequest(req: Request): Promise<Response> {
  const rl = rateLimit(req, "free-tx", FREE_TX_RATE_PER_MIN, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const r = await readRequest(req);
  if (!r.productId) {
    return NextResponse.json({ error: "bad_request", message: "Provide productId (see /api/mcp list_xrpl_services) and account (r..., the signer).", free: true }, { status: 400 });
  }
  const out = await buildFreeTx({ productId: r.productId, account: r.account, params: r.params, confirmCaution: r.confirmCaution });
  if (!out.ok) {
    const { ok: _ok, status, ...body } = out;
    void _ok;
    return NextResponse.json({ ...body, free: true }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    {
      free: true,
      productId: out.productId,
      label: out.label,
      tier: out.tier,
      txjson: out.steps[0].txjson,
      ...(out.steps.length > 1 ? { transactions: out.steps } : {}),
      ...(out.notice ?? {}),
      signWith: out.signWith,
      instructions: "Check that every transaction's Account equals signWith, then sign with your own XRPL wallet and submit it (multi-step: in order, each validated before the next). " + FREE_TX_NOTE,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
