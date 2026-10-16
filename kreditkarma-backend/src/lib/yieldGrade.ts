// src/lib/yieldGrade.ts — the A–F risk grade for ways to earn on XRP and RLUSD (/yield).
//
// Pure: no network, no database. RULES is the published method (/yield/method renders it), and grade() applies
// exactly those rules, so the page and the code can't drift apart. Inputs are the public facts we hold about an
// option (YieldOption); every point taken off comes with a plain-English reason.
//
// A risk grade is not advice and not a credit rating. It says how many things could go wrong between you and
// your money, judged from public data — not whether the yield is worth it for you.

export const METHOD_VERSION = "yield-grade-v1";

export type Custody =
  | "self" // native XRPL feature: your own wallet holds the position (e.g. AMM LP tokens)
  | "contract" // a smart contract holds the funds; you hold the keys to your wallet
  | "custodian" // a company holds the keys (CeDeFi vaults)
  | "exchange"; // an exchange account

export type Bridge = "none" | "fassets" | "fassets+layerzero" | "binance-peg" | "other";

export interface YieldOption {
  slug: string;
  name: string; // "Doppler XRP Vault"
  provider: string; // "Doppler Finance"
  asset: "XRP" | "RLUSD";
  kind: "amm" | "vault" | "lending" | "lp" | "fixed" | "staking" | "exchange-earn";
  chain: string; // "XRP Ledger", "Flare", "Ethereum", ...
  // Rate: annual, as a fraction (0.03 = 3%). rateBase + rateReward = rate when both are known.
  rate: number | null;
  rateBase: number | null;
  rateReward: number | null; // paid in a separate reward token
  rateKind: string; // plain words: "paid last week", "fee income, last 7 days", "advertised flexible rate", ...
  tvlUsd: number | null;
  sizeNote?: string; // when size means something else (e.g. an exchange's total reserves)
  lockup: string; // plain words
  withdrawal: string; // plain words
  withdrawShort: string; // 2–3 words for the table: "any time", "~7 days", "after 2026-11-26"
  keys: string; // who holds the keys, plain words
  custody: Custody;
  bridge: Bridge;
  layers: number; // smart-contract protocols stacked between you and the asset (0 for native XRPL / exchange)
  launchedAt: string | null; // ISO date the product (or its protocol) started
  launchChecked?: boolean; // DefiLlama pools: the pool-start lookup has been done (so it is not repeated)
  audits: number | null; // public security audits we can link to; null = not applicable (exchange)
  auditLinks: string[];
  proofOfReserves?: boolean; // custodial products only
  ilRisk: boolean; // two-token pool: price moves between the tokens can cost you
  fixedMaturity?: string | null; // ISO date for fixed-term products
  regionNote?: string; // e.g. exchange not available in the US
  url: string; // the product's own page (plain link, no referral code)
  source: { name: string; url: string; at: string }; // where the numbers came from, and when
  notes?: string[];
}

export type Adjustment = { rule: string; points: number; why: string };
export type Grade = "A" | "B" | "C" | "D" | "F";
export interface YieldGradeResult { grade: Grade; score: number; adjustments: Adjustment[]; methodVersion: string }

export const DISCLAIMER =
  "General information for everyone, not personal advice. A risk grade is not a credit rating or a recommendation. We are never paid by the products we grade and take no commission on deposits.";

export type Rule = { id: string; factor: string; text: string };

// The published method. Point values here are the ones grade() uses.
export const RULES: Rule[] = [
  { id: "BANDS", factor: "Scale", text: "Every option starts at 100 points and loses points for each risk below. A = 85 or more, B = 70–84, C = 55–69, D = 40–54, F = under 40." },
  { id: "CUSTODY_CONTRACT", factor: "Custody", text: "Funds sit in a smart contract (you keep your wallet keys, but the code controls the money): −10." },
  { id: "CUSTODY_CUSTODIAN", factor: "Custody", text: "A company holds the keys to the deposited funds: −25." },
  { id: "CUSTODY_EXCHANGE", factor: "Custody", text: "Funds sit in an exchange account; the exchange holds the keys: −25." },
  { id: "LAYERS", factor: "Contract and bridge risk", text: "Each extra smart-contract protocol stacked on top of another (for example a fixed-rate token built on a staking vault): −5 per extra layer." },
  { id: "BRIDGE_FASSETS", factor: "Contract and bridge risk", text: "Your XRP is turned into FXRP on Flare through FAssets (backed by collateralized agents): −10." },
  { id: "BRIDGE_MULTI", factor: "Contract and bridge risk", text: "FXRP is bridged again to another chain (LayerZero): a further −5." },
  { id: "BRIDGE_PEG", factor: "Contract and bridge risk", text: "XRP on another chain is an IOU issued by one company (for example Binance-Peg XRP): −10." },
  { id: "SIZE", factor: "Size", text: "Money in the product: under $1M −15; $1M–$10M −8; $10M–$50M −3; $50M or more 0. Unknown size −10 (exchange products: the exchange's own reserves are used instead)." },
  { id: "AGE", factor: "Age", text: "Time since launch: under 90 days −15; under 1 year −8; under 2 years −3; 2 years or more 0. Unknown −10." },
  { id: "AUDITS", factor: "Audits", text: "Smart-contract or custodial products with no public security audit we can link to: −10. Custodial products with no public proof of reserves: a further −5. Exchanges are not scored on this." },
  { id: "REWARD_HEAVY", factor: "Track record", text: "More than half the rate is paid in a separate reward token, which can stop or lose value: −8." },
  { id: "RATE_HIGH", factor: "Track record", text: "A rate above 20% a year: −10. Rates that high usually come with risk that isn't visible in the numbers." },
  { id: "RATE_UNSTABLE", factor: "Track record", text: "The rate moved by more than half (up or down) between the last 7 days and the 30 days before (needs 14+ days of our own history): −5." },
  { id: "SHRINKING", factor: "Track record", text: "Money in the product fell by more than 30% in the last 30 days (needs 14+ days of our own history): −8." },
  { id: "IL", factor: "Concentration", text: "A two-token pool: if one token's price moves against the other you can end up with less than if you had just held (impermanent loss): −10." },
  { id: "CONCENTRATION_ONE_VENUE", factor: "Concentration", text: "The strategy depends on one outside company or exchange to hold or trade the funds: −5." },
  { id: "LOCKUP", factor: "Withdrawal", text: "Withdrawals take more than 3 days, or the money is locked until a fixed date: −5." },
];

export const bandFor = (score: number): Grade => (score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F");

/** History we hold about an option: lets the track-record rules apply once we have enough of it. */
export interface YieldHistory {
  days: number; // how many daily observations we hold
  apr7d: number | null; // average rate, last 7 days
  aprPrior30d: number | null; // average rate, the 30 days before that
  tvlNow: number | null;
  tvl30dAgo: number | null;
}

export interface GradeContext {
  now?: Date;
  history?: YieldHistory | null;
  withdrawalDays?: number | null; // parsed by the source adapter; > 3 → LOCKUP
  oneVenue?: boolean; // depends on one outside company/exchange (set by the adapter)
}

export function grade(o: YieldOption, ctx: GradeContext = {}): YieldGradeResult {
  const now = ctx.now ?? new Date();
  const adj: Adjustment[] = [];
  const take = (rule: string, points: number, why: string) => adj.push({ rule, points: -Math.abs(points), why });

  // Custody
  if (o.custody === "contract") take("CUSTODY_CONTRACT", 10, "A smart contract holds the money. You keep your own wallet keys, but a bug in the code could lose funds.");
  else if (o.custody === "custodian") take("CUSTODY_CUSTODIAN", 25, `A company holds the keys to deposited funds (${o.keys}). You rely on it to give the money back.`);
  else if (o.custody === "exchange") take("CUSTODY_EXCHANGE", 25, `The exchange holds the keys (${o.keys}). If it fails or freezes withdrawals, you wait in line with its other customers.`);

  // Contract and bridge risk
  if (o.layers > 1) take("LAYERS", 5 * (o.layers - 1), `${o.layers} smart-contract protocols are stacked here; a problem in any one of them affects you.`);
  if (o.bridge === "fassets" || o.bridge === "fassets+layerzero") take("BRIDGE_FASSETS", 10, "Your XRP becomes FXRP on Flare through FAssets. FXRP is only as good as the agents and collateral behind it.");
  if (o.bridge === "fassets+layerzero") take("BRIDGE_MULTI", 5, "The FXRP is bridged again to another chain, adding a second bridge.");
  if (o.bridge === "binance-peg") take("BRIDGE_PEG", 10, "This is an XRP IOU issued by one company on another chain, not XRP itself.");
  if (o.bridge === "other") take("BRIDGE_PEG", 10, "The XRP here is a bridged or wrapped version on another chain.");

  // Size
  const size = o.tvlUsd;
  if (size == null) take("SIZE", 10, "We can't see how much money is in it.");
  else if (size < 1e6) take("SIZE", 15, `Small: about ${usd(size)} in it.`);
  else if (size < 1e7) take("SIZE", 8, `About ${usd(size)} in it — still small enough that a few large holders can move it.`);
  else if (size < 5e7) take("SIZE", 3, `About ${usd(size)} in it.`);

  // Age
  if (!o.launchedAt) take("AGE", 10, "We can't confirm when it launched.");
  else {
    const days = (now.getTime() - Date.parse(o.launchedAt)) / 86_400_000;
    if (days < 90) take("AGE", 15, `New: launched ${Math.max(0, Math.floor(days))} days ago.`);
    else if (days < 365) take("AGE", 8, `Under a year old (launched ${Math.floor(days / 30)} months ago).`);
    else if (days < 730) take("AGE", 3, "Under two years old.");
  }

  // Audits (not scored for exchanges or native XRPL features — there is no product code of theirs to audit)
  if (o.custody === "contract" || o.custody === "custodian") {
    if (!o.audits) take("AUDITS", 10, "No public security audit we can link to.");
    if (o.custody === "custodian" && !o.proofOfReserves) take("AUDITS", 5, "No public proof of reserves.");
  }

  // Track record
  if (o.rate != null && o.rateReward != null && o.rate > 0 && o.rateReward / o.rate > 0.5) {
    take("REWARD_HEAVY", 8, `${Math.round((o.rateReward / o.rate) * 100)}% of the rate is paid in a reward token that can stop or fall in value.`);
  }
  if (o.rate != null && o.rate > 0.2) take("RATE_HIGH", 10, `The rate (${pct(o.rate)}) is very high. High rates usually pay for risk you can't see.`);
  const h = ctx.history;
  if (h && h.days >= 14) {
    if (h.apr7d != null && h.aprPrior30d != null && h.aprPrior30d > 0) {
      const move = Math.abs(h.apr7d - h.aprPrior30d) / h.aprPrior30d;
      if (move > 0.5) take("RATE_UNSTABLE", 5, `The rate moved a lot: ${pct(h.aprPrior30d)} on average before, ${pct(h.apr7d)} over the last 7 days.`);
    }
    if (h.tvlNow != null && h.tvl30dAgo != null && h.tvl30dAgo > 0 && h.tvlNow < h.tvl30dAgo * 0.7) {
      take("SHRINKING", 8, `Money is leaving: ${usd(h.tvl30dAgo)} 30 days ago, ${usd(h.tvlNow)} now.`);
    }
  }

  // Concentration
  if (o.ilRisk) take("IL", 10, "Two-token pool: if the prices move apart you can end up with less than if you had just held.");
  if (ctx.oneVenue) take("CONCENTRATION_ONE_VENUE", 5, "The strategy depends on one outside company or exchange.");

  // Withdrawal
  if (o.fixedMaturity) take("LOCKUP", 5, `Fixed term until ${o.fixedMaturity.slice(0, 10)}; leaving early means selling at the market price.`);
  else if (ctx.withdrawalDays != null && ctx.withdrawalDays > 3) take("LOCKUP", 5, `Withdrawals take about ${ctx.withdrawalDays} days.`);

  const score = Math.max(0, 100 + adj.reduce((s, a) => s + a.points, 0));
  return { grade: bandFor(score), score, adjustments: adj, methodVersion: METHOD_VERSION };
}

export const pct = (x: number | null | undefined, digits = 2) =>
  x == null ? "—" : `${(x * 100).toFixed(x * 100 >= 10 ? 1 : digits)}%`;

export function usd(x: number | null | undefined): string {
  if (x == null) return "—";
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
}
