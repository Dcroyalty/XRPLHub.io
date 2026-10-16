// src/lib/lendingIndex.ts — XRPL Lending phase 2: the vault / broker / loan index, grades and Pro alerts.
//
// Runs from the hourly job ONLY once LendingProtocol + SingleAssetVault are enabled on mainnet (lendingLive()).
// Each run, inside a time budget:
//   1. Discovery: a resumable ledger_data walk over type "vault" (marker kept in IndexerCheckpoint
//      `lending-walk:<network>`). Pinned to one node, because a saved marker only resumes on the node that
//      issued it (see markerWalk.ts). Brokers and loans are then reached through each vault (lendingFacts.ts).
//   2. Refresh: the stalest known vaults first — vault, brokers, loans, lending transactions — then a grade
//      for the vault and each broker, stored in LendingGrade (the history XRPLHub Pro serves).
//   3. Alerts: XRPLHub Pro watches whose subject's grade changed get a signed webhook.
// Read-only: XRPLHub never holds funds or keys and never lends.

import type { PrismaClient } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import { readVault, lendingTxs, type LedgerRpc, num } from "./lendingFacts";
import { gradeVault, METHOD_VERSION, type GradeResult } from "./lendingGrade";
import { postWebhook, webhookHeaders, checkWebhookUrl, type Poster } from "./monitorWebhook";
import { randomBytes } from "crypto";

/** Mainnet reads through XRPLHub's node pool (rotation, cooldowns, consensus guard). */
export const mainnetRpc: LedgerRpc = async (method, params) => {
  const r = await xrplRpc(method, params, 12_000);
  if (!r.ok) return null;
  return ((r.body as { result?: Record<string, any> }).result ?? null) as Record<string, any> | null;
};

/** A plain JSON-RPC client for one URL (Devnet tests, and the pinned discovery walk). */
export function urlRpc(url: string, timeoutMs = 15_000): LedgerRpc {
  return async (method, params) => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const j = (await r.json()) as { result?: Record<string, any> };
      return j.result ?? null;
    } catch {
      return null;
    }
  };
}

const WALK_NODE: Record<string, string> = { mainnet: "https://xrplcluster.com", devnet: "https://s.devnet.rippletest.net:51234" };

export interface IndexOptions {
  network: string; // "mainnet" | "devnet"
  budgetMs: number;
  rpc?: LedgerRpc; // defaults: mainnetRpc / the devnet URL
  walkRpc?: LedgerRpc;
  poster?: Poster; // alert delivery (tests stub it)
  onlyVaults?: string[]; // test hook: refresh exactly these vaults, skip discovery
}
export interface IndexReport {
  discovered: number;
  walkPagesThisRun: number;
  walkComplete: boolean;
  refreshed: number;
  grades: number;
  txs: number;
  alertsSent: number;
  errors: string[];
}

async function discover(prisma: PrismaClient, network: string, walkRpc: LedgerRpc, deadline: number, rep: IndexReport): Promise<void> {
  const id = `lending-walk:${network}`;
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id } });
  let marker: unknown = cp?.marker ? JSON.parse(cp.marker) : undefined;
  let restarted = false;
  while (Date.now() < deadline) {
    const r = await walkRpc("ledger_data", { ledger_index: "validated", type: "vault", limit: 400, ...(marker ? { marker } : {}) });
    if (!r || r.error) {
      // A marker the node no longer accepts: start the pass over once, otherwise try again next run.
      if (marker && !restarted && r?.error && /marker/i.test(String(r.error) + String(r.error_message ?? ""))) {
        marker = undefined;
        restarted = true;
        continue;
      }
      rep.errors.push(`walk: ${r?.error ?? "no answer"}`);
      break;
    }
    rep.walkPagesThisRun++;
    for (const v of (r.state as Record<string, any>[]) ?? []) {
      if (v.LedgerEntryType !== "Vault") continue;
      const exists = await prisma.lendingVault.findUnique({ where: { id: String(v.index) }, select: { id: true } });
      if (!exists) {
        await upsertVaultRow(prisma, network, v, num(r.ledger_index));
        rep.discovered++;
      }
    }
    marker = r.marker;
    if (!marker) {
      rep.walkComplete = true;
      break;
    }
  }
  const data = { status: rep.walkComplete ? "idle" : "running", marker: marker ? JSON.stringify(marker) : null, ...(rep.walkComplete ? { lastCompletedPassAt: new Date() } : {}) };
  await prisma.indexerCheckpoint.upsert({ where: { id }, create: { id, ...data }, update: data });
}

function vaultData(network: string, v: Record<string, any>, ledger: number, shares: number | null) {
  return {
    network,
    account: String(v.Account),
    owner: String(v.Owner),
    asset: JSON.stringify(v.Asset ?? null),
    assetLabel: "",
    assetsTotal: String(v.AssetsTotal ?? "0"),
    assetsAvailable: String(v.AssetsAvailable ?? "0"),
    assetsMaximum: String(v.AssetsMaximum ?? "0"),
    lossUnrealized: String(v.LossUnrealized ?? "0"),
    sharesOutstanding: shares == null ? null : String(shares),
    shareMptId: String(v.ShareMPTID ?? ""),
    isPrivate: (num(v.Flags) & 0x00010000) !== 0,
    withdrawalPolicy: num(v.WithdrawalPolicy),
    lastLedger: ledger,
    deleted: false,
    raw: JSON.stringify(v),
  };
}
async function upsertVaultRow(prisma: PrismaClient, network: string, v: Record<string, any>, ledger: number, shares: number | null = null, label?: string) {
  const data = { ...vaultData(network, v, ledger, shares), ...(label ? { assetLabel: label } : {}) };
  await prisma.lendingVault.upsert({ where: { id: String(v.index) }, create: { id: String(v.index), ...data }, update: data });
}

/** Refresh one vault and everything under it. Returns the grade results. */
export async function refreshVault(prisma: PrismaClient, network: string, rpc: LedgerRpc, vaultId: string, rep: IndexReport): Promise<ReturnType<typeof gradeVault> | null> {
  const ledger = num((await rpc("ledger", { ledger_index: "validated" }))?.ledger_index);
  const read = await readVault(rpc, vaultId);
  if (!read) {
    // Gone from the ledger (VaultDelete) — keep the history, mark it deleted.
    await prisma.lendingVault.updateMany({ where: { id: vaultId }, data: { deleted: true, lastLedger: ledger } });
    return null;
  }
  const { raw, brokersRaw, loansRaw, facts } = read;
  await upsertVaultRow(prisma, network, raw, ledger, facts.sharesOutstanding, facts.assetLabel);

  for (const b of brokersRaw) {
    const id = String(b.index);
    const data = {
      network, account: String(b.Account), owner: String(b.Owner), vaultId,
      debtTotal: String(b.DebtTotal ?? "0"), debtMaximum: String(b.DebtMaximum ?? "0"), coverAvailable: String(b.CoverAvailable ?? "0"),
      coverRateMinimum: num(b.CoverRateMinimum), coverRateLiquidation: num(b.CoverRateLiquidation), managementFeeRate: num(b.ManagementFeeRate),
      ownerCount: num(b.OwnerCount), loanSequence: num(b.LoanSequence), lastLedger: ledger, deleted: false, raw: JSON.stringify(b),
    };
    await prisma.lendingBroker.upsert({ where: { id }, create: { id, ...data }, update: data });
    const live = loansRaw[id] ?? [];
    for (const l of live) {
      const lid = String(l.index);
      const flags = num(l.Flags);
      const prev = await prisma.lendingLoan.findUnique({ where: { id: lid }, select: { defaultedAt: true, impairedAt: true } });
      const ldata = {
        network, brokerId: id, borrower: String(l.Borrower), flags,
        principalOutstanding: String(l.PrincipalOutstanding ?? "0"), totalValueOutstanding: String(l.TotalValueOutstanding ?? "0"),
        periodicPayment: String(l.PeriodicPayment ?? "0"), interestRate: num(l.InterestRate), paymentInterval: num(l.PaymentInterval),
        gracePeriod: num(l.GracePeriod), nextPaymentDueDate: typeof l.NextPaymentDueDate === "number" ? l.NextPaymentDueDate : null,
        paymentRemaining: num(l.PaymentRemaining), startDate: num(l.StartDate), closed: false,
        defaultedAt: prev?.defaultedAt ?? (flags & 0x00010000 ? new Date() : null),
        impairedAt: prev?.impairedAt ?? (flags & 0x00020000 ? new Date() : null),
        lastLedger: ledger, raw: JSON.stringify(l),
      };
      await prisma.lendingLoan.upsert({ where: { id: lid }, create: { id: lid, ...ldata }, update: ldata });
    }
    // Loans we knew about that are no longer under this broker were repaid or deleted.
    await prisma.lendingLoan.updateMany({ where: { brokerId: id, closed: false, id: { notIn: live.map((l) => String(l.index)) } }, data: { closed: true, lastLedger: ledger } });
  }
  await prisma.lendingBroker.updateMany({ where: { vaultId, deleted: false, id: { notIn: brokersRaw.map((b) => String(b.index)) } }, data: { deleted: true, lastLedger: ledger } });

  // Lending transactions on the vault's and each broker's pseudo-account since the last one we stored.
  // The cursor per pseudo-account is the highest ledger already read (IndexerCheckpoint `lending-tx:<account>`).
  const accounts: { account: string; brokerId: string | null }[] = [
    { account: facts.account, brokerId: null },
    ...brokersRaw.map((b) => ({ account: String(b.Account), brokerId: String(b.index) })),
  ];
  for (const { account, brokerId } of accounts) {
    const cpId = `lending-tx:${network}:${account}`;
    const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: cpId } });
    const since = cp?.marker ? Number(cp.marker) : 0;
    const { txs, throughLedger } = await lendingTxs(rpc, account, since);
    for (const t of txs) {
      const tx = t.tx as Record<string, any>;
      const hash = String(tx.hash ?? t.hash ?? "");
      if (!hash) continue;
      const amount = tx.Amount ?? tx.Amount2 ?? null;
      await prisma.lendingTx.upsert({
        where: { hash },
        create: {
          hash, network, txType: String(tx.TransactionType), ledgerIndex: num(t.ledger_index ?? tx.ledger_index),
          closeTime: new Date(t.close_time_iso ?? ((num(tx.date) + 946_684_800) * 1000)), account: String(tx.Account),
          result: String(t.meta?.TransactionResult ?? ""), vaultId, brokerId: brokerId ?? (tx.LoanBrokerID ? String(tx.LoanBrokerID) : null),
          loanId: tx.LoanID ? String(tx.LoanID) : null, amount: amount == null ? null : JSON.stringify(amount), raw: JSON.stringify({ tx, meta: t.meta ?? null }),
        },
        update: {},
      });
      rep.txs++;
    }
    const top = throughLedger;
    if (top > since) await prisma.indexerCheckpoint.upsert({ where: { id: cpId }, create: { id: cpId, status: "idle", marker: String(top) }, update: { marker: String(top) } });
  }

  const g = gradeVault(facts);
  const rows: { subjectType: string; subjectId: string; r: GradeResult }[] = [
    { subjectType: "vault", subjectId: vaultId, r: g },
    ...Object.entries(g.brokerGrades).map(([id, r]) => ({ subjectType: "broker", subjectId: id, r })),
  ];
  for (const x of rows) {
    await prisma.lendingGrade.create({
      data: { network, subjectType: x.subjectType, subjectId: x.subjectId, grade: x.r.grade, score: x.r.score ?? -1, metrics: JSON.stringify({ metrics: x.r.metrics, adjustments: x.r.adjustments, capped: x.r.capped }), methodVersion: METHOD_VERSION },
    });
    rep.grades++;
  }
  rep.refreshed++;
  return g;
}

/** Send a signed webhook to every XRPLHub Pro lending watch whose subject's grade differs from the last one we sent. */
export async function sendGradeAlerts(prisma: PrismaClient, network: string, poster: Poster = postWebhook): Promise<number> {
  const watches = await prisma.lendingAlertWatch.findMany({ where: { subjectType: { in: ["vault", "broker"] } } });
  let sent = 0;
  for (const w of watches) {
    const latest = await prisma.lendingGrade.findFirst({ where: { network, subjectType: w.subjectType, subjectId: w.subjectId }, orderBy: { takenAt: "desc" } });
    if (!latest || latest.grade === w.lastNotifiedGrade) continue;
    const check = await checkWebhookUrl(w.webhookUrl);
    if (!check.ok) continue;
    const eventId = randomBytes(12).toString("hex");
    const body = JSON.stringify({
      event: "lending.grade_changed", eventId, subjectType: w.subjectType, subjectId: w.subjectId,
      previousGrade: w.lastNotifiedGrade, grade: latest.grade, score: latest.score, at: latest.takenAt.toISOString(),
      url: `https://www.xrplhub.io/lending/${w.subjectType}/${w.subjectId}`, methodVersion: latest.methodVersion,
      disclaimer: "Risk grade from public XRP Ledger data. Not a credit rating, not investment advice.",
    });
    const res = await poster(w.webhookUrl, body, webhookHeaders(w.secret, eventId, "lending.grade_changed", 1, body)).catch(() => ({ ok: false }) as { ok: boolean });
    if (res.ok) {
      await prisma.lendingAlertWatch.update({ where: { id: w.id }, data: { lastNotifiedGrade: latest.grade, lastNotifiedAt: new Date() } });
      sent++;
    }
  }
  return sent;
}

export async function runLendingIndex(prisma: PrismaClient, opts: IndexOptions): Promise<IndexReport> {
  const start = Date.now();
  const deadline = start + opts.budgetMs;
  const rpc = opts.rpc ?? (opts.network === "mainnet" ? mainnetRpc : urlRpc(WALK_NODE[opts.network] ?? WALK_NODE.devnet));
  const walkRpc = opts.walkRpc ?? urlRpc(WALK_NODE[opts.network] ?? WALK_NODE.mainnet);
  const rep: IndexReport = { discovered: 0, walkPagesThisRun: 0, walkComplete: false, refreshed: 0, grades: 0, txs: 0, alertsSent: 0, errors: [] };

  let ids: string[];
  if (opts.onlyVaults) {
    ids = opts.onlyVaults;
  } else {
    // At most a third of the budget on discovery; the rest refreshes what we already know.
    await discover(prisma, opts.network, walkRpc, start + opts.budgetMs / 3, rep).catch((e) => rep.errors.push(`walk: ${e instanceof Error ? e.message : String(e)}`));
    ids = (await prisma.lendingVault.findMany({ where: { network: opts.network, deleted: false }, orderBy: { updatedAt: "asc" }, select: { id: true }, take: 200 })).map((v) => v.id);
  }
  for (const id of ids) {
    if (Date.now() > deadline) break;
    try {
      await refreshVault(prisma, opts.network, rpc, id, rep);
    } catch (e) {
      rep.errors.push(`${id.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      // Touch the row so one bad vault can't hold the front of the queue forever.
      await prisma.lendingVault.updateMany({ where: { id }, data: { lastLedger: { increment: 0 } } }).catch(() => {});
    }
  }
  rep.alertsSent = await sendGradeAlerts(prisma, opts.network, opts.poster).catch(() => 0);
  return rep;
}
