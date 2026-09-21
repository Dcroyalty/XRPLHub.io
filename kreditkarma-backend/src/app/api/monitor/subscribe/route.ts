// POST /api/monitor/subscribe
// Register wallets to watch and one webhook endpoint for their events. API key required (a free key
// works, with a 3-wallet limit). The consumer-use acknowledgement is REQUIRED and stored with a timestamp.
//
//   { "addresses": ["r...", ...≤25], "webhookUrl": "https://...", "scoreDropPoints": 30,
//     "subscriptionId": "<add to an existing subscription>",
//     "acknowledgement": { "accepted": true, "version": "<from GET /api/monitor>" } }
//
// A test ping is sent to the webhook first; if it is not answered 2xx the subscription is NOT created.
// The signing secret is returned ONCE, in this response.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/xrplscore";
import { authKey, err, ackRequired, ackOk, capabilities, slotUsage, capacityRefusal, BATCH_CAP, SUBSCRIBES_PER_HOUR } from "@/lib/monitorApi";
import { CONSUMER_ACK_VERSION, MONITOR_DISCLAIMER } from "@/lib/monitorCanon";
import { baselineSubjects, maxTotalSubjects } from "@/lib/monitorEngine";
import { checkWebhookUrl, generateWebhookSecret, sendPing } from "@/lib/monitorWebhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const key = auth.key;

  const body = (await req.json().catch(() => null)) as {
    addresses?: unknown;
    webhookUrl?: unknown;
    scoreDropPoints?: unknown;
    subscriptionId?: unknown;
    acknowledgement?: unknown;
  } | null;
  if (!body) return err(400, "bad_request", "Send a JSON body.");
  if (!ackOk(body)) return ackRequired();

  // ── addresses ──
  if (!Array.isArray(body.addresses) || body.addresses.length === 0) return err(400, "bad_request", "addresses must be a non-empty array of XRPL r-addresses.");
  if (body.addresses.length > BATCH_CAP) return err(400, "batch_too_large", `At most ${BATCH_CAP} addresses per call.`, { batchCap: BATCH_CAP });
  const addresses = [...new Set(body.addresses.map((a) => String(a).trim()))];
  const invalid = addresses.filter((a) => !isValidXrplAddress(a));
  if (invalid.length) return err(400, "bad_request", "Some addresses are not valid XRPL r-addresses.", { invalid: invalid.slice(0, 10) });

  // ── threshold ──
  let scoreDropPoints: number | null = null;
  if (body.scoreDropPoints !== undefined && body.scoreDropPoints !== null) {
    const n = Number(body.scoreDropPoints);
    if (!Number.isInteger(n) || n < 1 || n > 550) return err(400, "bad_request", "scoreDropPoints must be an integer from 1 to 550 (or omitted: score_drop events are then off).");
    scoreDropPoints = n;
  }

  // ── existing subscription or a new one ──
  let existing: { id: string; webhookUrl: string } | null = null;
  if (body.subscriptionId !== undefined && body.subscriptionId !== null) {
    const s = await prisma.monitorSubscription.findFirst({ where: { id: String(body.subscriptionId), apiKeyId: key.id, status: { not: "deleted" } }, select: { id: true, webhookUrl: true } });
    if (!s) return err(404, "not_found", "No such subscription on this key.");
    existing = s;
  } else {
    if (typeof body.webhookUrl !== "string") return err(400, "bad_request", "webhookUrl (https) is required for a new subscription.");
    const recent = await prisma.monitorSubscription.count({ where: { apiKeyId: key.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (recent >= SUBSCRIBES_PER_HOUR) return err(429, "rate_limited", `At most ${SUBSCRIBES_PER_HOUR} new subscriptions per hour per key.`);
  }

  // ── skip wallets this key already watches ──
  const already = await prisma.monitorSubject.findMany({ where: { address: { in: addresses }, subscription: { apiKeyId: key.id, status: { not: "deleted" } } }, select: { address: true } });
  const alreadySet = new Set(already.map((a) => a.address));
  const fresh = addresses.filter((a) => !alreadySet.has(a));
  if (fresh.length === 0) return err(409, "already_watched", "Every address is already on this key's watchlist.", { alreadyWatched: [...alreadySet] });

  // ── slots + shared capacity ──
  const usage = await slotUsage(key.id);
  const slotMax = key.plan.watchSlots;
  if (usage.used + fresh.length > slotMax) {
    return err(403, "watch_slots_exceeded", `Your ${key.plan.name} plan allows ${slotMax} monitored wallets; ${usage.used} in use, ${fresh.length} requested.`, { slotsMax: slotMax, slotsUsed: usage.used, upgrade: "https://www.xrplhub.io/pricing" });
  }
  const cap = maxTotalSubjects();
  const refusal = await capacityRefusal(key, usage.total, fresh.length);
  if (refusal) return refusal;

  // ── webhook: validate + test ping BEFORE anything is created ──
  const secret = generateWebhookSecret();
  const url = existing ? existing.webhookUrl : String(body.webhookUrl);
  if (!existing) {
    const check = await checkWebhookUrl(url);
    if (!check.ok) return err(400, "bad_webhook_url", check.reason);
    const ping = await sendPing(url, secret, "pending");
    if (!ping.ok) return err(400, "webhook_ping_failed", `The test ping to your webhook was not answered with a 2xx (${ping.error ?? "no response"}). Nothing was created.`);
  }

  // ── create ──
  const now = new Date();
  let subscriptionId: string;
  if (existing) {
    subscriptionId = existing.id;
    if (body.scoreDropPoints !== undefined) await prisma.monitorSubscription.update({ where: { id: existing.id }, data: { scoreDropPoints } });
  } else {
    const created = await prisma.monitorSubscription.create({
      data: { apiKeyId: key.id, webhookUrl: url, webhookSecret: secret, scoreDropPoints, consumerAckAt: now, consumerAckVersion: CONSUMER_ACK_VERSION },
    });
    subscriptionId = created.id;
  }
  await prisma.monitorSubject.createMany({ data: fresh.map((address) => ({ subscriptionId, address, nextCheckAt: now })), skipDuplicates: true });
  const rows = await prisma.monitorSubject.findMany({ where: { subscriptionId, address: { in: fresh } }, select: { id: true, address: true } });

  // ── baseline observations, synchronously (bounded) ──
  await baselineSubjects(prisma, rows.map((r) => r.id), { deadlineMs: Date.now() + 42_000 });
  const after = await prisma.monitorSubject.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  const baselineObs = await prisma.monitorObservation.findMany({ where: { apiKeyId: key.id, subject: { in: fresh }, kind: "baseline" }, orderBy: { createdAt: "desc" }, select: { subject: true, observationId: true } });
  const obsBy = new Map<string, string>();
  for (const o of baselineObs) if (!obsBy.has(o.subject)) obsBy.set(o.subject, o.observationId);

  const sub = await prisma.monitorSubscription.findUnique({ where: { id: subscriptionId } });
  const usageAfter = await slotUsage(key.id);
  return NextResponse.json(
    {
      subscription: {
        id: subscriptionId,
        webhookUrl: sub?.webhookUrl,
        status: sub?.status,
        scoreDropPoints: sub?.scoreDropPoints ?? null,
        consumerAcknowledgement: { at: sub?.consumerAckAt.toISOString(), version: sub?.consumerAckVersion },
        createdAt: sub?.createdAt.toISOString(),
      },
      ...(existing ? {} : { webhookSecret: secret, webhookSecretNote: "Shown once. Store it now — it is used to verify X-XRPLHub-Signature on every delivery. Rotate with PATCH { rotateSecret: true }." }),
      subjects: after.map((s) => ({
        address: s.address,
        status: s.lastCheckedAt ? "baselined" : "pending",
        observationId: obsBy.get(s.address) ?? null,
        xrplScore: s.lastScore,
        sanctionListed: s.sanctionListed,
        lastCheckedAt: s.lastCheckedAt ? s.lastCheckedAt.toISOString() : null,
        nextCheckAt: s.nextCheckAt.toISOString(),
        note: s.lastCheckedAt ? undefined : "Baseline could not be completed yet (data unavailable or time budget); the next daily run will complete it.",
      })),
      skippedAlreadyWatched: [...alreadySet],
      capabilities: await capabilities(),
      scoreDrop: sub?.scoreDropPoints ? `active at ${sub.scoreDropPoints} points` : "off — set scoreDropPoints to enable (there is no default threshold)",
      limits: { slotsUsed: usageAfter.used, slotsMax: slotMax, batchCap: BATCH_CAP, sharedLimit: cap, cadence: "one check per wallet per day (not real-time)" },
      disclaimer: MONITOR_DISCLAIMER,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
