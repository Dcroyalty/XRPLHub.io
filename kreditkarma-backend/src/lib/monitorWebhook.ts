// src/lib/monitorWebhook.ts
// Outbound webhooks for the monitoring service: signed, SSRF-hardened, retried from an outbox.
//
// SSRF hardening (a webhook URL is attacker-controlled input that we will POST to):
//   • https only, hostname only (no IP literals), no credentials, port 443 only
//   • the hostname is resolved HERE and every returned address must be public; the socket
//     then connects to that VALIDATED address (custom `lookup`), so a DNS answer that changes
//     between check and connect (rebinding) cannot redirect us to an internal host. TLS SNI /
//     certificate validation still use the hostname.
//   • redirects are never followed (a 3xx is a failed delivery), 5s timeout, 16KB response cap,
//     64KB request cap
// Signing: X-XRPLHub-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)> with
// X-XRPLHub-Timestamp (unix seconds). Receivers should reject timestamps older than 5 minutes and
// de-duplicate on X-XRPLHub-Event-Id (retries reuse the id).

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { BlockList, isIP } from "net";
import { lookup as dnsLookup } from "dns/promises";
import https from "https";
import type { PrismaClient } from "@prisma/client";
import { notifyError } from "./notify";
import { MONITOR_DISCLAIMER } from "./monitorCanon";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_BODY = 64 * 1024;
export const WEBHOOK_MAX_RESPONSE = 16 * 1024;
export const MAX_DELIVERY_ATTEMPTS = 6;
/** Consecutive failed delivery ATTEMPTS (across events) before the webhook is auto-disabled. */
export const DISABLE_AFTER_FAILURES = 8;
/** Minimum wait before retrying an event, by attempts already made. Crons run twice a day, so the
 *  effective retry cadence is the next cron window after this elapses. */
const BACKOFF_MS = [0, 30 * 60_000, 3 * 3_600_000, 8 * 3_600_000, 20 * 3_600_000, 20 * 3_600_000];

// ── Address allow-check ──────────────────────────────────────────────────────
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as Array<[string, number]>) blocked.addSubnet(net, prefix, "ipv6");

/** True only for a globally-routable unicast address. IPv4-mapped IPv6 is unwrapped and checked as IPv4. */
export function isPublicAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPublicAddress(mapped[1]);
  const fam = isIP(addr);
  if (fam === 4) return !blocked.check(addr, "ipv4");
  if (fam === 6) return !blocked.check(addr, "ipv6");
  return false;
}

export type UrlCheck = { ok: true; url: URL; addresses: Array<{ address: string; family: 4 | 6 }> } | { ok: false; reason: string };

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Validate a webhook URL and resolve it. `resolver` is injectable for tests. */
export async function checkWebhookUrl(raw: string, resolver: Resolver = defaultResolver): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "webhookUrl is not a valid URL" };
  }
  if (raw.length > 512) return { ok: false, reason: "webhookUrl is too long (512 max)" };
  if (url.protocol !== "https:") return { ok: false, reason: "webhookUrl must be https" };
  if (url.username || url.password) return { ok: false, reason: "webhookUrl must not contain credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "webhookUrl must use the default https port (443)" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { ok: false, reason: "webhookUrl must use a hostname, not an IP address" };
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host)) {
    return { ok: false, reason: "webhookUrl host is not a public hostname" };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolver(host);
  } catch {
    return { ok: false, reason: "webhookUrl host did not resolve" };
  }
  if (!addrs.length) return { ok: false, reason: "webhookUrl host did not resolve" };
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) return { ok: false, reason: "webhookUrl resolves to a non-public address" };
  }
  return { ok: true, url, addresses: addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })) };
}

// ── Signing ──────────────────────────────────────────────────────────────────
export function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64url");
}

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Receiver-side helper (documented for integrators, used in tests). */
export function verifyWebhookSignature(secret: string, timestamp: number, body: string, signature: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ── One POST ─────────────────────────────────────────────────────────────────
export interface PostResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<PostResult>;

/**
 * A `dns.lookup`-compatible function that always answers with the one address we validated. Node calls it with
 * `{ all: true }` when address auto-selection is on (the default since Node 20) and then expects an ARRAY of
 * `{ address, family }`; with `all` unset it expects `(err, address, family)`. Answering the wrong shape fails
 * the connection with "Invalid IP address: undefined".
 */
export function makePinnedLookup(address: string, family: 4 | 6) {
  return (_host: string, options: unknown, cb: unknown): void => {
    const callback = (typeof options === "function" ? options : cb) as (...a: unknown[]) => void;
    const opts = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean };
    if (opts.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** POST to a validated webhook, connecting to the address we validated. Never follows redirects. */
export const postWebhook: Poster = async (rawUrl, body, headers) => {
  if (Buffer.byteLength(body) > WEBHOOK_MAX_BODY) return { ok: false, status: null, error: "payload too large" };
  const check = await checkWebhookUrl(rawUrl);
  if (!check.ok) return { ok: false, status: null, error: check.reason };
  const pinned = check.addresses[0];
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const done = (r: PostResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = https.request(
      {
        method: "POST",
        hostname: check.url.hostname,
        port: 443,
        path: check.url.pathname + check.url.search,
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        timeout: WEBHOOK_TIMEOUT_MS,
        // connect to the address we validated, whatever DNS says now
        lookup: makePinnedLookup(pinned.address, pinned.family),
      },
      (res) => {
        let got = 0;
        res.on("data", (c: Buffer) => {
          got += c.length;
          if (got > WEBHOOK_MAX_RESPONSE) res.destroy();
        });
        res.on("end", () => finish());
        res.on("close", () => finish());
        res.on("error", () => finish());
        function finish() {
          const s = res.statusCode ?? 0;
          if (s >= 200 && s < 300) return done({ ok: true, status: s });
          if (s >= 300 && s < 400) return done({ ok: false, status: s, error: "redirects are not followed" });
          done({ ok: false, status: s, error: `HTTP ${s}` });
        }
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, status: null, error: "timed out" });
    });
    req.on("error", (e) => done({ ok: false, status: null, error: e.message.slice(0, 120) }));
    req.write(body);
    req.end();
  });
};

export function webhookHeaders(secret: string, eventId: string, eventType: string, attempt: number, body: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "XRPLHub-Monitor/1",
    "x-xrplhub-event": eventType,
    "x-xrplhub-event-id": eventId,
    "x-xrplhub-delivery-attempt": String(attempt),
    "x-xrplhub-timestamp": String(nowSec),
    "x-xrplhub-signature": signWebhook(secret, nowSec, body),
  };
}

/** Test ping sent on subscribe and when the URL changes. */
export async function sendPing(url: string, secret: string, subscriptionRef: string, poster: Poster = postWebhook): Promise<PostResult> {
  const id = "evt_ping_" + randomBytes(8).toString("hex");
  const body = JSON.stringify({
    id,
    type: "ping",
    createdAt: new Date().toISOString(),
    subscriptionId: subscriptionRef,
    data: { message: "XRPLHub monitoring webhook test. Respond 2xx to confirm delivery." },
  });
  return poster(url, body, webhookHeaders(secret, id, "ping", 1, body));
}

// ── Outbox delivery ──────────────────────────────────────────────────────────
export interface DeliveryStats {
  considered: number;
  delivered: number;
  failed: number;
  gaveUp: number;
  skippedDisabled: number;
  disabledSubscriptions: number;
}

/** Deliver due outbox events until `deadlineMs` (epoch ms). Safe to call from either cron. */
export async function deliverDueEvents(
  prisma: PrismaClient,
  opts: { deadlineMs: number; poster?: Poster; now?: () => Date; onlySubscriptionIds?: string[] } = { deadlineMs: Date.now() + 8_000 }
): Promise<DeliveryStats> {
  const poster = opts.poster ?? postWebhook;
  const now = opts.now ?? (() => new Date());
  const stats: DeliveryStats = { considered: 0, delivered: 0, failed: 0, gaveUp: 0, skippedDisabled: 0, disabledSubscriptions: 0 };

  const due = await prisma.monitorEvent.findMany({
    where: { state: "pending", nextAttemptAt: { lte: now() }, ...(opts.onlySubscriptionIds ? { subscriptionId: { in: opts.onlySubscriptionIds } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { subscription: true },
  });

  const disabledNow = new Set<string>();
  for (const ev of due) {
    if (Date.now() > opts.deadlineMs) break;
    stats.considered++;
    const sub = ev.subscription;
    if (sub.status !== "active" || disabledNow.has(sub.id)) {
      stats.skippedDisabled++;
      continue;
    }
    const body = JSON.stringify({
      id: ev.id,
      type: ev.type,
      createdAt: ev.createdAt.toISOString(),
      subscriptionId: sub.id,
      subject: ev.subject,
      observationId: ev.observationId,
      data: ev.payload,
      verify: ev.observationId ? `https://www.xrplhub.io/api/attest/verify?queryId=${ev.observationId}` : null,
      disclaimer: MONITOR_DISCLAIMER,
    });
    const attempt = ev.attempts + 1;
    let res: PostResult;
    try {
      res = await poster(sub.webhookUrl, body, webhookHeaders(sub.webhookSecret, ev.id, ev.type, attempt, body));
    } catch (e) {
      res = { ok: false, status: null, error: e instanceof Error ? e.message.slice(0, 120) : "delivery threw" };
    }

    if (res.ok) {
      stats.delivered++;
      await prisma.$transaction([
        prisma.monitorEvent.update({
          where: { id: ev.id },
          data: { state: "delivered", attempts: attempt, deliveredAt: now(), lastStatus: res.status, lastError: null },
        }),
        prisma.monitorSubscription.update({ where: { id: sub.id }, data: { webhookFailures: 0 } }),
      ]);
      continue;
    }

    stats.failed++;
    const gaveUp = attempt >= MAX_DELIVERY_ATTEMPTS;
    if (gaveUp) stats.gaveUp++;
    await prisma.monitorEvent.update({
      where: { id: ev.id },
      data: {
        attempts: attempt,
        lastStatus: res.status,
        lastError: (res.error ?? "failed").slice(0, 200),
        state: gaveUp ? "failed" : "pending",
        nextAttemptAt: new Date(now().getTime() + BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]),
      },
    });
    // Atomic increment: several events for one subscription can fail in the same batch, and a stale
    // in-memory count would under-count and delay the auto-disable.
    const updated = await prisma.monitorSubscription.update({ where: { id: sub.id }, data: { webhookFailures: { increment: 1 } } });
    if (updated.webhookFailures >= DISABLE_AFTER_FAILURES && updated.status === "active") {
      await prisma.monitorSubscription.update({ where: { id: sub.id }, data: { status: "webhook_disabled", webhookDisabledAt: now() } });
      stats.disabledSubscriptions++;
      disabledNow.add(sub.id);
      // loud: an operator wants to know a customer's webhook died
      await notifyError("monitor webhook auto-disabled", new Error(`subscription ${sub.id} disabled after ${updated.webhookFailures} consecutive failed deliveries`), {
        subscriptionId: sub.id,
        apiKeyId: sub.apiKeyId,
        lastError: res.error,
      });
    }
  }
  return stats;
}
