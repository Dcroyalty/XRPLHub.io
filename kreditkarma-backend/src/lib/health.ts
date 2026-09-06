// src/lib/health.ts
// One place that answers "is the money path working" — the checks GET
// /api/health reports and the daily cron alerts on. Every probe is wrapped so
// the health check itself can never throw.

import { prisma } from "@/lib/xrplscore-db";
import { xummConfigured } from "@/lib/xumm";
import { facilitatorSupported } from "@/lib/x402";
import { alertingArmed } from "@/lib/notify";

export type Level = "ok" | "warn" | "down";

export interface Check {
  name: string;
  level: Level;
  detail: string;
}

export interface HealthReport {
  overall: Level;
  checks: Check[];
  reds: Check[]; // level === "down"
  ambers: Check[]; // level === "warn"
  at: string;
}

async function timed<T>(fn: () => Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function checkDb(): Promise<Check> {
  try {
    await timed(() => prisma.$queryRaw`SELECT 1`);
    return { name: "database", level: "ok", detail: "Neon reachable" };
  } catch (e) {
    return { name: "database", level: "down", detail: e instanceof Error ? e.message : "unreachable" };
  }
}

function checkXumm(): Check {
  // Config presence only — a live ping would burn the 429 budget. The loud
  // "keys are actually bad" signal comes from lib/xumm createPayload -> notifyError.
  return xummConfigured()
    ? { name: "xumm", level: "ok", detail: "XUMM_API_KEY + SECRET set (live validity alerts via createPayload)" }
    : { name: "xumm", level: "down", detail: "XUMM_API_KEY / XUMM_API_SECRET missing — every Xaman payment + free-key SignIn is down" };
}

async function checkT54(deep: boolean): Promise<Check> {
  if (!deep) return { name: "x402-t54", level: "ok", detail: "t54 facilitator (deep probe skipped — pass ?deep=1)" };
  try {
    const r = await timed(() => facilitatorSupported());
    if (r.ok) return { name: "x402-t54", level: "ok", detail: "t54 facilitator /supported OK" };
    return { name: "x402-t54", level: "down", detail: `t54 facilitator /supported -> HTTP ${r.status}${r.error ? " " + r.error : ""}` };
  } catch (e) {
    return { name: "x402-t54", level: "down", detail: e instanceof Error ? e.message : "unreachable" };
  }
}

async function checkCdp(deep: boolean): Promise<Check> {
  const idSet = !!process.env.CDP_API_KEY_ID;
  const secretSet = !!process.env.CDP_API_KEY_SECRET;
  if (!idSet || !secretSet) {
    return { name: "x402-cdp", level: "down", detail: "CDP_API_KEY_ID / CDP_API_KEY_SECRET missing — USDC-on-Base checkout + x402 USDC routes can't settle" };
  }
  if (!deep) return { name: "x402-cdp", level: "ok", detail: "CDP keys set (deep probe skipped — pass ?deep=1)" };
  // Unauthenticated liveness of the CDP facilitator host. A 400/401/403 all
  // mean "the service is up" (auth happens per-request inside withX402); only a
  // network failure or 5xx is a real outage. Gated behind `deep` so a 1/min
  // uptime monitor doesn't hammer CDP with rejected probes.
  try {
    const res = await timed(() =>
      fetch("https://api.cdp.coinbase.com/platform/v2/x402/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(7000),
      })
    );
    if (res.status >= 500 || res.status === 0) {
      return { name: "x402-cdp", level: "down", detail: `CDP facilitator -> HTTP ${res.status}` };
    }
    return { name: "x402-cdp", level: "ok", detail: `CDP keys set; facilitator reachable (HTTP ${res.status})` };
  } catch (e) {
    return { name: "x402-cdp", level: "down", detail: `CDP facilitator unreachable: ${e instanceof Error ? e.message : "error"}` };
  }
}

async function checkAnchor(): Promise<Check> {
  const enabled = process.env.MPT_ANCHOR_ENABLED === "true";
  const keyed = !!process.env.CREDENTIAL_ISSUER_SEED;
  if (enabled && !keyed) {
    return { name: "mpt-anchor", level: "down", detail: "MPT_ANCHOR_ENABLED=true but CREDENTIAL_ISSUER_SEED is not set — anchor fails every run" };
  }
  try {
    const lastFail = await prisma.mptAnchor.findFirst({
      where: { status: { in: ["failed", "misconfigured"] } },
      orderBy: { createdAt: "desc" },
    });
    const lastAnchor = await prisma.mptAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } });
    if (lastFail && (!lastAnchor || lastFail.createdAt > lastAnchor.createdAt)) {
      return { name: "mpt-anchor", level: enabled ? "down" : "warn", detail: `last anchor attempt ${lastFail.status}: ${lastFail.error ?? "no detail"}` };
    }
    if (!enabled) return { name: "mpt-anchor", level: "warn", detail: "anchoring disabled (MPT_ANCHOR_ENABLED not set)" };
    return { name: "mpt-anchor", level: "ok", detail: lastAnchor ? `last anchored at ledger ${lastAnchor.ledgerIndex}` : "enabled, no anchor yet" };
  } catch (e) {
    return { name: "mpt-anchor", level: "warn", detail: e instanceof Error ? e.message : "check failed" };
  }
}

function checkCredentialSigning(): Check {
  return process.env.CREDENTIAL_SIGNING_SECRET
    ? { name: "credential-signing", level: "ok", detail: "CREDENTIAL_SIGNING_SECRET set — paid certificates are cryptographically binding" }
    : { name: "credential-signing", level: "down", detail: "CREDENTIAL_SIGNING_SECRET NOT set — paid signed certificates issue but are NOT binding" };
}

function checkAlerting(): Check {
  return alertingArmed()
    ? { name: "alerting", level: "ok", detail: "ERROR_WEBHOOK_URL set — failures reach a webhook" }
    : { name: "alerting", level: "warn", detail: "ERROR_WEBHOOK_URL not set — failures only reach Vercel logs (1h retention on Hobby)" };
}

function checkCron(): Check {
  return process.env.CRON_SECRET
    ? { name: "cron-auth", level: "ok", detail: "CRON_SECRET set — scheduled jobs can authenticate" }
    : { name: "cron-auth", level: "down", detail: "CRON_SECRET not set — both cron jobs 401 and do nothing" };
}

export async function healthProbe(opts: { deep?: boolean } = {}): Promise<HealthReport> {
  const deep = opts.deep ?? false;
  const checks: Check[] = [];
  const settled = await Promise.allSettled([checkDb(), checkT54(deep), checkCdp(deep), checkAnchor()]);
  for (const s of settled) {
    if (s.status === "fulfilled") checks.push(s.value);
    else checks.push({ name: "unknown", level: "warn", detail: String(s.reason) });
  }
  checks.push(checkXumm(), checkCredentialSigning(), checkAlerting(), checkCron());

  const reds = checks.filter((c) => c.level === "down");
  const ambers = checks.filter((c) => c.level === "warn");
  return {
    overall: reds.length ? "down" : ambers.length ? "warn" : "ok",
    checks,
    reds,
    ambers,
    at: new Date().toISOString(),
  };
}
