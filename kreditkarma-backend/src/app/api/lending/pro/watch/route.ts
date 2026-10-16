// src/app/api/lending/pro/watch/route.ts — XRPLHub Pro: webhook alerts when a vault's or broker's grade changes.
//   GET    list your watches
//   POST   { type: "vault"|"broker", id, webhookUrl }  → returns the signing secret ONCE
//   DELETE ?id=<watch id>
// Authorization: Bearer <uxus XRPLHub Pro key>. Webhooks are signed exactly like XRPLHub monitoring webhooks
// (X-XRPLHub-Signature: v1=HMAC-SHA256(secret, `${timestamp}.${body}`)), sent by the hourly job.
// Off until XRPL lending is enabled on mainnet.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { lendingLive } from "@/lib/lendingTracker";
import { lendingProAuth } from "@/lib/lendingPro";
import { checkWebhookUrl, generateWebhookSecret } from "@/lib/monitorWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WATCHES = 50;
const notLive = () => NextResponse.json({ error: "lending_not_live", message: "XRPL lending isn't enabled on mainnet yet. Track it at https://www.xrplhub.io/lending." }, { status: 503 });

export async function GET(req: Request) {
  if (!(await lendingLive())) return notLive();
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  const rows = await prisma.lendingAlertWatch.findMany({ where: { apiKeyHash: auth.keyHash, subjectType: { in: ["vault", "broker"] } }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ watches: rows.map((w) => ({ id: w.id, type: w.subjectType, subjectId: w.subjectId, webhookUrl: w.webhookUrl, lastNotifiedGrade: w.lastNotifiedGrade, lastNotifiedAt: w.lastNotifiedAt })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!(await lendingLive())) return notLive();
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  let b: { type?: unknown; id?: unknown; webhookUrl?: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad_request", message: "Send JSON." }, { status: 400 }); }
  const type = b.type, id = String(b.id ?? "").toUpperCase(), url = String(b.webhookUrl ?? "");
  if ((type !== "vault" && type !== "broker") || !/^[0-9A-F]{64}$/.test(id)) return NextResponse.json({ error: "bad_request", message: "type must be vault or broker, and id a 64-hex ledger ID." }, { status: 400 });
  const check = await checkWebhookUrl(url);
  if (!check.ok) return NextResponse.json({ error: "bad_webhook_url", message: check.reason }, { status: 400 });
  if ((await prisma.lendingAlertWatch.count({ where: { apiKeyHash: auth.keyHash } })) >= MAX_WATCHES) {
    return NextResponse.json({ error: "too_many_watches", message: `Up to ${MAX_WATCHES} watches per key.` }, { status: 409 });
  }
  const latest = await prisma.lendingGrade.findFirst({ where: { network: "mainnet", subjectType: type, subjectId: id }, orderBy: { takenAt: "desc" }, select: { grade: true } });
  const secret = generateWebhookSecret();
  const w = await prisma.lendingAlertWatch.upsert({
    where: { apiKeyHash_subjectType_subjectId: { apiKeyHash: auth.keyHash, subjectType: type, subjectId: id } },
    // Start from the current grade, so the first webhook is a real change, not "it has a grade".
    create: { apiKeyHash: auth.keyHash, subjectType: type, subjectId: id, webhookUrl: check.url.toString(), secret, lastNotifiedGrade: latest?.grade ?? null },
    update: { webhookUrl: check.url.toString(), secret },
  });
  return NextResponse.json({ id: w.id, type, subjectId: id, webhookUrl: w.webhookUrl, secret, currentGrade: latest?.grade ?? null, note: "Store the secret now — it is not shown again. Verify X-XRPLHub-Signature on every webhook." }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  if (!(await lendingLive())) return notLive();
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = await prisma.lendingAlertWatch.deleteMany({ where: { id, apiKeyHash: auth.keyHash } });
  return NextResponse.json({ deleted: r.count }, { headers: { "Cache-Control": "no-store" } });
}
