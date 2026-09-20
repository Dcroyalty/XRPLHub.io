// src/lib/watchdog.ts
// The unattended-operation watchdog. Nothing in this app can report its own death, so this module does
// the next best thing: every daily run checks the things that fail SILENTLY over months and turns them
// into a message on the error webhook, with de-duplication and a weekly "I'm alive" heartbeat.
//
//   • cron heartbeats — each daily cron records a heartbeat; the OTHER cron alerts if it goes stale
//     (both dying at once is what HEALTHCHECK_PING_URL — an external dead-man's switch — is for)
//   • things that expire: domains (RDAP), TLS certificate, XNS names, on-ledger credentials
//   • things that run out: database size (Neon free tier), the anchor wallet's spendable XRP
//   • things that stop: OFAC SDN refresh, unanchored attestations, the monitoring backlog
//   • things that get revoked: the Bithomp key, the XRP price sources
//   • the amendment reader itself, and a one-time "XLS-66 is now ACTIVE" announcement
//
// A check that cannot run (RDAP down, a node blip) reports `ok` with a note — a flaky probe must never page
// you. Persistent red/warn findings re-alert every 3 / 7 days; a recovery sends one message.

import tls from "tls";
import type { PrismaClient } from "@prisma/client";
import { notifyError, notifyInfo } from "./notify";
import { xrplRpc, XRPL_NODES } from "./xrplNodes";
import { getAmendmentStatuses } from "./amendments";
import { xrpUsd } from "./xrpPrice";
import { ANCHOR_ACCOUNT } from "./mptAnchor";
import { EXPECTED_ISSUER } from "./credentials";
import { TREASURY } from "./pricing";
import { maxTotalSubjects } from "./monitorEngine";

export type Level = "ok" | "warn" | "red";
export interface Finding {
  key: string;
  level: Level;
  message: string;
}

const DAY = 86_400_000;
const RIPPLE_EPOCH_OFFSET = 946_684_800;
export const HEARTBEAT_MAX_AGE_H = 36;
export const WATCHED_DOMAINS: Array<{ domain: string; rdap: string }> = [
  { domain: "xrplhub.io", rdap: "https://rdap.identitydigital.services/rdap/domain/xrplhub.io" },
  { domain: "xrplhub.com", rdap: "https://rdap.verisign.com/com/v1/domain/xrplhub.com" },
  { domain: "kreditkarma.us", rdap: "https://rdap.nic.us/domain/kreditkarma.us" },
];
const XNS_ISSUER = "rYhfynZDrde1uSvvQAYctApg6DnVE5HKm";
const SITE_HOST = "www.xrplhub.io";

// ── heartbeats ───────────────────────────────────────────────────────────────
export async function recordHeartbeat(prisma: PrismaClient, name: string, note?: string): Promise<void> {
  try {
    await prisma.indexerCheckpoint.upsert({
      where: { id: `heartbeat:${name}` },
      create: { id: `heartbeat:${name}`, status: "idle", marker: note ?? null, lastCompletedPassAt: new Date() },
      update: { status: "idle", marker: note ?? null, lastCompletedPassAt: new Date() },
    });
  } catch (e) {
    await notifyError("watchdog recordHeartbeat", e, { name });
  }
}

async function checkHeartbeat(prisma: PrismaClient, name: string): Promise<Finding> {
  const key = `cron-heartbeat:${name}`;
  const row = await prisma.indexerCheckpoint.findUnique({ where: { id: `heartbeat:${name}` } });
  if (!row?.lastCompletedPassAt) {
    // A brand-new watchdog has nothing to compare against yet: give the other cron 2 days to write its first heartbeat.
    const epoch = await prisma.indexerCheckpoint.findUnique({ where: { id: 'watchdog:epoch' } });
    const young = !epoch?.lastCompletedPassAt || Date.now() - epoch.lastCompletedPassAt.getTime() < 2 * DAY;
    return young ? { key, level: 'ok', message: `no heartbeat from ${name} recorded yet (watchdog just started)` } : { key, level: 'red', message: `${name} has never recorded a heartbeat — the cron is not running (CRON_SECRET? deployment? plan?)` };
  }
  const hours = (Date.now() - row.lastCompletedPassAt.getTime()) / 3_600_000;
  if (hours > HEARTBEAT_MAX_AGE_H) return { key, level: "red", message: `${name} last completed ${hours.toFixed(0)}h ago (expected daily) — the cron is failing or not running` };
  return { key, level: "ok", message: `${name} last completed ${hours.toFixed(1)}h ago` };
}

// ── individual checks ────────────────────────────────────────────────────────
async function checkSdn(prisma: PrismaClient): Promise<Finding> {
  const snap = await prisma.sanctionListSnapshot.findFirst({ where: { listName: "OFAC-SDN" }, orderBy: { fetchedAt: "desc" } });
  if (!snap) return { key: "ofac-sdn", level: "warn", message: "no OFAC SDN snapshot has ever been ingested" };
  const age = (Date.now() - snap.fetchedAt.getTime()) / DAY;
  if (age > 8) return { key: "ofac-sdn", level: "red", message: `newest OFAC SDN snapshot is ${age.toFixed(1)} days old (vintage ${snap.vintage}) — the daily refresh is failing or OFAC's feed changed; screening keeps using the stale list` };
  if (age > 4) return { key: "ofac-sdn", level: "warn", message: `newest OFAC SDN snapshot is ${age.toFixed(1)} days old (vintage ${snap.vintage})` };
  return { key: "ofac-sdn", level: "ok", message: `SDN vintage ${snap.vintage}, ${age.toFixed(1)}d old` };
}

async function checkUnanchored(prisma: PrismaClient): Promise<Finding> {
  const cutoff = new Date(Date.now() - 4 * DAY);
  const [scr, mon, lend] = await Promise.all([
    prisma.screeningReceipt.count({ where: { anchorId: null, createdAt: { lt: cutoff } } }),
    prisma.monitorObservation.count({ where: { anchorId: null, createdAt: { lt: cutoff } } }),
    prisma.lendingExposureSnapshot.count({ where: { anchorId: null, createdAt: { lt: cutoff } } }).catch(() => 0),
  ]);
  if (scr + mon + lend > 0) return { key: "anchors-behind", level: "red", message: `attestations older than 4 days still unanchored on-ledger: screening ${scr}, monitoring ${mon}, lending ${lend} — the anchor step is failing (wallet funds? ANCHOR_WALLET_SEED? ledger?)` };
  return { key: "anchors-behind", level: "ok", message: "no attestation older than 4 days is waiting for its anchor" };
}

async function checkAnchorWallet(): Promise<Finding> {
  const r = await xrplRpc("account_info", { account: ANCHOR_ACCOUNT, ledger_index: "validated" });
  if (!r.ok) return { key: "anchor-wallet", level: "ok", message: "could not read the anchor wallet (ledger unreachable) — skipped" };
  const d = (r.body as { result?: { account_data?: { Balance?: string; OwnerCount?: number } } }).result?.account_data;
  if (!d) return { key: "anchor-wallet", level: "red", message: `anchor wallet ${ANCHOR_ACCOUNT} not found on the ledger` };
  const spendable = Number(d.Balance) / 1e6 - (1 + 0.2 * (d.OwnerCount ?? 0));
  if (spendable < 0.25) return { key: "anchor-wallet", level: "red", message: `anchor wallet has ${spendable.toFixed(3)} XRP spendable — anchors will start failing; top up ${ANCHOR_ACCOUNT}` };
  if (spendable < 0.5) return { key: "anchor-wallet", level: "warn", message: `anchor wallet has ${spendable.toFixed(3)} XRP spendable (each anchor costs ~0.00001 XRP)` };
  return { key: "anchor-wallet", level: "ok", message: `${spendable.toFixed(3)} XRP spendable` };
}

async function checkAmendments(prisma: PrismaClient): Promise<Finding> {
  const s = await getAmendmentStatuses(["LendingProtocol", "SingleAssetVault"] as const);
  if (s.LendingProtocol.state === "unknown") return { key: "amendment-reader", level: "warn", message: "the on-ledger Amendments object could not be read — XLS-66 activation cannot be detected until it can" };
  for (const name of ["LendingProtocol", "SingleAssetVault"] as const) {
    if (s[name].state === "active") {
      const id = `watchdog:announced:${name}`;
      const seen = await prisma.indexerCheckpoint.findUnique({ where: { id } });
      if (!seen) {
        await prisma.indexerCheckpoint.create({ data: { id, status: "idle", lastCompletedPassAt: new Date() } }).catch(() => {});
        await notifyInfo(
          "amendment activated",
          name === "LendingProtocol"
            ? "XLS-66 LendingProtocol is now ACTIVE on mainnet. Lending exposure/underwrite endpoints, the daily borrower sweep, monitoring loan events and the anchors now run live — no deploy needed. Nothing for you to do; keep an eye on this channel."
            : "XLS-65 SingleAssetVault is now ACTIVE on mainnet (vault profiles are not built yet).",
          { ledgerIndex: s[name].ledgerIndex }
        );
      }
    }
  }
  return { key: "amendment-reader", level: "ok", message: `LendingProtocol ${s.LendingProtocol.state}, SingleAssetVault ${s.SingleAssetVault.state}` };
}

async function checkCredentialExpiry(): Promise<Finding> {
  const r = await xrplRpc("account_objects", { account: EXPECTED_ISSUER, ledger_index: "validated", type: "credential", limit: 100 });
  if (!r.ok) return { key: "credential-expiry", level: "ok", message: "could not read the issuer's credentials — skipped" };
  const objs = ((r.body as { result?: { account_objects?: Array<{ Expiration?: number; Issuer?: string }> } }).result?.account_objects ?? []).filter((o) => o.Issuer === EXPECTED_ISSUER && typeof o.Expiration === "number");
  if (!objs.length) return { key: "credential-expiry", level: "ok", message: "no expiring credentials outstanding" };
  const soon = Math.min(...objs.map((o) => (o.Expiration! + RIPPLE_EPOCH_OFFSET) * 1000));
  const days = (soon - Date.now()) / DAY;
  const when = new Date(soon).toISOString().slice(0, 10);
  if (days <= 0) return { key: "credential-expiry", level: "warn", message: `an XRPLScore credential expired on ${when} (issuing a replacement is a manual step: scripts/issue-credential.cjs on your own machine)` };
  if (days <= 14) return { key: "credential-expiry", level: "red", message: `an XRPLScore credential expires in ${days.toFixed(0)} days (${when}); re-issuing is manual (scripts/issue-credential.cjs)` };
  if (days <= 45) return { key: "credential-expiry", level: "warn", message: `an XRPLScore credential expires in ${days.toFixed(0)} days (${when}); re-issuing is manual` };
  return { key: "credential-expiry", level: "ok", message: `next credential expiry ${when}` };
}

async function checkDomains(): Promise<Finding> {
  const out: string[] = [];
  let worst = Infinity;
  let worstName = "";
  for (const d of WATCHED_DOMAINS) {
    try {
      const r = await fetch(d.rdap, { headers: { accept: "application/rdap+json" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
      const exp = j.events?.find((e) => e.eventAction === "expiration")?.eventDate;
      if (!exp) continue;
      const days = (new Date(exp).getTime() - Date.now()) / DAY;
      out.push(`${d.domain} ${new Date(exp).toISOString().slice(0, 10)}`);
      if (days < worst) {
        worst = days;
        worstName = `${d.domain} (${new Date(exp).toISOString().slice(0, 10)})`;
      }
    } catch {
      /* RDAP is best-effort */
    }
  }
  if (!out.length) return { key: "domain-expiry", level: "ok", message: "registry RDAP unreachable — skipped" };
  if (worst <= 14) return { key: "domain-expiry", level: "red", message: `domain ${worstName} expires in ${Math.max(0, worst).toFixed(0)} days and has NOT auto-renewed — check the registrar payment method` };
  if (worst <= 45) return { key: "domain-expiry", level: "warn", message: `domain ${worstName} expires in ${worst.toFixed(0)} days — confirm auto-renew and the card on file` };
  return { key: "domain-expiry", level: "ok", message: out.join("; ") };
}

async function checkXns(): Promise<Finding> {
  const r = await xrplRpc("account_nfts", { account: TREASURY, ledger_index: "validated", limit: 100 });
  if (!r.ok) return { key: "xns-expiry", level: "ok", message: "could not read the treasury's NFTs — skipped" };
  const nfts = ((r.body as { result?: { account_nfts?: Array<{ Issuer?: string; URI?: string }> } }).result?.account_nfts ?? []).filter((n) => n.Issuer === XNS_ISSUER && n.URI);
  let worst = Infinity;
  let worstName = "";
  const seen: string[] = [];
  for (const n of nfts) {
    try {
      const uri = Buffer.from(n.URI!, "hex").toString("utf8");
      if (!/^https:\/\/metadata\.xrpns\.com\//.test(uri)) continue;
      const m = await fetch(uri, { signal: AbortSignal.timeout(5000) });
      if (!m.ok) continue;
      const j = (await m.json()) as { name?: string; attributes?: Array<{ trait_type?: string; value?: number }> };
      const exp = j.attributes?.find((a) => a.trait_type === "Expiration Date")?.value;
      if (typeof exp !== "number") continue;
      const days = (exp - Date.now()) / DAY;
      seen.push(`${j.name} ${new Date(exp).toISOString().slice(0, 10)}`);
      if (days < worst) {
        worst = days;
        worstName = `${j.name} (${new Date(exp).toISOString().slice(0, 10)})`;
      }
    } catch {
      /* skip this name */
    }
  }
  if (!seen.length) return { key: "xns-expiry", level: "ok", message: "no XNS names found or metadata unreachable — skipped" };
  if (worst <= 14) return { key: "xns-expiry", level: "red", message: `XRPNS name ${worstName} expires in ${Math.max(0, worst).toFixed(0)} days. XNS names do NOT auto-renew — renew at app.xrpns.com/renewal (the homepage shows xrplhub.xrp as the pay-to name)` };
  if (worst <= 60) return { key: "xns-expiry", level: "warn", message: `XRPNS name ${worstName} expires in ${worst.toFixed(0)} days — renew at app.xrpns.com/renewal (not automatic)` };
  return { key: "xns-expiry", level: "ok", message: seen.join("; ") };
}

function checkTls(): Promise<Finding> {
  return new Promise((resolve) => {
    const s = tls.connect({ host: SITE_HOST, port: 443, servername: SITE_HOST, timeout: 6000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      const days = (new Date(c.valid_to).getTime() - Date.now()) / DAY;
      if (days < 10) return resolve({ key: "tls-cert", level: "red", message: `TLS certificate for ${SITE_HOST} expires in ${days.toFixed(0)} days — Vercel's automatic renewal is failing (check the domain's DNS/CAA)` });
      resolve({ key: "tls-cert", level: "ok", message: `certificate valid ${days.toFixed(0)} more days` });
    });
    s.on("error", () => resolve({ key: "tls-cert", level: "ok", message: "TLS probe failed to connect — skipped" }));
    s.on("timeout", () => {
      s.destroy();
      resolve({ key: "tls-cert", level: "ok", message: "TLS probe timed out — skipped" });
    });
  });
}

async function checkDbSize(prisma: PrismaClient): Promise<Finding> {
  const limitMb = Number(process.env.DB_SIZE_LIMIT_MB) > 0 ? Number(process.env.DB_SIZE_LIMIT_MB) : 512; // Neon free tier
  const rows = (await prisma.$queryRawUnsafe("SELECT pg_database_size(current_database())::bigint AS b")) as Array<{ b: bigint | number }>;
  const mb = Number(rows[0].b) / 1_048_576;
  const pct = (mb / limitMb) * 100;
  if (pct >= 90) return { key: "db-size", level: "red", message: `database is ${mb.toFixed(0)} MB of ${limitMb} MB (${pct.toFixed(0)}%) — writes will start failing at the limit; prune UsageRecord/ScoreHistory or upgrade the Neon plan` };
  if (pct >= 70) return { key: "db-size", level: "warn", message: `database is ${mb.toFixed(0)} MB of ${limitMb} MB (${pct.toFixed(0)}%)` };
  return { key: "db-size", level: "ok", message: `${mb.toFixed(1)} MB of ${limitMb} MB` };
}

async function checkBithomp(): Promise<Finding> {
  const key = process.env.BITHOMP_API_KEY;
  if (!key) return { key: "bithomp-key", level: "ok", message: "BITHOMP_API_KEY not set (optional)" };
  try {
    const r = await fetch("https://bithomp.com/api/v2/mptokens?limit=1", { headers: { "x-bithomp-token": key }, signal: AbortSignal.timeout(6000) });
    if (r.status === 401 || r.status === 403) return { key: "bithomp-key", level: "red", message: `Bithomp rejected the API key (HTTP ${r.status}) — the MPT registry silently stops refreshing holder counts until it is replaced` };
    return { key: "bithomp-key", level: "ok", message: `Bithomp key accepted (HTTP ${r.status})` };
  } catch {
    return { key: "bithomp-key", level: "ok", message: "Bithomp unreachable — skipped" };
  }
}

/** The score/monitoring/amendment reads rotate across 8 public XRPL nodes. Some are hobbyist hosts that will
 *  disappear over two years; the rotation hides that until they are ALL gone, so count the healthy ones. */
async function checkNodes(): Promise<Finding> {
  const results = await Promise.all(
    XRPL_NODES.map(async (url) => {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "server_info", params: [{}] }), signal: AbortSignal.timeout(5000) });
        if (!r.ok) return { url, ok: false };
        const j = (await r.json()) as { result?: { info?: { network_id?: number; complete_ledgers?: string } } };
        return { url, ok: j.result?.info?.network_id === 0 };
      } catch {
        return { url, ok: false };
      }
    })
  );
  const healthy = results.filter((r) => r.ok).length;
  const dead = results.filter((r) => !r.ok).map((r) => new URL(r.url).host);
  if (healthy <= 2) return { key: "xrpl-nodes", level: "red", message: `only ${healthy} of ${results.length} public XRPL nodes answer as mainnet (down: ${dead.join(", ")}) — scores, monitoring and amendment detection are about to fail; update XRPL_NODES in src/lib/xrplNodes.ts` };
  if (healthy <= 5) return { key: "xrpl-nodes", level: "warn", message: `${healthy} of ${results.length} public XRPL nodes healthy (down: ${dead.join(", ")}) — refresh the node list in src/lib/xrplNodes.ts` };
  return { key: "xrpl-nodes", level: "ok", message: `${healthy} of ${results.length} public XRPL nodes healthy${dead.length ? ` (down: ${dead.join(", ")})` : ""}` };
}

async function checkXrpPrice(): Promise<Finding> {
  try {
    const p = await xrpUsd();
    return { key: "xrp-price", level: "ok", message: `XRP/USD ${p}` };
  } catch (e) {
    return { key: "xrp-price", level: "warn", message: `both XRP price sources failed (${e instanceof Error ? e.message : "error"}) — XRP checkout is refused until one recovers` };
  }
}

async function checkMonitorBacklog(prisma: PrismaClient): Promise<Finding> {
  const behind = await prisma.monitorSubject.count({ where: { nextCheckAt: { lt: new Date(Date.now() - 3 * DAY) }, subscription: { status: { in: ["active", "webhook_disabled"] } } } });
  const total = await prisma.monitorSubject.count({ where: { subscription: { status: { not: "deleted" } } } });
  if (behind > 0) return { key: "monitor-backlog", level: "warn", message: `${behind} of ${total} monitored wallets are more than 3 days overdue for their daily check (shared limit ${maxTotalSubjects()}) — the daily cron cannot keep up or is failing` };
  return { key: "monitor-backlog", level: "ok", message: `${total} monitored wallets, none more than 3 days behind` };
}

// ── orchestration ────────────────────────────────────────────────────────────
function withTimeout<T>(p: Promise<T>, ms: number, key: string): Promise<T | Finding> {
  return Promise.race([p, new Promise<Finding>((res) => setTimeout(() => res({ key, level: "ok", message: `check timed out after ${ms}ms — skipped` }), ms))]);
}

export interface WatchdogOptions {
  /** Heartbeats of the OTHER cron(s) to verify. */
  otherCrons?: string[];
  /** Run the slow external checks (RDAP, XNS, TLS, Bithomp, price). The second cron does; the first only cross-checks. */
  full?: boolean;
  sendWeekly?: boolean;
  notify?: { error: typeof notifyError; info: typeof notifyInfo };
}

export interface WatchdogResult {
  findings: Finding[];
  alerted: string[];
  recovered: string[];
  weeklySent: boolean;
}

async function applyFinding(prisma: PrismaClient, f: Finding, n: NonNullable<WatchdogOptions["notify"]>): Promise<"alerted" | "recovered" | "quiet"> {
  const id = `watchdog:alert:${f.key}`;
  const row = await prisma.indexerCheckpoint.findUnique({ where: { id } });
  const alerting = row?.status === "alerting";
  if (f.level === "ok") {
    if (alerting) {
      await n.info("watchdog recovered", `${f.key}: ${f.message}`);
      await prisma.indexerCheckpoint.update({ where: { id }, data: { status: "idle" } });
      return "recovered";
    }
    return "quiet";
  }
  const repeatMs = f.level === "red" ? 3 * DAY : 7 * DAY;
  const last = row?.lastCompletedPassAt?.getTime() ?? 0;
  if (alerting && Date.now() - last < repeatMs) return "quiet";
  if (f.level === "red") await n.error(`watchdog RED: ${f.key}`, new Error(f.message));
  else await n.info(`watchdog warning: ${f.key}`, `⚠️ ${f.message}`);
  await prisma.indexerCheckpoint.upsert({
    where: { id },
    create: { id, status: "alerting", lastCompletedPassAt: new Date() },
    update: { status: "alerting", lastCompletedPassAt: new Date() },
  });
  return "alerted";
}

export async function runWatchdog(prisma: PrismaClient, opts: WatchdogOptions = {}): Promise<WatchdogResult> {
  const n = opts.notify ?? { error: notifyError, info: notifyInfo };
  await prisma.indexerCheckpoint.upsert({ where: { id: 'watchdog:epoch' }, create: { id: 'watchdog:epoch', status: 'idle', lastCompletedPassAt: new Date() }, update: {} }).catch(() => {});
  const jobs: Array<Promise<Finding | Finding[]>> = [];
  const add = (key: string, fn: () => Promise<Finding>, ms = 7000) =>
    jobs.push(
      withTimeout(fn(), ms, key).catch((e): Finding => ({ key, level: "ok", message: `check failed to run: ${e instanceof Error ? e.message : String(e)} — skipped` })) as Promise<Finding>
    );

  for (const c of opts.otherCrons ?? []) add(`cron-heartbeat:${c}`, () => checkHeartbeat(prisma, c));
  add("ofac-sdn", () => checkSdn(prisma));
  add("anchors-behind", () => checkUnanchored(prisma));
  add("monitor-backlog", () => checkMonitorBacklog(prisma));
  add("amendment-reader", () => checkAmendments(prisma));
  add("db-size", () => checkDbSize(prisma));
  if (opts.full) {
    add("anchor-wallet", checkAnchorWallet);
    add("credential-expiry", checkCredentialExpiry);
    add("domain-expiry", checkDomains, 9000);
    add("xns-expiry", checkXns, 9000);
    add("tls-cert", checkTls);
    add("xrpl-nodes", checkNodes, 8000);
    add("bithomp-key", checkBithomp);
    add("xrp-price", checkXrpPrice);
  }

  const findings = (await Promise.all(jobs)).flat();
  const alerted: string[] = [];
  const recovered: string[] = [];
  for (const f of findings) {
    try {
      const r = await applyFinding(prisma, f, n);
      if (r === "alerted") alerted.push(f.key);
      if (r === "recovered") recovered.push(f.key);
    } catch (e) {
      await notifyError("watchdog applyFinding", e, { key: f.key });
    }
  }

  // weekly "still alive" message — its ABSENCE is the signal
  let weeklySent = false;
  if (opts.sendWeekly) {
    const wid = "watchdog:weekly";
    const w = await prisma.indexerCheckpoint.findUnique({ where: { id: wid } });
    if (!w?.lastCompletedPassAt || Date.now() - w.lastCompletedPassAt.getTime() > 6.5 * DAY) {
      const bad = findings.filter((f) => f.level !== "ok");
      await n.info(
        "weekly heartbeat",
        bad.length ? `Alive. ${bad.length} open finding(s): ${bad.map((f) => `${f.key} (${f.level})`).join(", ")}.` : "Alive. All checks green.",
        { checks: Object.fromEntries(findings.map((f) => [f.key, `${f.level}: ${f.message}`.slice(0, 160)])) }
      );
      await prisma.indexerCheckpoint.upsert({ where: { id: wid }, create: { id: wid, status: "idle", lastCompletedPassAt: new Date() }, update: { lastCompletedPassAt: new Date() } });
      weeklySent = true;
    }
  }
  return { findings, alerted, recovered, weeklySent };
}
