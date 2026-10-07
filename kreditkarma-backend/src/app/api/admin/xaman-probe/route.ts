// src/app/api/admin/xaman-probe/route.ts
// TEMPORARY (2026-10-07) — admin-only research probe for Spend Controls "Autopay". Answers two questions Xaman's docs
// leave open, by looking at what Xaman actually signs:
//   1. If txjson has NO LastLedgerSequence, does the signed blob (submit:false) still get one?
//   2. If txjson has Sequence 0 + TicketSequence, does Xaman keep them, or overwrite Sequence?
// Both payloads are submit:false — Xaman signs and returns the blob, nothing is sent to the ledger. The payment is
// 1 drop (0.000001 XRP). The Ticket probe uses TicketSequence 1, which can never exist on a modern mainnet account
// (tickets are taken from the account's CURRENT sequence onward), so that blob can never be applied.
// Remove this route when the probe is done.

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/adminAuth";
import { xummFetch } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEST = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f"; // XRPLHub credential issuer — receives the 1 drop only if ever submitted (it won't be)
const PROBES: Record<string, Record<string, unknown>> = {
  ticket: { TransactionType: "Payment", Destination: DEST, Amount: "1", Sequence: 0, TicketSequence: 1 },
  plain: { TransactionType: "Payment", Destination: DEST, Amount: "1" },
};

export async function POST(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { kind } = (await req.json().catch(() => ({}))) as { kind?: string };
  const txjson = PROBES[String(kind)];
  if (!txjson) return NextResponse.json({ error: "kind must be ticket or plain" }, { status: 400 });
  const res = await xummFetch("https://xumm.app/api/v1/platform/payload", {
    method: "POST",
    body: JSON.stringify({
      txjson,
      options: { submit: false, expire: 120, force_network: "MAINNET" },
      custom_meta: {
        identifier: `xrplhub_probe_${kind}_${Date.now()}`.slice(0, 40),
        instruction: `XRPLHub TEST (${kind}) — signs only, is NOT submitted. 0.000001 XRP. Research for Spend Controls autopay.`,
      },
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d?.uuid) return NextResponse.json({ error: "xaman_rejected", status: res.status, detail: d?.error ?? d }, { status: 502 });
  return NextResponse.json({ kind, uuid: d.uuid, deepLink: d.next?.always, qr: d.refs?.qr_png, txjsonSent: txjson });
}

export async function GET(req: Request) {
  if (!isAdmin(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const uuid = new URL(req.url).searchParams.get("uuid") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return NextResponse.json({ error: "uuid" }, { status: 400 });
  const res = await xummFetch(`https://xumm.app/api/v1/platform/payload/${uuid}`, { method: "GET" });
  const d = await res.json().catch(() => ({}));
  const id = String(d?.custom_meta?.identifier ?? "");
  if (!id.startsWith("xrplhub_probe_")) return NextResponse.json({ error: "not a probe payload" }, { status: 403 });
  return NextResponse.json({
    identifier: id,
    meta: { signed: d?.meta?.signed, resolved: d?.meta?.resolved, cancelled: d?.meta?.cancelled, expired: d?.meta?.expired, submit: d?.meta?.submit },
    account: d?.response?.account ?? null,
    hex: d?.response?.hex ?? null,
    txid: d?.response?.txid ?? null,
    dispatched: d?.response?.dispatched_result ?? null,
  });
}
