// src/lib/lendingGrade.ts — XRPL Lending risk grades (A–F) for vaults and loan brokers.
//
// PURE: no I/O. Input is the on-ledger facts (src/lib/lendingFacts.ts reads them); output is a grade, a 0–100
// score, the metrics behind it and every rule that moved it. The same rules are rendered word for word on
// /lending/method, so the published method and the code cannot drift apart.
//
// This is a RISK GRADE built only from public ledger data. It is never a "credit rating": it does not assess any
// borrower's ability to pay (that is off-ledger by design in XLS-66), and it is not investment advice.
//
// A copy of this file lives in the uxus repo (cryptorisk-api: lib/xrpl-lending/grade.ts) for the paid grade API.
// Change both together and bump METHOD_VERSION.

export const METHOD_VERSION = "lending-grade-v1";

export interface LoanFacts {
  id: string;
  borrower: string;
  principalOutstanding: number;
  totalValueOutstanding: number;
  defaulted: boolean;
  impaired: boolean;
  /** Past NextPaymentDueDate and not defaulted. */
  late: boolean;
  daysLate: number;
  interestRatePct: number;
  nextPaymentDue: string | null;
}

export interface BrokerFacts {
  id: string;
  account: string;
  owner: string;
  vaultId: string;
  debtTotal: number;
  debtMaximum: number; // 0 = no limit
  coverAvailable: number;
  coverRateMinimumPct: number; // percent (ledger stores 1/10 basis points)
  coverRateLiquidationPct: number;
  managementFeePct: number;
  activeLoans: number;
  loansEver: number;
  createdAt: string | null;
  loans: LoanFacts[];
}

export interface VaultFacts {
  id: string;
  account: string;
  owner: string;
  assetLabel: string;
  assetsTotal: number;
  assetsAvailable: number;
  assetsMaximum: number; // 0 = no cap
  lossUnrealized: number;
  sharesOutstanding: number | null;
  isPrivate: boolean;
  createdAt: string | null;
  /** Value of one share now, and some days ago (for realized yield). */
  shareValueNow: number | null;
  shareValuePast: { value: number; daysAgo: number } | null;
  brokers: BrokerFacts[];
}

export type Letter = "A" | "B" | "C" | "D" | "F" | "N/A";
export interface Adjustment {
  rule: string; // rule id, see RULES
  points: number; // negative = deduction; 0 with a note for caps
  why: string; // plain English, with the numbers
}
export interface GradeResult {
  grade: Letter;
  score: number | null;
  capped: string | null;
  adjustments: Adjustment[];
  metrics: Record<string, number | string | boolean | null>;
  methodVersion: string;
  disclaimer: string;
}

export const DISCLAIMER =
  "Risk grade computed only from public XRP Ledger data by XRPLHub's published method. Not a credit rating, not an assessment of any borrower, not investment advice.";

/** The published method. Rendered on /lending/method; every adjustment cites one of these ids. */
export const RULES: { id: string; applies: "broker" | "vault" | "both"; text: string }[] = [
  { id: "BANDS", applies: "both", text: "Every vault and broker starts at 100 points. A = 85 or more, B = 70–84, C = 55–69, D = 40–54, F = below 40." },
  { id: "B-DEFAULT", applies: "broker", text: "Defaulted loans: minus 3 points for every 1% of the broker's outstanding principal that is in loans marked defaulted, up to minus 60." },
  { id: "B-IMPAIRED", applies: "broker", text: "Impaired loans: minus 1.5 points for every 1% of outstanding principal in loans the broker has marked impaired, up to minus 30." },
  { id: "B-LATE", applies: "broker", text: "Late loans: minus 1 point for every 1% of outstanding principal in loans past their payment due date (not yet defaulted), up to minus 20." },
  { id: "B-COVER", applies: "broker", text: "First-loss cover (the broker's own money that absorbs losses before depositors), as a share of what it has lent: 10% or more, no change; 5–10%, minus 5; 1–5%, minus 12; under 1%, minus 20." },
  { id: "B-COVER-MIN", applies: "broker", text: "Cover below the broker's own required minimum (debt × its minimum cover rate): minus 15." },
  { id: "B-CONCENTRATION", applies: "broker", text: "One loan over 50% of outstanding principal: minus 10. Over 25%: minus 5." },
  { id: "B-HISTORY", applies: "broker", text: "Fewer than 5 loans ever made, or a broker less than 90 days old: the grade is capped at B, because there isn't enough history to earn an A." },
  { id: "B-NONE", applies: "broker", text: "A broker that has nothing lent out gets N/A — there is nothing to grade yet." },
  { id: "V-BROKERS", applies: "vault", text: "A vault starts from the average score of the brokers lending from it, weighted by how much each has lent. A vault with nothing lent out starts at 100." },
  { id: "V-LOSS", applies: "vault", text: "Unrealized loss the ledger has recorded against the vault: minus 2.5 points for every 1% of the vault's total value, up to minus 50." },
  { id: "V-LIQUIDITY", applies: "vault", text: "Share of the vault lent out (utilization): over 95%, minus 15 — withdrawals may have to wait for repayments; over 85%, minus 7." },
  { id: "V-YIELD", applies: "vault", text: "Realized yield (change in the value of one vault share, annualized, measured over at least 30 days) below zero: minus 15." },
  { id: "V-HISTORY", applies: "vault", text: "A vault less than 90 days old is capped at B." },
  { id: "V-NONE", applies: "vault", text: "An empty vault gets N/A." },
];

const DAY = 86_400_000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const ageDays = (iso: string | null, now: number) => (iso ? (now - Date.parse(iso)) / DAY : null);

export function letter(score: number): Exclude<Letter, "N/A"> {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
}
function capAtB(score: number): number {
  return Math.min(score, 84);
}

export function brokerMetrics(b: BrokerFacts) {
  const principal = b.loans.reduce((s, l) => s + l.principalOutstanding, 0);
  const share = (f: (l: LoanFacts) => boolean) => (principal > 0 ? b.loans.filter(f).reduce((s, l) => s + l.principalOutstanding, 0) / principal : 0);
  const requiredCover = (b.debtTotal * b.coverRateMinimumPct) / 100;
  return {
    debtTotal: b.debtTotal,
    principalOutstanding: round(principal, 6),
    coverAvailable: b.coverAvailable,
    requiredCover: round(requiredCover, 6),
    /** CoverAvailable against DebtTotal × CoverRateMinimum. 1 = exactly the minimum. */
    coverRatio: requiredCover > 0 ? round(b.coverAvailable / requiredCover) : null,
    coverPctOfDebt: b.debtTotal > 0 ? round((b.coverAvailable / b.debtTotal) * 100, 2) : null,
    utilizationOfLimit: b.debtMaximum > 0 ? round((b.debtTotal / b.debtMaximum) * 100, 2) : null,
    activeLoans: b.activeLoans,
    loansEver: b.loansEver,
    lateLoans: b.loans.filter((l) => l.late).length,
    impairedLoans: b.loans.filter((l) => l.impaired && !l.defaulted).length,
    defaultedLoans: b.loans.filter((l) => l.defaulted).length,
    defaultedPct: round(share((l) => l.defaulted) * 100, 2),
    impairedPct: round(share((l) => l.impaired && !l.defaulted) * 100, 2),
    latePct: round(share((l) => l.late && !l.impaired && !l.defaulted) * 100, 2),
    largestLoanPct: principal > 0 ? round((Math.max(...b.loans.map((l) => l.principalOutstanding)) / principal) * 100, 2) : null,
  };
}

export function gradeBroker(b: BrokerFacts, now = Date.now()): GradeResult {
  const m = brokerMetrics(b);
  const base = { methodVersion: METHOD_VERSION, disclaimer: DISCLAIMER };
  if (b.debtTotal <= 0 && m.principalOutstanding <= 0) {
    return { ...base, grade: "N/A", score: null, capped: null, adjustments: [{ rule: "B-NONE", points: 0, why: "Nothing is lent out yet." }], metrics: m };
  }
  const adj: Adjustment[] = [];
  const add = (rule: string, points: number, why: string) => { if (points !== 0) adj.push({ rule, points: round(points, 1), why }); };
  add("B-DEFAULT", -clamp(m.defaultedPct * 3, 0, 60), `${m.defaultedPct}% of outstanding principal is in defaulted loans (${m.defaultedLoans}).`);
  add("B-IMPAIRED", -clamp(m.impairedPct * 1.5, 0, 30), `${m.impairedPct}% is in impaired loans (${m.impairedLoans}).`);
  add("B-LATE", -clamp(m.latePct, 0, 20), `${m.latePct}% is in loans past their payment due date (${m.lateLoans}).`);
  const c = m.coverPctOfDebt ?? 0;
  const coverPts = c >= 10 ? 0 : c >= 5 ? -5 : c >= 1 ? -12 : -20;
  add("B-COVER", coverPts, `First-loss cover is ${c}% of what the broker has lent.`);
  if (m.coverRatio != null && m.coverRatio < 1) add("B-COVER-MIN", -15, `Cover is ${round(m.coverRatio * 100, 1)}% of the broker's own required minimum.`);
  if (m.largestLoanPct != null && m.largestLoanPct > 50) add("B-CONCENTRATION", -10, `The largest loan is ${m.largestLoanPct}% of outstanding principal.`);
  else if (m.largestLoanPct != null && m.largestLoanPct > 25) add("B-CONCENTRATION", -5, `The largest loan is ${m.largestLoanPct}% of outstanding principal.`);
  let score = clamp(100 + adj.reduce((s, a) => s + a.points, 0), 0, 100);
  let capped: string | null = null;
  const age = ageDays(b.createdAt, now);
  if (b.loansEver < 5 || age == null || age < 90) {
    const capped84 = capAtB(score);
    if (capped84 < score) { score = capped84; }
    capped = `Limited history (${b.loansEver} loan${b.loansEver === 1 ? "" : "s"} ever, ${age == null ? "age unknown" : `${Math.floor(age)} days old`}): capped at B.`;
    adj.push({ rule: "B-HISTORY", points: 0, why: capped });
  }
  score = Math.round(score);
  return { ...base, grade: letter(score), score, capped, adjustments: adj, metrics: m };
}

export function vaultMetrics(v: VaultFacts) {
  const onLoan = Math.max(0, v.assetsTotal - v.assetsAvailable);
  let realizedYieldPct: number | null = null;
  if (v.shareValueNow != null && v.shareValuePast && v.shareValuePast.value > 0 && v.shareValuePast.daysAgo >= 7) {
    realizedYieldPct = round((Math.pow(v.shareValueNow / v.shareValuePast.value, 365 / v.shareValuePast.daysAgo) - 1) * 100, 2);
  }
  return {
    assetsTotal: v.assetsTotal,
    assetsAvailable: v.assetsAvailable,
    onLoan: round(onLoan, 6),
    utilizationPct: v.assetsTotal > 0 ? round((onLoan / v.assetsTotal) * 100, 2) : null,
    lossUnrealized: v.lossUnrealized,
    lossPct: v.assetsTotal > 0 ? round((v.lossUnrealized / v.assetsTotal) * 100, 2) : null,
    sharesOutstanding: v.sharesOutstanding,
    shareValue: v.shareValueNow,
    realizedYieldPct,
    yieldMeasuredOverDays: v.shareValuePast?.daysAgo ?? null,
    brokers: v.brokers.length,
    isPrivate: v.isPrivate,
  };
}

export function gradeVault(v: VaultFacts, now = Date.now()): GradeResult & { brokerGrades: Record<string, GradeResult> } {
  const m = vaultMetrics(v);
  const brokerGrades = Object.fromEntries(v.brokers.map((b) => [b.id, gradeBroker(b, now)]));
  const base = { methodVersion: METHOD_VERSION, disclaimer: DISCLAIMER, brokerGrades };
  if (v.assetsTotal <= 0) {
    return { ...base, grade: "N/A", score: null, capped: null, adjustments: [{ rule: "V-NONE", points: 0, why: "The vault is empty." }], metrics: m };
  }
  const adj: Adjustment[] = [];
  const add = (rule: string, points: number, why: string) => { if (points !== 0) adj.push({ rule, points: round(points, 1), why }); };
  const lending = v.brokers.filter((b) => b.debtTotal > 0 && brokerGrades[b.id].score != null);
  const weight = lending.reduce((s, b) => s + b.debtTotal, 0);
  const start = weight > 0 ? lending.reduce((s, b) => s + (brokerGrades[b.id].score as number) * b.debtTotal, 0) / weight : 100;
  if (start < 100) adj.push({ rule: "V-BROKERS", points: round(start - 100, 1), why: `Lent out through ${lending.length} broker${lending.length === 1 ? "" : "s"} with a weighted score of ${Math.round(start)}.` });
  add("V-LOSS", -clamp((m.lossPct ?? 0) * 2.5, 0, 50), `The ledger records an unrealized loss of ${m.lossPct}% of the vault.`);
  const u = m.utilizationPct ?? 0;
  add("V-LIQUIDITY", u > 95 ? -15 : u > 85 ? -7 : 0, `${u}% of the vault is lent out.`);
  if (m.realizedYieldPct != null && (m.yieldMeasuredOverDays ?? 0) >= 30 && m.realizedYieldPct < 0) add("V-YIELD", -15, `One share lost value: ${m.realizedYieldPct}% a year over the last ${m.yieldMeasuredOverDays} days.`);
  let score = clamp(100 + adj.reduce((s, a) => s + a.points, 0), 0, 100);
  let capped: string | null = null;
  const age = ageDays(v.createdAt, now);
  if (age == null || age < 90) {
    score = capAtB(score);
    capped = `The vault is ${age == null ? "of unknown age" : `${Math.floor(age)} days old`}: capped at B.`;
    adj.push({ rule: "V-HISTORY", points: 0, why: capped });
  }
  score = Math.round(score);
  return { ...base, grade: letter(score), score, capped, adjustments: adj, metrics: m };
}
