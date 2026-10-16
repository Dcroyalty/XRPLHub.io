// src/app/api/yield/pro/watch/route.ts — XRPLHub Pro: webhook alerts when a Yield Desk risk grade changes.
//   GET    list your yield watches
//   POST   { slug, webhookUrl }  → returns the signing secret ONCE
//   DELETE ?id=<watch id>
// Authorization: Bearer <uxus XRPLHub Pro key>. Webhooks are signed like every XRPLHub webhook
// (X-XRPLHub-Signature: v1=HMAC-SHA256(secret, `${timestamp}.${body}`)) and sent by the hourly refresh.
// Stored in LendingAlertWatch with subjectType "yield" (one table for all Pro alerts).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { lendingProAuth } from "@/lib/lendingPro";
import { checkWebhookUrl, generateWebhookSecret } from "@/lib/monitorWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WATCHES = 50;

export async function GET(req: Request) {
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  const rows = await prisma.lendingAlertWatch.findMany({ where: { apiKeyHash: auth.keyHash, subjectType: "yield" }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ watches: rows.map((w) => ({ id: w.id, slug: w.subjectId, webhookUrl: w.webhookUrl, lastNotifiedGrade: w.lastNotifiedGrade, lastNotifiedAt: w.lastNotifiedAt })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  let b: { slug?: unknown; webhookUrl?: unknown };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "bad_request", message: "Send JSON." }, { status: 400 }); }
  const slug = String(b.slug ?? "");
  if (!/^[a-z0-9-]{3,90}$/.test(slug) || !(await prisma.yieldOption.findUnique({ where: { slug }, select: { slug: true } }))) {
    return NextResponse.json({ error: "bad_request", message: "slug must be an option from https://www.xrplhub.io/api/yield/options." }, { status: 400 });
  }
  const check = await checkWebhookUrl(String(b.webhookUrl ?? ""));
  if (!check.ok) return NextResponse.json({ error: "bad_webhook_url", message: check.reason }, { status: 400 });
  if ((await prisma.lendingAlertWatch.count({ where: { apiKeyHash: auth.keyHash } })) >= MAX_WATCHES) {
    return NextResponse.json({ error: "too_many_watches", message: `Up to ${MAX_WATCHES} watches per key (yield and lending together).` }, { status: 409 });
  }
  const latest = await prisma.yieldGrade.findFirst({ where: { slug }, orderBy: { takenAt: "desc" }, select: { grade: true } });
  const secret = generateWebhookSecret();
  const w = await prisma.lendingAlertWatch.upsert({
    where: { apiKeyHash_subjectType_subjectId: { apiKeyHash: auth.keyHash, subjectType: "yield", subjectId: slug } },
    // Start from the current grade, so the first webhook is a real change.
    create: { apiKeyHash: auth.keyHash, subjectType: "yield", subjectId: slug, webhookUrl: check.url.toString(), secret, lastNotifiedGrade: latest?.grade ?? null },
    update: { webhookUrl: check.url.toString(), secret },
  });
  return NextResponse.json({ id: w.id, slug, webhookUrl: w.webhookUrl, secret, currentGrade: latest?.grade ?? null, note: "Store the secret now — it is not shown again. Verify X-XRPLHub-Signature on every webhook." }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: Request) {
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const r = await prisma.lendingAlertWatch.deleteMany({ where: { id, apiKeyHash: auth.keyHash, subjectType: "yield" } });
  return NextResponse.json({ deleted: r.count }, { headers: { "Cache-Control": "no-store" } });
}
