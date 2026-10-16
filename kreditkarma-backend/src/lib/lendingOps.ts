// src/lib/lendingOps.ts — two owner alerts for XRPL Lending, both run from the hourly job.
//
// 1. "Set up email now" (ONE alert, ever): the first time any lending amendment reaches 25 yes votes, or the
//    signup list reaches 25 people, while RESEND_API_KEY is still unset, send a single healthchecks.io /fail
//    with the reason. Recorded in IndexerCheckpoint `lending-resend-alert` so it never repeats. The next
//    normal success ping from the daily crons puts the check back to "up", so real failures still email.
//    Setup steps for that day: docs/AUTONOMY.md §23.
//
// 2. Activation self-test: once lending is live, prove the paid surfaces work end to end WITHOUT buying
//    anything — the explorer pages, the $0.02 grade API's 402 challenge, the MCP lending_grade tool, and the
//    XRPLHub Pro checkout (a Stripe Checkout session is created and left unpaid; it expires on its own).
//    Result stored in IndexerCheckpoint `lending-selftest`; the watchdog turns a failure into a RED finding,
//    which pings HEALTHCHECK_PING_URL/fail on every cron run until it passes.

import type { PrismaClient } from "@prisma/client";
import { pingHealthcheck } from "./notify";
import type { TrackerSnapshot } from "./lendingTracker";

const ALERT_ID = "lending-resend-alert";
export const RESEND_ALERT_VOTES = 25;
export const RESEND_ALERT_SIGNUPS = 25;

export async function maybeResendAlert(prisma: PrismaClient, snap: TrackerSnapshot): Promise<string | null> {
  if (process.env.RESEND_API_KEY) return null;
  if (await prisma.indexerCheckpoint.findUnique({ where: { id: ALERT_ID } })) return null;
  const signups = await prisma.lendingSignup.count({ where: { unsubscribedAt: null } });
  const top = snap.amendments.filter((a) => a.yes != null).sort((a, b) => (b.yes as number) - (a.yes as number))[0];
  const reasons: string[] = [];
  if (top && (top.yes as number) >= RESEND_ALERT_VOTES) reasons.push(`${top.name} has ${top.yes} of ${top.unlSize} validator yes votes (${top.needed} needed for a majority)`);
  if (signups >= RESEND_ALERT_SIGNUPS) reasons.push(`the "email me when lending goes live" list has ${signups} signups`);
  if (!reasons.length) return null;
  const message =
    `XRPLHub: set up email now — ${reasons.join(" and ")}, and RESEND_API_KEY is not set, so the launch email can't be sent. ` +
    `Steps: kreditkarma-backend/docs/AUTONOMY.md section 23 ("Resend setup"). This is a one-time reminder, not an outage; the check goes back to green at the next daily run.`;
  // Record first, so a crash between the two can never send it twice.
  await prisma.indexerCheckpoint.create({ data: { id: ALERT_ID, status: "idle", marker: message.slice(0, 900), lastCompletedPassAt: new Date() } });
  await pingHealthcheck("/fail", message);
  return message;
}

// ── activation self-test ──────────────────────────────────────────────────────
const SELFTEST_ID = "lending-selftest";
const UXUS = "https://uxus.finance";
const HUB = "https://www.xrplhub.io";
const RERUN_OK_MS = 24 * 3_600_000; // re-verify daily once passing
const RERUN_FAIL_MS = 3_600_000; // retry hourly while failing
const NO_VAULT_GRACE_MS = 48 * 3_600_000; // the first discovery walk can take a day or two

type Step = { name: string; ok: boolean; detail: string };

async function get(url: string, init?: RequestInit): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "xrplhub-lending-selftest", ...(init?.headers as Record<string, string>) } });
  return { status: r.status, text: await r.text() };
}

export async function runLendingSelfTest(prisma: PrismaClient, opts: { force?: boolean } = {}): Promise<{ ran: boolean; ok?: boolean; steps?: Step[] }> {
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: SELFTEST_ID } });
  const prev = cp?.marker ? (JSON.parse(cp.marker) as { ok: boolean; at: string; liveSince?: string }) : null;
  const since = prev ? Date.now() - Date.parse(prev.at) : Infinity;
  if (!opts.force && prev && since < (prev.ok ? RERUN_OK_MS : RERUN_FAIL_MS)) return { ran: false };
  const liveSince = prev?.liveSince ?? new Date().toISOString();

  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try { steps.push({ name, ok: true, detail: await fn() }); } catch (e) { steps.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  };

  const vault = await prisma.lendingVault.findFirst({ where: { network: "mainnet", deleted: false }, orderBy: { firstSeenAt: "asc" }, select: { id: true } });
  if (!vault) {
    const waited = Date.now() - Date.parse(liveSince);
    if (waited < NO_VAULT_GRACE_MS) {
      await save(prisma, { ok: true, at: new Date().toISOString(), liveSince, steps: [{ name: "vaults", ok: true, detail: `no vault discovered yet (${(waited / 3_600_000).toFixed(1)}h since activation); waiting up to 48h` }] });
      return { ran: true, ok: true };
    }
    steps.push({ name: "vaults", ok: false, detail: "lending has been live for over 48h and the index has found no vault — the discovery walk is not working" });
  } else {
    const id = vault.id;
    await step("explorer: vault list", async () => {
      const r = await get(`${HUB}/lending/vaults`);
      if (r.status !== 200 || !r.text.includes("/lending/vault/")) throw new Error(`/lending/vaults HTTP ${r.status}, vault links ${r.text.includes("/lending/vault/")}`);
      return "lists vaults";
    });
    await step("explorer: vault page", async () => {
      const r = await get(`${HUB}/lending/vault/${id}`);
      if (r.status !== 200 || !r.text.includes("Risk grade")) throw new Error(`/lending/vault/${id.slice(0, 10)}… HTTP ${r.status}`);
      return "vault page shows a risk grade";
    });
    await step("grade API: x402 challenge", async () => {
      const r = await get(`${UXUS}/api/lending/grade?id=${id}`);
      if (r.status !== 402) throw new Error(`expected 402 payment challenge, got HTTP ${r.status}: ${r.text.slice(0, 160)}`);
      const j = JSON.parse(r.text) as { accepts?: { maxAmountRequired?: string; resource?: string }[] };
      const a = j.accepts?.[0];
      if (!a || a.maxAmountRequired !== "20000" || !String(a.resource).endsWith("/api/lending/grade")) throw new Error(`402 challenge looks wrong: ${r.text.slice(0, 200)}`);
      return "402 asks $0.02 for /api/lending/grade";
    });
    await step("MCP lending_grade", async () => {
      const r = await get(`${UXUS}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lending_grade", arguments: { id } } }),
      });
      const ok = r.status === 200 && r.text.includes("/api/lending/grade") && r.text.includes("paid") && !r.text.includes("lending_not_live");
      if (!ok) throw new Error(`MCP tools/call HTTP ${r.status}: ${r.text.slice(0, 200)}`);
      return "returns the paid resource";
    });
  }
  await step("XRPLHub Pro checkout", async () => {
    const page = await get(`${UXUS}/pricing`);
    if (page.status !== 200 || !page.text.includes("XRPLHub Pro")) throw new Error(`/pricing HTTP ${page.status} or XRPLHub Pro card missing`);
    if (page.text.includes("Opening shortly")) throw new Error("/pricing shows XRPLHub Pro as not open yet");
    const r = await get(`${UXUS}/api/billing/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "xrplhub_pro" }) });
    if (r.status !== 200 || !/checkout\.stripe\.com\/[a-z]\/pay\/cs_live_/.test(r.text)) throw new Error(`checkout for xrplhub_pro HTTP ${r.status}: ${r.text.slice(0, 160)}`);
    return "pricing card open; Stripe Checkout session created (left unpaid, expires on its own)";
  });

  const ok = steps.every((s) => s.ok);
  await save(prisma, { ok, at: new Date().toISOString(), liveSince, steps });
  return { ran: true, ok, steps };
}

async function save(prisma: PrismaClient, v: { ok: boolean; at: string; liveSince: string; steps: Step[] }) {
  const data = { status: "idle", marker: JSON.stringify(v).slice(0, 8000), lastCompletedPassAt: new Date() };
  await prisma.indexerCheckpoint.upsert({ where: { id: SELFTEST_ID }, create: { id: SELFTEST_ID, ...data }, update: data });
}

/** For the watchdog: null = not live / never ran; otherwise the last result. */
export async function lastSelfTest(prisma: PrismaClient): Promise<{ ok: boolean; at: string; steps: Step[] } | null> {
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: SELFTEST_ID } });
  return cp?.marker ? (JSON.parse(cp.marker) as { ok: boolean; at: string; steps: Step[] }) : null;
}
