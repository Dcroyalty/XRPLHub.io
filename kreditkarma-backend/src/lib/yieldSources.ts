// src/lib/yieldSources.ts — where the XRP Yield Desk's numbers come from. One adapter per public source.
//
// Each adapter returns the options it can verify right now, plus per-option grading context (withdrawal days,
// one-venue dependence) and anything to remember (e.g. a vault share price for realized-yield math). It never
// makes up a number: if a source doesn't publish something, the field is null and the page says so.
//
//   doppler   — Doppler Finance's public API (api.doppler.finance): vault balances and the weekly rate it paid
//   firelight — the stXRP vault contract on Flare, read directly (ERC-4626 share price and total assets)
//   defillama — DefiLlama's public yields API: Flare FXRP/stXRP products and RLUSD/XRP pools on other chains
//   exchange  — exchange earn programs that publish rates without a login (Binance Simple Earn, OKX Savings)
//   xrpl-amm  — XRPL AMM pools: size from amm_info, fee income from on-ledger trades (src/lib/yieldAmm.ts)
//   xls66     — XLS-66 lending vaults, once lending is live on mainnet (graded by /lending/method)
//
// Static facts (custody, launch dates, audit links, withdrawal terms) are cited in the comments next to them.
import type { YieldOption } from "./yieldGrade";

export interface SourceItem {
  option: YieldOption;
  withdrawalDays?: number | null;
  oneVenue?: boolean;
  extra?: Record<string, unknown>; // stored with today's observation
  externalGrade?: { grade: string; score: number; url: string } | null;
}
export interface SourceResult { name: string; items: SourceItem[]; keep?: string[] } // keep: slugs skipped this run (not unlisted)

const UA = { "user-agent": "xrplhub-yield-desk (+https://www.xrplhub.io/yield)" };

async function getJson<T>(url: string, timeoutMs = 15_000, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { ...UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return (await r.json()) as T;
}

const nowIso = () => new Date().toISOString();
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// ── Doppler Finance ────────────────────────────────────────────────────────────────────────────────────────
// Custody and yield source: docs.doppler.finance (CeDeFi yields): deposit/treasury wallets on Fireblocks MPC,
// assets moved to Ceffu (MirrorX) custody, which can delegate them to Binance; yield from arbitrage and funding
// rates. Withdrawals: "standard 7-day redemption window" (docs: Doppler Vaults → Risks). Audits: CertiK and
// Zenith (docs: Resources → Audits). Proof of reserves: "on-chain proof-of-reserve" plus Ceffu attestations.
const DOPPLER = "https://api.doppler.finance";
type DopplerInfo = { totalStaked: string; pendingWithdrawalAmount: string; chain: string; cap: string | null; apr?: { min: number; max: number }; tokenInfo: { price: number } };
type DopplerSeries = Record<string, { data: { timestamp: number; value: number }[] }>;

export async function dopplerSource(): Promise<SourceResult> {
  const at = nowIso();
  const items: SourceItem[] = [];
  const vaults: { token: "XRP" | "RLUSD"; chain: "xrpl" | "ethereum" }[] = [
    { token: "XRP", chain: "xrpl" },
    { token: "RLUSD", chain: "xrpl" },
    { token: "RLUSD", chain: "ethereum" },
  ];
  const info: Record<string, DopplerInfo[]> = {};
  for (const t of ["XRP", "RLUSD"]) info[t] = await getJson<DopplerInfo[]>(`${DOPPLER}/v2/staking-info/token/${t}`);
  for (const v of vaults) {
    const row = info[v.token].find((r) => r.chain === v.chain);
    if (!row) continue;
    const series = await getJson<DopplerSeries>(`${DOPPLER}/api/v1/analytics/apr?token=${v.token}&blockchain=${v.chain}&period=all`).catch(() => null);
    const points = (series?.[v.token]?.data ?? []).filter((p) => typeof p.value === "number").sort((a, b) => a.timestamp - b.timestamp);
    const last = points.at(-1);
    const units = Number(row.totalStaked) + Number(row.pendingWithdrawalAmount);
    const chainName = v.chain === "xrpl" ? "XRP Ledger" : "Ethereum";
    const rate = last ? last.value : row.apr?.min ?? null;
    items.push({
      option: {
        slug: `doppler-${v.token.toLowerCase()}-vault-${v.chain}`,
        name: `Doppler ${v.token} Vault${v.chain === "ethereum" ? " (Ethereum)" : ""}`,
        provider: "Doppler Finance",
        asset: v.token,
        kind: "vault",
        chain: chainName,
        rate,
        rateBase: rate,
        rateReward: null,
        rateKind: last
          ? `paid in the week to ${new Date(last.timestamp).toISOString().slice(0, 10)} (Doppler's published weekly rate)`
          : "Doppler's advertised minimum (no paid-rate history published)",
        tvlUsd: Number.isFinite(units) ? units * row.tokenInfo.price : null,
        lockup: "No fixed lock, but withdrawals are paid out over about 7 days.",
        withdrawShort: "~7 days",
        withdrawal: "Request a withdrawal; Doppler's standard redemption window is 7 days, and it can be longer when markets are stressed.",
        keys: "Doppler, through Fireblocks and Ceffu custody wallets; Ceffu can delegate the funds to Binance",
        custody: "custodian",
        bridge: "none",
        layers: 0,
        launchedAt: points[0] ? new Date(points[0].timestamp).toISOString() : null,
        audits: 2,
        auditLinks: ["https://skynet.certik.com/projects/doppler-finance", "https://github.com/zenith-security/reports/blob/main/reports/Doppler%20Finance%20%232%20-%20Zenith%20Audit%20Report.pdf"],
        proofOfReserves: true,
        ilRisk: false,
        url: "https://app.doppler.finance/",
        source: { name: "Doppler Finance public API", url: `${DOPPLER}/v2/staking-info/token/${v.token}`, at },
        notes: [
          "Yield comes from trading strategies (arbitrage and funding rates) run off the ledger, not from the XRP Ledger itself.",
          ...(row.cap ? [`Deposit cap: ${Number(row.cap).toLocaleString("en-US")} ${v.token}.`] : []),
          ...(row.apr ? [`Doppler's advertised range: ${(row.apr.min * 100).toFixed(1)}%–${(row.apr.max * 100).toFixed(1)}% a year.`] : []),
        ],
      },
      withdrawalDays: 7,
      oneVenue: true,
    });
  }
  if (!items.length) throw new Error("Doppler API returned no vaults");
  return { name: "doppler", items };
}

// ── Firelight (stXRP on Flare) ─────────────────────────────────────────────────────────────────────────────
// Contract: 0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3 ("Firelight stXRP", ERC-4626 over FXRP
// 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE; a TransparentUpgradeableProxy). Created in Flare block 51573403
// (2025-12-02). Audits: OpenZeppelin and Coinspect (github.com/firelight-protocol/firelight-core/tree/main/audits).
// Yield: premiums from selling DeFi cover; an eligible claim can reduce what depositors get back.
// Withdrawals: paid after the current coverage period ends (one-day periods today).
export const STXRP = "0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3";
export const FIRELIGHT_LAUNCH = "2025-12-02T13:42:49.000Z";
const FLARE_RPC = "https://flare-api.flare.network/ext/C/rpc";

async function ethCall(to: string, data: string): Promise<bigint> {
  const r = await fetch(FLARE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  const j = (await r.json()) as { result?: string; error?: { message: string } };
  if (!j.result || j.result === "0x") throw new Error(`Flare eth_call failed: ${j.error?.message ?? "empty result"}`);
  return BigInt(j.result);
}

/**
 * Firelight's realized rate: from the share price. Before we hold 30 days of our own share-price history the
 * rate is "since launch" (ERC-4626 vaults start at 1 share = 1 FXRP); after that, the last 30 days.
 */
export async function firelightSource(xrpUsd: number, priorSharePrice: { price: number; at: string } | null): Promise<SourceResult> {
  const at = nowIso();
  const totalAssets = Number(await ethCall(STXRP, "0x01e1d114")) / 1e6; // FXRP has 6 decimals
  const sharePrice = Number(await ethCall(STXRP, "0x07a2d13a" + (1_000_000).toString(16).padStart(64, "0"))) / 1e6;
  let rate: number;
  let rateKind: string;
  if (priorSharePrice && (Date.now() - Date.parse(priorSharePrice.at)) / 86_400_000 >= 28) {
    const years = (Date.now() - Date.parse(priorSharePrice.at)) / (365 * 86_400_000);
    rate = (sharePrice / priorSharePrice.price - 1) / years;
    rateKind = "realized over the last 30 days (stXRP share price)";
  } else {
    const years = (Date.now() - Date.parse(FIRELIGHT_LAUNCH)) / (365 * 86_400_000);
    rate = (sharePrice - 1) / years;
    rateKind = "realized since launch (stXRP share price); switches to the last 30 days once we have that history";
  }
  return {
    name: "firelight",
    items: [{
      option: {
        slug: "firelight-stxrp-flare",
        name: "Firelight stXRP",
        provider: "Firelight",
        asset: "XRP",
        kind: "staking",
        chain: "Flare",
        rate,
        rateBase: rate,
        rateReward: null,
        rateKind,
        tvlUsd: totalAssets * xrpUsd,
        lockup: "No fixed lock; withdrawals wait for the current cover period to end.",
        withdrawShort: "1–2 days",
        withdrawal: "Request a withdrawal; it is paid after the current coverage period ends (about 1–2 days with today's one-day periods; longer if 30-day periods are introduced).",
        keys: "A smart contract on Flare (you keep your wallet keys); the contract can be upgraded by its admin",
        custody: "contract",
        bridge: "fassets",
        layers: 1,
        launchedAt: FIRELIGHT_LAUNCH,
        audits: 2,
        auditLinks: ["https://github.com/firelight-protocol/firelight-core/tree/main/audits"],
        ilRisk: false,
        url: "https://firelight.finance/",
        source: { name: "stXRP contract on Flare (read directly)", url: `https://flare-explorer.flare.network/address/${STXRP}`, at },
        notes: [
          "You first turn XRP into FXRP on Flare (FAssets), then deposit FXRP and receive stXRP.",
          "Yield comes from selling DeFi cover. If a covered protocol has a valid claim, depositors can get back less than they put in.",
          "Firelight Points may be paid on top; they are not counted in the rate.",
        ],
      },
      withdrawalDays: 2,
      extra: { sharePrice, totalAssetsFxrp: totalAssets },
    }],
  };
}

// ── DefiLlama yields (Flare FXRP products, RLUSD and XRP elsewhere) ────────────────────────────────────────
type LlamaPool = {
  pool: string; chain: string; project: string; symbol: string; tvlUsd: number; apy: number | null; apyBase: number | null;
  apyReward: number | null; ilRisk: string; exposure: string; poolMeta: string | null; underlyingTokens?: string[] | null;
};
type LlamaProtocol = { slug: string; name: string; url?: string; category?: string; audits?: string; audit_links?: string[]; listedAt?: number };

const XRP_TOKENS = new Set(["XRP", "FXRP", "STXRP", "WXRP", "EARNXRP", "BIZFXRP"]);
const MIN_TVL = 250_000;
const ALLOCATOR = /capital allocator|risk curator|yield aggregator/i;

export function classifyLlamaPool(p: LlamaPool, proto: LlamaProtocol | undefined, poolStart: string | null = null): SourceItem | null {
  const tokens = p.symbol.toUpperCase().split(/[-/ ]+/);
  const hasXrp = tokens.some((t) => XRP_TOKENS.has(t));
  const hasRlusd = tokens.includes("RLUSD");
  if (!hasXrp && !hasRlusd) return null;
  if (p.tvlUsd < MIN_TVL || p.apy == null || p.apy < 0.01) return null; // below 0.01% a year isn't a way to earn
  const asset: "XRP" | "RLUSD" = hasXrp ? "XRP" : "RLUSD";
  const chain = p.chain === "Ripple" ? "XRP Ledger" : p.chain;
  const category = proto?.category ?? "";
  const meta = p.poolMeta ?? "";
  const maturity = meta.match(/Maturity\s+\w{3}\s+(\w{3}\s+\d{1,2}\s+\d{4})/i);
  const fixedMaturity = maturity ? new Date(`${maturity[1]} UTC`).toISOString() : null;
  const multi = p.exposure === "multi" || tokens.length > 1;
  const kind: YieldOption["kind"] = fixedMaturity ? "fixed" : /lending|cdp/i.test(category) ? "lending" : /dex/i.test(category) || multi ? "lp" : ALLOCATOR.test(category) ? "vault" : "vault";

  // Bridge: what "XRP" means on this chain.
  let bridge: YieldOption["bridge"] = "none";
  if (asset === "XRP") {
    const fxrp = tokens.some((t) => t === "FXRP" || t === "STXRP" || t.endsWith("FXRP"));
    if (fxrp) bridge = p.chain === "Flare" ? "fassets" : "fassets+layerzero";
    else if (p.chain === "BSC") bridge = "binance-peg";
    else if (p.chain !== "Ripple") bridge = "other";
  }
  let layers = 1;
  if (tokens.includes("STXRP")) layers++; // built on Firelight's vault
  if (ALLOCATOR.test(category)) layers++; // a vault that puts the money into other protocols

  const withdrawal =
    kind === "fixed" ? `Locked until ${fixedMaturity!.slice(0, 10)}; before that you can only sell your position at the market price.`
    : kind === "lending" ? "Withdraw any time while the pool has unlent cash; if most of it is lent out, you wait until borrowers repay."
    : kind === "lp" ? "Withdraw any time; you get back both tokens in whatever mix the pool holds then."
    : "Withdraw any time, subject to the vault's available cash.";
  const audits = proto?.audits != null ? Number(proto.audits) || 0 : 0;
  const name = `${proto?.name ?? p.project} ${p.symbol}${meta ? ` (${meta.replace(/\s*\|\s*Maturity.*$/i, "").trim()})` : ""}`.replace(/\s+\(\)$/, "");
  const rate = p.apy / 100;
  // Issuer-run funds (DefiLlama category RWA, e.g. mXRP): a company manages the assets behind the token.
  const rwa = /rwa/i.test(category);
  // Age: the earlier of DefiLlama listing the protocol and DefiLlama first tracking this pool.
  const listed = proto?.listedAt ? new Date(proto.listedAt * 1000).toISOString() : null;
  const launchedAt = [listed, poolStart].filter((x): x is string => !!x).sort()[0] ?? null;
  return {
    option: {
      slug: slugify(`${p.project}-${chain}-${p.symbol}-${p.pool.slice(0, 8)}`),
      name,
      provider: proto?.name ?? p.project,
      asset,
      kind,
      chain,
      rate,
      rateBase: p.apyBase != null ? p.apyBase / 100 : null,
      rateReward: p.apyReward != null ? p.apyReward / 100 : null,
      rateKind: "current yearly rate as reported by DefiLlama (it changes every day)",
      tvlUsd: p.tvlUsd,
      lockup: kind === "fixed" ? `Fixed term to ${fixedMaturity!.slice(0, 10)}.` : "None.",
      withdrawal: rwa ? "Redeem through the token issuer on its terms, or sell the token where it trades." : withdrawal,
      withdrawShort: fixedMaturity ? `after ${fixedMaturity.slice(0, 10)}` : rwa ? "issuer terms" : "any time",
      keys: rwa ? `The token issuer (${proto?.name ?? p.project}) manages the assets behind the token` : `A smart contract on ${chain} (you keep your wallet keys)`,
      custody: rwa ? "custodian" : "contract",
      proofOfReserves: rwa ? false : undefined,
      bridge,
      layers,
      launchedAt,
      launchChecked: poolStart !== null || undefined,
      audits,
      auditLinks: proto?.audit_links ?? [],
      ilRisk: p.ilRisk === "yes",
      fixedMaturity,
      url: proto?.url ?? `https://defillama.com/yields/pool/${p.pool}`,
      source: { name: "DefiLlama yields API", url: `https://defillama.com/yields/pool/${p.pool}`, at: nowIso() },
      notes: [
        "Age is when DefiLlama started tracking the protocol or this pool, whichever is earlier: a close stand-in for its launch.",
        ...(bridge === "fassets" ? ["Needs FXRP: XRP turned into a Flare token through FAssets."] : []),
        ...(bridge === "fassets+layerzero" ? ["Needs FXRP bridged from Flare to this chain."] : []),
        ...(bridge === "binance-peg" ? ["Uses Binance-Peg XRP, an IOU issued by Binance on BNB Chain."] : []),
      ],
    },
    withdrawalDays: null,
  };
}

/** First day DefiLlama tracked a pool (yields chart). Cached by the caller, so each pool is looked up once. */
async function poolStartDate(pool: string): Promise<string | null> {
  const j = await getJson<{ data?: { timestamp: string }[] }>(`https://yields.llama.fi/chart/${pool}`, 8_000).catch(() => null);
  const first = j?.data?.[0]?.timestamp;
  return first ? new Date(first).toISOString() : null;
}

export async function defillamaSource(knownLaunch: Record<string, string | null> = {}): Promise<SourceResult & { protocols: LlamaProtocol[] }> {
  const [pools, protocols] = await Promise.all([
    getJson<{ data: LlamaPool[] }>("https://yields.llama.fi/pools", 25_000),
    getJson<LlamaProtocol[]>("https://api.llama.fi/protocols", 25_000),
  ]);
  const bySlug = new Map(protocols.map((p) => [p.slug, p]));
  const items: SourceItem[] = [];
  const candidates: { p: LlamaPool; it: SourceItem }[] = [];
  for (const p of pools.data) {
    if (p.project === "doppler-finance" || p.project === "firelight") continue; // read from the source directly
    const it = classifyLlamaPool(p, bySlug.get(p.project));
    if (it) candidates.push({ p, it });
  }
  // Pool start dates: looked up once per pool (at most 10 per run), then remembered via knownLaunch.
  const lookups = candidates.filter(({ it }) => !(it.option.slug in knownLaunch)).slice(0, 10);
  const starts = new Map(await Promise.all(lookups.map(async ({ p }) => [p.pool, await poolStartDate(p.pool)] as const)));
  for (const { p, it } of candidates) {
    const known = knownLaunch[it.option.slug];
    const start = known != null ? known : starts.get(p.pool) ?? null;
    items.push(classifyLlamaPool(p, bySlug.get(p.project), start) ?? it);
  }
  if (!items.length) throw new Error("DefiLlama returned no XRP or RLUSD pools");
  return { name: "defillama", items, protocols };
}

// ── Exchange earn programs with public rates ───────────────────────────────────────────────────────────────
// Binance Simple Earn (flexible) and OKX Savings publish rates without a login. Founding dates: Binance launched
// July 2017; OKX (as OKEx) launched 2017. Size: the exchange's on-chain reserves per DefiLlama's CEX tracker
// (binance-cex, okx), labeled as such — exchanges don't publish per-product totals.
export async function exchangeSource(protocols: { slug: string; tvl?: number }[] | null): Promise<SourceResult> {
  const at = nowIso();
  const reserves = (slug: string) => protocols?.find((p) => p.slug === slug)?.tvl ?? null;
  const items: SourceItem[] = [];
  const errors: string[] = [];
  for (const asset of ["XRP", "RLUSD"] as const) {
    try {
      const j = await getJson<{ data?: { list?: { highestApy: string; productDetailList?: { productType: string; status: string }[] }[] } }>(
        `https://www.binance.com/bapi/earn/v1/friendly/finance-earn/simple/product/simpleEarnProducts?asset=${asset}&pageSize=5`, 15_000, { "user-agent": "Mozilla/5.0 (compatible; xrplhub-yield-desk)" });
      const p = j.data?.list?.[0];
      if (p && Number(p.highestApy) >= 0.0001 && p.productDetailList?.some((d) => d.productType === "LENDING_FLEXIBLE" && d.status === "ENABLE")) {
        items.push({ option: exchangeOption("binance", "Binance Simple Earn", asset, Number(p.highestApy), "2017-07-14T00:00:00.000Z", reserves("binance-cex"), "https://www.binance.com/en/simple-earn", "Binance.com is not available to US residents (Binance.US is a separate company).", at, `https://www.binance.com/bapi/earn/v1/friendly/finance-earn/simple/product/simpleEarnProducts?asset=${asset}`) });
      }
    } catch (e) { errors.push(`binance ${asset}: ${(e as Error).message}`); }
    try {
      const j = await getJson<{ code: string; data: { estRate: string; avgRate: string }[] }>(`https://www.okx.com/api/v5/finance/savings/lending-rate-summary?ccy=${asset}`);
      const d = j.code === "0" ? j.data[0] : null;
      if (d && Number(d.estRate) >= 0.0001) items.push({ option: exchangeOption("okx", "OKX Simple Earn (Savings)", asset, Number(d.estRate), "2017-01-01T00:00:00.000Z", reserves("okx"), "https://www.okx.com/earn/simple-earn", "OKX.com is not available to US residents (OKX US is a separate service).", at, `https://www.okx.com/api/v5/finance/savings/lending-rate-summary?ccy=${asset}`) });
    } catch (e) { errors.push(`okx ${asset}: ${(e as Error).message}`); }
  }
  if (!items.length) throw new Error(errors.join("; ") || "no exchange rates");
  return { name: "exchange", items };
}

function exchangeOption(id: string, name: string, asset: "XRP" | "RLUSD", rate: number, launched: string, reservesUsd: number | null, url: string, region: string, at: string, src: string): YieldOption {
  return {
    slug: `${id}-earn-${asset.toLowerCase()}`,
    name: `${name} — ${asset}`,
    provider: name.split(" ")[0],
    asset,
    kind: "exchange-earn",
    chain: "Exchange account",
    rate,
    rateBase: rate,
    rateReward: null,
    rateKind: "the exchange's published flexible rate (it can change at any time)",
    tvlUsd: reservesUsd,
    sizeNote: "the exchange's total on-chain reserves (DefiLlama), not this product",
    lockup: "None (flexible).",
    withdrawal: "Redeem any time, usually within minutes, back to your exchange balance.",
    withdrawShort: "any time",
    keys: `${name.split(" ")[0]} (the exchange)`,
    custody: "exchange",
    bridge: "none",
    layers: 0,
    launchedAt: launched,
    audits: null,
    auditLinks: [],
    ilRisk: false,
    regionNote: region,
    url,
    source: { name: `${name.split(" ")[0]} public rate endpoint`, url: src, at },
    notes: ["The exchange lends your coins to its margin traders or uses them elsewhere; how is not published per product."],
  };
}
