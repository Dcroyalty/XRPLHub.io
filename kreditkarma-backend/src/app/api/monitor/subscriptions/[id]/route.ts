// PATCH | DELETE /api/monitor/subscriptions/{id}
//   PATCH  { webhookUrl?, scoreDropPoints? (int | null), addAddresses?[≤25], removeAddresses?[], rotateSecret?, acknowledgement? }
//          A new webhookUrl is test-pinged first and, if it answers, re-enables a webhook_disabled subscription.
//          rotateSecret returns the new signing secret ONCE.
//   DELETE stops monitoring and removes the watchlist. Past observations and events are kept (append-only, attested).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/xrplscore";
import { authKey, err, ackRequired, ackOk, slotUsage, BATCH_CAP } from "@/lib/monitorApi";
import { CONSUMER_ACK_VERSION } from "@/lib/monitorCanon";
import { baselineSubjects, maxTotalSubjects } from "@/lib/monitorEngine";
import { checkWebhookUrl, generateWebhookSecret, sendPing } from "@/lib/monitorWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function owned(id: string, apiKeyId: string) {
  return prisma.monitorSubscription.findFirst({ where: { id, apiKeyId, status: { not: "deleted" } } });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const key = auth.key;
  const { id } = await params;
  const sub = await owned(id, key.id);
  if (!sub) return err(404, "not_found", "No such subscription on this key.");

  const body = (await req.json().catch(() => null)) as {
    webhookUrl?: unknown;
    scoreDropPoints?: unknown;
    addAddresses?: unknown;
    removeAddresses?: unknown;
    rotateSecret?: unknown;
    acknowledgement?: unknown;
  } | null;
  if (!body) return err(400, "bad_request", "Send a JSON body.");

  const data: Record<string, unknown> = {};
  let newSecret: string | null = null;

  if (body.scoreDropPoints !== undefined) {
    if (body.scoreDropPoints === null) data.scoreDropPoints = null;
    else {
      const n = Number(body.scoreDropPoints);
      if (!Number.isInteger(n) || n < 1 || n > 550) return err(400, "bad_request", "scoreDropPoints must be an integer from 1 to 550, or null to turn score_drop off.");
      data.scoreDropPoints = n;
    }
  }

  if (body.rotateSecret === true) {
    newSecret = generateWebhookSecret();
    data.webhookSecret = newSecret;
  }

  if (body.webhookUrl !== undefined) {
    if (typeof body.webhookUrl !== "string") return err(400, "bad_request", "webhookUrl must be a string.");
    const check = await checkWebhookUrl(body.webhookUrl);
    if (!check.ok) return err(400, "bad_webhook_url", check.reason);
    const ping = await sendPing(body.webhookUrl, newSecret ?? sub.webhookSecret, sub.id);
    if (!ping.ok) return err(400, "webhook_ping_failed", `The test ping was not answered with a 2xx (${ping.error ?? "no response"}). Nothing was changed.`);
    data.webhookUrl = body.webhookUrl;
    data.webhookFailures = 0;
    data.webhookDisabledAt = null;
    data.status = "active";
  }

  // ── watchlist changes ──
  const remove = Array.isArray(body.removeAddresses) ? [...new Set(body.removeAddresses.map((a) => String(a).trim()))] : [];
  let added: string[] = [];
  const addRaw = Array.isArray(body.addAddresses) ? [...new Set(body.addAddresses.map((a) => String(a).trim()))] : [];
  if (addRaw.length) {
    if (addRaw.length > BATCH_CAP) return err(400, "batch_too_large", `At most ${BATCH_CAP} addresses per call.`, { batchCap: BATCH_CAP });
    const invalid = addRaw.filter((a) => !isValidXrplAddress(a));
    if (invalid.length) return err(400, "bad_request", "Some addresses are not valid XRPL r-addresses.", { invalid: invalid.slice(0, 10) });
    if (sub.consumerAckVersion !== CONSUMER_ACK_VERSION && !ackOk(body)) return ackRequired();
    const already = await prisma.monitorSubject.findMany({ where: { address: { in: addRaw }, subscription: { apiKeyId: key.id, status: { not: "deleted" } } }, select: { address: true } });
    const have = new Set(already.map((a) => a.address));
    added = addRaw.filter((a) => !have.has(a));
    const usage = await slotUsage(key.id);
    const removingHere = remove.length; // best-effort: removals free slots first
    if (usage.used - removingHere + added.length > key.plan.watchSlots) {
      return err(403, "watch_slots_exceeded", `Your ${key.plan.name} plan allows ${key.plan.watchSlots} monitored wallets; ${usage.used} in use.`, { slotsMax: key.plan.watchSlots, slotsUsed: usage.used });
    }
    if (usage.total - removingHere + added.length > maxTotalSubjects()) {
      return err(503, "monitoring_capacity_reached", `Monitoring is capped at ${maxTotalSubjects()} watched wallets platform-wide and is full.`, { sharedLimit: maxTotalSubjects() });
    }
  }
  if (sub.consumerAckVersion !== CONSUMER_ACK_VERSION && ackOk(body)) {
    data.consumerAckAt = new Date();
    data.consumerAckVersion = CONSUMER_ACK_VERSION;
  }

  if (Object.keys(data).length) await prisma.monitorSubscription.update({ where: { id: sub.id }, data });
  if (remove.length) await prisma.monitorSubject.deleteMany({ where: { subscriptionId: sub.id, address: { in: remove } } });
  if (added.length) {
    const now = new Date();
    await prisma.monitorSubject.createMany({ data: added.map((address) => ({ subscriptionId: sub.id, address, nextCheckAt: now })), skipDuplicates: true });
    const rows = await prisma.monitorSubject.findMany({ where: { subscriptionId: sub.id, address: { in: added } }, select: { id: true } });
    await baselineSubjects(prisma, rows.map((r) => r.id), { deadlineMs: Date.now() + 42_000 });
  }

  const now = await prisma.monitorSubscription.findUnique({ where: { id: sub.id }, include: { subjects: true } });
  return NextResponse.json(
    {
      subscription: { id: sub.id, webhookUrl: now?.webhookUrl, status: now?.status, scoreDropPoints: now?.scoreDropPoints ?? null, watching: now?.subjects.length ?? 0 },
      ...(newSecret ? { webhookSecret: newSecret, webhookSecretNote: "Shown once. The previous secret no longer verifies." } : {}),
      added,
      removed: remove,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const sub = await owned(id, auth.key.id);
  if (!sub) return err(404, "not_found", "No such subscription on this key.");
  await prisma.$transaction([
    prisma.monitorSubject.deleteMany({ where: { subscriptionId: sub.id } }),
    prisma.monitorSubscription.update({ where: { id: sub.id }, data: { status: "deleted" } }),
  ]);
  return NextResponse.json({ deleted: true, id: sub.id, note: "Monitoring stopped. Past observations and events are retained (append-only)." }, { headers: { "Cache-Control": "no-store" } });
}
