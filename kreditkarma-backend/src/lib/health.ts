// src/lib/health.ts
// One place that answers "is the money path working" — the checks GET
// /api/health reports and the daily cron alerts on. Every probe is wrapped so
// the health check itself can never throw.

import { prisma } from "@/lib/xrplscore-db";
import { xummConfigured, xummPing } from "@/lib/xumm";
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

// The external probes (Xaman, t54, CDP) make a real call each time they run. This endpoint is public, so results are kept
// per server instance for PROBE_TTL_MS: an uptime monitor gets a real answer at most once a minute per instance and a
// stranger cannot turn this URL into a way to hammer those services. `force` (the cron, or an admin) bypasses the cache.
const PROBE_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; check: Check }>();
async function probed(name: string, force: boolean, run: () => Promise<Check>): Promise<Check> {
  const hit = probeCache.get(name);
  if (!force && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.check;
  const check = await run();
  probeCache.set(name, { at: Date.now(), check });
  return check;
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

async function checkXumm(force: boolean): Promise<Check> {
  if (!xummConfigured()) {
    return { name: "xumm", level: "down", detail: "XUMM_API_KEY / XUMM_API_SECRET missing — every Xaman payment + free-key SignIn is down" };
  }
  return probed("xumm", force, async () => {
    const r = await xummPing();
    if (r.ok) return { name: "xumm", level: "ok", detail: `${r.detail} (live call)` };
    // A refused key is an outage of every Xaman flow; an unreachable/odd answer is worth a look but is not proof.
    return { name: "xumm", level: r.rejected ? "down" : "warn", detail: r.detail };
  });
}

async function checkT54(force: boolean): Promise<Check> {
  return probed("x402-t54", force, async () => {
  try {
    const r = await timed(() => facilitatorSupported());
    if (r.ok) return { name: "x402-t54", level: "ok", detail: "t54 facilitator /supported OK" };
    return { name: "x402-t54", level: "down", detail: `t54 facilitator /supported -> HTTP ${r.status}${r.error ? " " + r.error : ""}` };
  } catch (e) {
    return { name: "x402-t54", level: "down", detail: e instanceof Error ? e.message : "unreachable" };
  }
  });
}

async function checkCdp(force: boolean): Promise<Check> {
  const idSet = !!process.env.CDP_API_KEY_ID;
  const secretSet = !!process.env.CDP_API_KEY_SECRET;
  if (!idSet || !secretSet) {
    return { name: "x402-cdp", level: "down", detail: "CDP_API_KEY_ID / CDP_API_KEY_SECRET missing — USDC-on-Base checkout + x402 USDC routes can't settle" };
  }
  // Unauthenticated liveness of the CDP facilitator host. A 400/401/403 all mean "the service is up" (auth happens
  // per-request inside withX402); only a network failure or 5xx is a real outage. NOTE this proves the host answers,
  // not that our key is valid — the detail says so.
  return probed("x402-cdp", force, async () => {
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
    return { name: "x402-cdp", level: "ok", detail: `CDP keys set; facilitator host reachable (HTTP ${res.status}) — key validity is not probed` };
  } catch (e) {
    return { name: "x402-cdp", level: "down", detail: `CDP facilitator unreachable: ${e instanceof Error ? e.message : "error"}` };
  }
  });
}

async function checkAnchor(): Promise<Check> {
  // The MPT registry anchor — a DEDICATED wallet (ANCHOR_WALLET_SEED), not the
  // credential issuer. This is a separate capability from credential issuance.
  const enabled = process.env.MPT_ANCHOR_ENABLED === "true";
  const keyed = !!process.env.ANCHOR_WALLET_SEED;
  if (enabled && !keyed) {
    return { name: "mpt-anchor", level: "down", detail: "MPT_ANCHOR_ENABLED=true but ANCHOR_WALLET_SEED is not set — anchor fails every run" };
  }
  try {
    const lastFail = await prisma.mptAnchor.findFirst({
      where: { status: { in: ["failed", "misconfigured"] } },
      orderBy: { createdAt: "desc" },
    });
    const lastAnchor = await prisma.mptAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } });
    if (lastFail && (!lastAnchor || lastFail.createdAt > lastAnchor.createdAt)) {
      // A stale misconfigured row from before ANCHOR_WALLET_SEED existed isn't
      // a live outage once the key is present — the next cron clears it.
      const stale = lastFail.status === "misconfigured" && keyed;
      return { name: "mpt-anchor", level: stale || !enabled ? "warn" : "down", detail: `last anchor attempt ${lastFail.status}: ${lastFail.error ?? "no detail"}${stale ? " (stale — anchor key now present, next cron clears it)" : ""}` };
    }
    if (!enabled) return { name: "mpt-anchor", level: "warn", detail: "anchoring disabled (MPT_ANCHOR_ENABLED not set)" };
    return { name: "mpt-anchor", level: "ok", detail: lastAnchor ? `last anchored at ledger ${lastAnchor.ledgerIndex} by the anchor wallet` : "enabled, anchor key present, no anchor yet" };
  } catch (e) {
    return { name: "mpt-anchor", level: "warn", detail: e instanceof Error ? e.message : "check failed" };
  }
}

async function checkScreening(): Promise<Check> {
  // OFAC SDN screening attestation pipeline: is a snapshot present and fresh,
  // and did the last anchor succeed. A stale/missing snapshot is the failure
  // that matters — every screen would attest against nothing.
  try {
    const [snap, lastFail, lastOk, unanchored] = await Promise.all([
      prisma.sanctionListSnapshot.findFirst({ where: { listName: "OFAC-SDN" }, orderBy: { fetchedAt: "desc" } }),
      prisma.screeningAnchor.findFirst({ where: { status: { in: ["failed", "misconfigured"] } }, orderBy: { createdAt: "desc" } }),
      prisma.screeningAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } }),
      prisma.screeningReceipt.count({ where: { anchorId: null } }),
    ]);
    if (!snap) {
      return { name: "screening-ofac", level: "warn", detail: "no OFAC SDN snapshot ingested yet — screening returns 503" };
    }
    const ageDays = (Date.now() - snap.fetchedAt.getTime()) / 86_400_000;
    if (snap.addressCount === 0) {
      return { name: "screening-ofac", level: "down", detail: `latest OFAC SDN snapshot (${snap.vintage}) has 0 XRP addresses — integrity gate should have blocked this` };
    }
    if (ageDays > 21) {
      return { name: "screening-ofac", level: "warn", detail: `OFAC SDN snapshot is ${Math.floor(ageDays)}d old (${snap.vintage}) — the daily refresh may be stuck` };
    }
    const failNewer = lastFail && (!lastOk || lastFail.createdAt > lastOk.createdAt);
    if (failNewer && lastFail) {
      const keyed = !!process.env.ANCHOR_WALLET_SEED;
      const level: Level = lastFail.status === "misconfigured" && !keyed ? "down" : "warn";
      return { name: "screening-ofac", level, detail: `last screening anchor ${lastFail.status}: ${lastFail.error ?? "no detail"}${unanchored ? ` (${unanchored} receipt(s) unanchored)` : ""}` };
    }
    return { name: "screening-ofac", level: "ok", detail: `OFAC SDN ${snap.vintage}, ${snap.addressCount} XRP addr; ${unanchored} receipt(s) awaiting the next anchor` };
  } catch (e) {
    return { name: "screening-ofac", level: "warn", detail: e instanceof Error ? e.message : "check failed" };
  }
}

async function checkLendingExposure(): Promise<Check> {
  // XLS-66 exposure attestation pipeline. The amendment being inactive is
  // expected (info, not down). What matters once it's live: is the daily sweep
  // keeping up (no borrower going unswept), and is the anchor healthy.
  try {
    const [lastFail, lastOk, unanchored, snapCount, sweepCp, worklist] = await Promise.all([
      prisma.lendingExposureAnchor.findFirst({ where: { status: { in: ["failed", "misconfigured"] } }, orderBy: { createdAt: "desc" } }),
      prisma.lendingExposureAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } }),
      prisma.lendingExposureSnapshot.count({ where: { anchorId: null } }),
      prisma.lendingExposureSnapshot.count(),
      prisma.indexerCheckpoint.findUnique({ where: { id: "lending-sweep" } }),
      prisma.lendingBorrowerSweep.count(),
    ]);
    if (snapCount === 0 && worklist === 0) {
      return { name: "lending-exposure", level: "ok", detail: "no exposure snapshots yet (XLS-66 not active on mainnet)" };
    }
    const failNewer = lastFail && (!lastOk || lastFail.createdAt > lastOk.createdAt);
    if (failNewer && lastFail) {
      const keyed = !!process.env.ANCHOR_WALLET_SEED;
      const level: Level = lastFail.status === "misconfigured" && !keyed ? "down" : "warn";
      return { name: "lending-exposure", level, detail: `last lending anchor ${lastFail.status}: ${lastFail.error ?? "no detail"}${unanchored ? ` (${unanchored} snapshot(s) unanchored)` : ""}` };
    }
    // Sweep staleness: a completed pass older than ~3 days, or a pass stuck
    // running for >2 days, means borrowers are going unobserved.
    const passAgeDays = sweepCp?.lastCompletedPassAt ? (Date.now() - sweepCp.lastCompletedPassAt.getTime()) / 86_400_000 : null;
    const stuckDays = sweepCp?.status === "running" && sweepCp.passStartedAt ? (Date.now() - sweepCp.passStartedAt.getTime()) / 86_400_000 : null;
    if (worklist > 0 && ((passAgeDays != null && passAgeDays > 3) || (stuckDays != null && stuckDays > 2))) {
      return { name: "lending-exposure", level: "warn", detail: `sweep behind: ${worklist} borrower(s), last full pass ${passAgeDays != null ? passAgeDays.toFixed(1) + "d ago" : "never"}${stuckDays != null ? `, current pass running ${stuckDays.toFixed(1)}d` : ""}` };
    }
    return { name: "lending-exposure", level: "ok", detail: `${snapCount} snapshot(s), ${unanchored} awaiting anchor; sweep work-list ${worklist}, last full pass ${passAgeDays != null ? passAgeDays.toFixed(1) + "d ago" : "n/a"}` };
  } catch (e) {
    return { name: "lending-exposure", level: "warn", detail: e instanceof Error ? e.message : "check failed" };
  }
}

function checkCredentialSigning(): Check {
  return process.env.CREDENTIAL_SIGNING_SECRET
    ? { name: "credential-signing", level: "ok", detail: "CREDENTIAL_SIGNING_SECRET set — paid off-ledger certificates can be issued and checked (HMAC under a server-held key: XRPLHub's own attestation, not independently verifiable)" }
    : { name: "credential-signing", level: "down", detail: "CREDENTIAL_SIGNING_SECRET NOT set — the paid certificate route refuses to issue (it fails closed), so none can be sold" };
}

function checkCredentialIssuance(): Check {
  // On-ledger XLS-70 credential issuance is deliberately NOT wired to the
  // serverless env — the issuer seed lives only on the operator's machine, so
  // a compromised Vercel env can never forge an XRPLHub credential. Its
  // absence here is the intended posture, not an outage — WARN, never DOWN.
  return process.env.CREDENTIAL_ISSUER_SEED
    ? { name: "credential-issuance", level: "ok", detail: "CREDENTIAL_ISSUER_SEED present — on-ledger credential issuance available server-side" }
    : { name: "credential-issuance", level: "warn", detail: "on-ledger credential issuance is operator-only by design (CREDENTIAL_ISSUER_SEED kept off Vercel); run it from the operator's machine" };
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

/** `deep: true` forces fresh external probes (the cron, an admin); otherwise recent results (<60 s, this instance) are reused. */
export async function healthProbe(opts: { deep?: boolean } = {}): Promise<HealthReport> {
  const force = opts.deep ?? false;
  const checks: Check[] = [];
  const settled = await Promise.allSettled([checkDb(), checkXumm(force), checkT54(force), checkCdp(force), checkAnchor(), checkScreening(), checkLendingExposure()]);
  for (const s of settled) {
    if (s.status === "fulfilled") checks.push(s.value);
    else checks.push({ name: "unknown", level: "warn", detail: String(s.reason) });
  }
  checks.push(checkCredentialSigning(), checkCredentialIssuance(), checkAlerting(), checkCron());

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
