// src/lib/yieldDesk.ts — the XRP Yield Desk refresh (/yield). Run hourly by /api/cron/yield-refresh (GitHub
// Actions) and, as a fallback, by the daily watchdog when the data is over 3 hours old.
//
// Each source (src/lib/yieldSources.ts, src/lib/yieldAmm.ts) is read independently: one failing source never
// blocks the others, and its options keep their last good numbers (the page shows the "as of" time). Every
// source's last success is an IndexerCheckpoint `yield-source:<name>`, so the watchdog can tell which one is stale.
// Options a source stops returning are kept but marked unlisted. Grades are recomputed every run; a change is
// stored in YieldGrade and sent to XRPLHub Pro webhook watches (subjectType "yield").
import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import { grade, type YieldOption, type YieldHistory, type YieldGradeResult } from "./yieldGrade";
import { dopplerSource, firelightSource, defillamaSource, exchangeSource, type SourceItem, type SourceResult } from "./yieldSources";
import { ammSource } from "./yieldAmm";
import { xrpUsd } from "./xrpPrice";
import { lendingLive } from "./lendingTracker";
import { checkWebhookUrl, signWebhook } from "./monitorWebhook";

export const YIELD_SOURCES = ["doppler", "firelight", "defillama", "exchange", "xrpl-amm", "xls66"] as const;
export type YieldSourceName = (typeof YIELD_SOURCES)[number];
export const YIELD_CONSENT = "Email me when a risk grade on the XRP Yield Desk changes. No marketing, unsubscribe any time.";

export interface YieldRefreshReport {
  ok: boolean;
  sources: Record<string, { ok: boolean; options?: number; error?: string }>;
  options: number;
  gradeChanges: number;
  webhooksSent: number;
  ms: number;
}

const day = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms))]);
}

async function history(prisma: PrismaClient, slug: string): Promise<YieldHistory> {
  const rows = await prisma.yieldObservation.findMany({ where: { slug, day: { gte: new Date(Date.now() - 38 * 86_400_000) } }, orderBy: { day: "asc" } });
  const cut7 = Date.now() - 7 * 86_400_000;
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const recent = rows.filter((r) => r.day.getTime() >= cut7);
  const prior = rows.filter((r) => r.day.getTime() < cut7);
  const old = rows.find((r) => r.day.getTime() <= Date.now() - 29 * 86_400_000) ?? null;
  return { days: rows.length, apr7d: avg(recent.map((r) => r.apr)), aprPrior30d: avg(prior.map((r) => r.apr)), tvlNow: rows.at(-1)?.tvlUsd ?? null, tvl30dAgo: old?.tvlUsd ?? null };
}

/** XLS-66 vaults, once lending is live: one option per XRP or RLUSD vault, graded by the lending method. */
async function xls66Source(prisma: PrismaClient, xrp: number): Promise<SourceResult> {
  if (!(await lendingLive())) return { name: "xls66", items: [] };
  const vaults = await prisma.lendingVault.findMany({ where: { network: "mainnet", deleted: false, isPrivate: false }, take: 200 });
  const items: SourceItem[] = [];
  for (const v of vaults) {
    const asset = v.assetLabel === "XRP" ? "XRP" : /^RLUSD\b/.test(v.assetLabel) ? "RLUSD" : null;
    if (!asset) continue;
    const g = await prisma.lendingGrade.findFirst({ where: { network: "mainnet", subjectType: "vault", subjectId: v.id }, orderBy: { takenAt: "desc" } });
    const metrics = g ? (JSON.parse(g.metrics) as { realizedYieldPct?: number | null }) : {};
    const realized = metrics.realizedYieldPct != null ? metrics.realizedYieldPct / 100 : null;
    const total = Number(v.assetsTotal);
    items.push({
      option: {
        slug: `xls66-vault-${v.id.slice(0, 16).toLowerCase()}`,
        name: `XRPL lending vault ${v.id.slice(0, 8)}… (${asset})`,
        provider: `Vault owner ${v.owner.slice(0, 8)}…`,
        asset,
        kind: "lending",
        chain: "XRP Ledger",
        rate: realized,
        rateBase: realized,
        rateReward: null,
        rateKind: "realized from the vault's share value over up to 30 days",
        tvlUsd: Number.isFinite(total) ? (asset === "XRP" ? total * xrp : total) : null,
        lockup: "None set by the ledger; depends on the vault's free cash.",
        withdrawShort: "if cash free",
        withdrawal: "Withdraw while the vault has unlent cash; lent-out money comes back as borrowers repay.",
        keys: "The vault is a native XRP Ledger object; loans are made by its loan broker, without collateral",
        custody: "contract",
        bridge: "none",
        layers: 0,
        launchedAt: v.firstSeenAt.toISOString(),
        audits: null,
        auditLinks: [],
        ilRisk: false,
        url: `https://www.xrplhub.io/lending/vault/${v.id}`,
        source: { name: "XRP Ledger (XRPLHub lending index)", url: `https://www.xrplhub.io/lending/vault/${v.id}`, at: v.updatedAt.toISOString() },
        notes: ["Graded with the XRPL Lending method (/lending/method), which looks at the vault's loans and its broker's cover."],
      },
      externalGrade: g && g.grade !== "N/A" ? { grade: g.grade, score: g.score, url: "/lending/method" } : null,
    });
  }
  return { name: "xls66", items };
}

export async function runYieldRefresh(prisma: PrismaClient, opts: { budgetMs: number }): Promise<YieldRefreshReport> {
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  const rep: YieldRefreshReport = { ok: false, sources: {}, options: 0, gradeChanges: 0, webhooksSent: 0, ms: 0 };
  const per = Math.max(5_000, opts.budgetMs - 3_000);

  const xrp = await xrpUsd();
  const prev = await prisma.yieldOption.findMany();
  const prevBySlug = new Map(prev.map((o) => [o.slug, o]));
  const fl = await prisma.yieldObservation.findFirst({ where: { slug: "firelight-stxrp-flare", day: { lte: new Date(Date.now() - 29 * 86_400_000) } }, orderBy: { day: "desc" } });
  const flPrior = fl?.extra ? { price: (JSON.parse(fl.extra) as { sharePrice?: number }).sharePrice ?? NaN, at: fl.day.toISOString() } : null;
  const knownLaunch: Record<string, string | null> = {};
  for (const o of prev) {
    const d = JSON.parse(o.data) as YieldOption;
    if (o.source === "xrpl-amm" || (o.source === "defillama" && d.launchChecked)) knownLaunch[o.slug] = d.launchedAt;
  }

  const llama = withTimeout(defillamaSource(knownLaunch), per, "defillama");
  const jobs: Record<YieldSourceName, Promise<SourceResult>> = {
    doppler: withTimeout(dopplerSource(), per, "doppler"),
    firelight: withTimeout(firelightSource(xrp, flPrior && Number.isFinite(flPrior.price) ? flPrior : null), per, "firelight"),
    defillama: llama,
    exchange: withTimeout(llama.then((l) => l.protocols).catch(() => null).then((p) => exchangeSource(p)), per, "exchange"),
    "xrpl-amm": withTimeout(ammSource(prisma, { xrpUsd: xrp, deadline, knownLaunch }), per, "xrpl-amm"),
    xls66: withTimeout(xls66Source(prisma, xrp), per, "xls66"),
  };
  const settled = await Promise.allSettled(YIELD_SOURCES.map((n) => jobs[n]));

  const today = day();
  for (let i = 0; i < YIELD_SOURCES.length; i++) {
    const name = YIELD_SOURCES[i];
    const s = settled[i];
    const cpId = `yield-source:${name}`;
    if (s.status === "rejected") {
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      rep.sources[name] = { ok: false, error };
      await prisma.indexerCheckpoint.upsert({ where: { id: cpId }, create: { id: cpId, status: "failing", marker: error.slice(0, 500) }, update: { status: "failing", marker: error.slice(0, 500) } });
      continue;
    }
    const seen = new Set<string>();
    for (const it of s.value.items) {
      const o = it.option;
      seen.add(o.slug);
      await prisma.yieldObservation.upsert({
        where: { slug_day: { slug: o.slug, day: today } },
        create: { slug: o.slug, day: today, apr: o.rate, tvlUsd: o.tvlUsd, extra: it.extra ? JSON.stringify(it.extra) : null },
        update: { apr: o.rate, tvlUsd: o.tvlUsd, extra: it.extra ? JSON.stringify(it.extra) : null },
      });
      const g: YieldGradeResult = it.externalGrade
        ? { grade: it.externalGrade.grade as YieldGradeResult["grade"], score: it.externalGrade.score, adjustments: [], methodVersion: "lending-grade (see /lending/method)" }
        : grade(o, { history: await history(prisma, o.slug), withdrawalDays: it.withdrawalDays ?? null, oneVenue: it.oneVenue });
      const stored = { ...o, gradeDetail: g };
      await prisma.yieldOption.upsert({
        where: { slug: o.slug },
        create: { slug: o.slug, source: name, asset: o.asset, data: JSON.stringify(stored), grade: g.grade, score: g.score, listed: true, dataAt: new Date(o.source.at) },
        update: { source: name, asset: o.asset, data: JSON.stringify(stored), grade: g.grade, score: g.score, listed: true, dataAt: new Date(o.source.at) },
      });
      const last = await prisma.yieldGrade.findFirst({ where: { slug: o.slug }, orderBy: { takenAt: "desc" } });
      if (!last || last.grade !== g.grade) {
        await prisma.yieldGrade.create({ data: { slug: o.slug, grade: g.grade, score: g.score, methodVersion: g.methodVersion } });
        if (last) rep.gradeChanges++;
      }
    }
    // Options this source no longer returns stay on the site, marked unlisted. (A source that returned nothing
    // at all — e.g. xls66 before lending is live — unlists nothing it never listed.)
    await prisma.yieldOption.updateMany({ where: { source: name, listed: true, slug: { notIn: [...seen] } }, data: { listed: false } });
    rep.sources[name] = { ok: true, options: seen.size };
    rep.options += seen.size;
    await prisma.indexerCheckpoint.upsert({ where: { id: cpId }, create: { id: cpId, status: "idle", lastCompletedPassAt: new Date() }, update: { status: "idle", marker: null, lastCompletedPassAt: new Date() } });
  }

  rep.webhooksSent = await sendYieldWebhooks(prisma).catch(() => 0);
  rep.ok = Object.values(rep.sources).some((s) => s.ok);
  if (rep.ok) {
    await prisma.indexerCheckpoint.upsert({ where: { id: "yield-refresh" }, create: { id: "yield-refresh", status: "idle", lastCompletedPassAt: new Date() }, update: { status: "idle", lastCompletedPassAt: new Date() } });
  }
  rep.ms = Date.now() - started;
  return rep;
}

/** XRPL Pro webhook alerts for yield grade changes (watches with subjectType "yield", subjectId = slug). */
export async function sendYieldWebhooks(prisma: PrismaClient): Promise<number> {
  const watches = await prisma.lendingAlertWatch.findMany({ where: { subjectType: "yield" } });
  let sent = 0;
  for (const w of watches) {
    const latest = await prisma.yieldGrade.findFirst({ where: { slug: w.subjectId }, orderBy: { takenAt: "desc" } });
    if (!latest || latest.grade === w.lastNotifiedGrade) continue;
    const check = await checkWebhookUrl(w.webhookUrl);
    if (!check.ok) continue;
    const eventId = randomBytes(12).toString("hex");
    const body = JSON.stringify({
      event: "yield.grade_changed", eventId, slug: w.subjectId, previousGrade: w.lastNotifiedGrade, grade: latest.grade, score: latest.score,
      at: latest.takenAt.toISOString(), url: `https://www.xrplhub.io/yield/${w.subjectId}`, methodVersion: latest.methodVersion,
      disclaimer: "Risk grade from public data. General information, not personal advice, not a credit rating.",
    });
    const ts = Math.floor(Date.now() / 1000);
    try {
      const r = await fetch(w.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "X-XRPLHub-Event": "yield.grade_changed", "X-XRPLHub-Event-Id": eventId, "X-XRPLHub-Timestamp": String(ts), "X-XRPLHub-Signature": `v1=${signWebhook(w.secret, ts, body)}` },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        await prisma.lendingAlertWatch.update({ where: { id: w.id }, data: { lastNotifiedGrade: latest.grade, lastNotifiedAt: new Date() } });
        sent++;
      }
    } catch { /* retried next run: lastNotifiedGrade is unchanged */ }
  }
  return sent;
}

export type StoredYield = YieldOption & { gradeDetail: YieldGradeResult };
export const parseStored = (data: string) => JSON.parse(data) as StoredYield;

/** The table: listed options, best grade first, then highest rate. */
export async function listYield(prisma: PrismaClient, asset?: "XRP" | "RLUSD") {
  const rows = await prisma.yieldOption.findMany({ where: { listed: true } });
  const all = rows.map((r) => ({ row: r, o: parseStored(r.data) }));
  const filtered = asset ? all.filter(({ o }) => o.asset === asset || (asset === "RLUSD" && o.kind === "amm" && /RLUSD/.test(o.name))) : all;
  return filtered.sort((a, b) => b.row.score - a.row.score || (b.o.rate ?? -1) - (a.o.rate ?? -1));
}

export async function lastRefresh(prisma: PrismaClient): Promise<Date | null> {
  return (await prisma.indexerCheckpoint.findUnique({ where: { id: "yield-refresh" } }))?.lastCompletedPassAt ?? null;
}
