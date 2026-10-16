// src/app/lending/explorer.ts — data loaders for the phase 2 explorer pages (server only).
// Everything here reads the index built by src/lib/lendingIndex.ts; the pages render nothing until
// lendingLive() is true.
import { prisma } from "@/lib/xrplscore-db";
import { brokerMetrics, type GradeResult } from "@/lib/lendingGrade";
import { brokerFactsFrom, loanFacts, num } from "@/lib/lendingFacts";

export type StoredGrade = { grade: string; score: number; takenAt: Date; metrics: GradeResult["metrics"]; adjustments: GradeResult["adjustments"]; capped: string | null };

export async function latestGrade(subjectType: "vault" | "broker", subjectId: string): Promise<StoredGrade | null> {
  const g = await prisma.lendingGrade.findFirst({ where: { network: "mainnet", subjectType, subjectId }, orderBy: { takenAt: "desc" } });
  if (!g) return null;
  const m = JSON.parse(g.metrics) as { metrics: GradeResult["metrics"]; adjustments: GradeResult["adjustments"]; capped: string | null };
  return { grade: g.grade, score: g.score, takenAt: g.takenAt, ...m };
}

export async function gradeHistory(subjectType: "vault" | "broker", subjectId: string, days = 30) {
  return prisma.lendingGrade.findMany({
    where: { network: "mainnet", subjectType, subjectId, takenAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { takenAt: "asc" },
    select: { grade: true, score: true, takenAt: true },
  });
}

export async function vaultList() {
  const vaults = await prisma.lendingVault.findMany({ where: { network: "mainnet", deleted: false }, orderBy: { updatedAt: "desc" }, take: 500 });
  const grades = await Promise.all(vaults.map((v) => latestGrade("vault", v.id)));
  return vaults
    .map((v, i) => ({ v, g: grades[i], total: num(v.assetsTotal), available: num(v.assetsAvailable) }))
    .sort((a, b) => b.total - a.total);
}

export async function brokerDetail(id: string) {
  const b = await prisma.lendingBroker.findUnique({ where: { id } });
  if (!b || b.network !== "mainnet") return null;
  const loans = await prisma.lendingLoan.findMany({ where: { brokerId: id, closed: false } });
  const facts = brokerFactsFrom(JSON.parse(b.raw), loans.map((l) => JSON.parse(l.raw)), null, Date.now());
  return { b, loans: loans.map((l) => ({ row: l, f: loanFacts(JSON.parse(l.raw), Date.now()) })), metrics: brokerMetrics(facts) };
}

export async function recentTxs(where: { vaultId?: string; brokerId?: string }, take = 25) {
  return prisma.lendingTx.findMany({ where: { network: "mainnet", ...where }, orderBy: { ledgerIndex: "desc" }, take, select: { hash: true, txType: true, closeTime: true, result: true, account: true } });
}

export const GRADE_COLOR: Record<string, string> = { A: "#047857", B: "#0f766e", C: "#a16207", D: "#c2410c", F: "#b91c1c", "N/A": "#666" };
export const fmtNum = (n: number | null | undefined, d = 2) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
