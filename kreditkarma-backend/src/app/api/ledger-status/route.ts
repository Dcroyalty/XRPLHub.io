// src/app/api/ledger-status/route.ts
// GET /api/ledger-status — is the XRP Ledger closing ledgers right now? Drives the customer banner
// ("The XRP Ledger is paused right now. Nothing is lost — we'll send it as soon as it resumes.").
// state: ok | degraded (some of our nodes behind; customers unaffected) | halted (every node stale) | unreachable.
// Cached 30 s server-side (src/lib/xrplNodes.ts ledgerStatus) and 20 s at the edge. Free, no auth.

import { ledgerStatus } from "@/lib/xrplNodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET() {
  const st = await ledgerStatus();
  const customerFacing = st.state === "halted" || st.state === "unreachable";
  return Response.json(
    { state: st.state, paused: customerFacing, message: customerFacing ? st.message : null, ledgerAgeSec: st.ageSec, ledgerIndex: st.ledgerIndex, checkedAt: new Date(st.checkedAt).toISOString() },
    { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=40" } }
  );
}
