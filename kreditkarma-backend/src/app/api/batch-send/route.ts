// src/app/api/batch-send/route.ts
// POST { from, recipients: [{ address, amount, currency: "XRP"|"RLUSD", destinationTag?, label? }] } (2–8 recipients)
// BATCH SEND (src/lib/batchSend.ts): checks every payment against the live ledger first, then returns ONE unsigned
// all-or-nothing Batch (one Payment per recipient) plus a Xaman sign request. Everyone gets paid, or nobody does.
// FREE. XRPLHub never signs. The request is tied to the sender's next sequence numbers: sign it before sending anything
// else from that wallet (otherwise the ledger refuses it and nobody is paid).

import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { RLUSD_HEX, RLUSD_ISSUER } from "@/lib/pricing";
import { buildBatchSend, preflightBatch, validateRecipients } from "@/lib/batchSend";
import { mainnetRpc } from "@/lib/spendAutopay";
import { getAmendmentStatus } from "@/lib/amendments";
import { createPayload, safeIdentifier, xummConfigured } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const RLUSD = { issuer: RLUSD_ISSUER, hex: RLUSD_HEX };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const rl = rateLimit(req, "batch-send", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; recipients?: unknown };
  const from = String(b.from ?? "").trim();
  const v = validateRecipients(from, b.recipients);
  if (!v.ok) return json({ error: "bad_request", message: v.error ?? "Fix the highlighted payments.", problems: v.problems }, 400);

  // Amendment gate read at request time (never a build flag): Batch must be live on mainnet.
  const batch = await getAmendmentStatus("BatchV1_1");
  if (batch.state !== "active") return json({ error: "batch_unavailable", message: batch.state === "unknown" ? "Couldn't read the XRP Ledger just now. Try again in a minute." : "Batch payments aren't switched on on the XRP Ledger." }, 503);

  let pf;
  try { pf = await preflightBatch(mainnetRpc, from, v.recipients, RLUSD); } catch { return json({ error: "ledger_unavailable", message: "Couldn't read the XRP Ledger just now. Try again in a minute." }, 503); }
  if (!pf.ok) return json({ error: "would_fail", message: ("error" in pf && pf.error) || "Some payments can't go through. Nothing was built.", problems: pf.problems }, 422);

  const txjson = buildBatchSend(from, v.recipients, pf.sequence, pf.feeDrops, RLUSD);
  const label = `pay ${v.recipients.length} people at once${pf.totals.xrp ? ` · ${pf.totals.xrp} XRP` : ""}${pf.totals.rlusd ? ` · ${pf.totals.rlusd} RLUSD` : ""} — all or nothing`;
  let xaman: { uuid: string; qr_png: string | null; deep_link: string | null; websocket: string | null } | null = null;
  if (xummConfigured()) {
    try {
      const p = await createPayload({ txjson, identifier: safeIdentifier("xrplhub_batch_", from.slice(0, 12), `_${Date.now()}`), instruction: `XRPLHub Batch Send — ${label}. Free.` });
      xaman = { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, websocket: p.websocket ?? null };
    } catch { /* the txjson still works in any wallet that signs Batch */ }
  }
  return json({
    txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null, websocket: null }),
    totals: pf.totals, networkFeeXrp: pf.feeDrops / 1e6, payments: v.recipients.length, mode: "all_or_nothing", free: true,
    note: "Sign it before sending anything else from this wallet — it is tied to your next sequence numbers. If any payment can't go through, none of them is sent.",
  });
}
