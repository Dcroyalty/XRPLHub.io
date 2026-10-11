// src/lib/xrplNodes.ts
// XRPL mainnet JSON-RPC with round-robin rotation and per-node cooldown.
//
// Every node below was verified 2026-09-08: server_info -> network_id 0, full
// history (complete_ledgers "32570-<tip>"), and a live account_info call.
// Re-verified 2026-10-04 (all six: mainnet, full history, <1s on both :443 and
// :51234). s-west/s-east.ripple.com were dropped that day: they are now DNS
// CNAMEs of s1.ripple.com, so they weren't extra nodes — they made one Ripple
// cluster three ring slots and three votes in the staleness majority below,
// and all three went "down" together when s1 did. Before adding a node, check
// its DNS isn't an alias of one already here.
//
// Rotation: each xrplRpc() call takes the next node in the ring, so the 7
// parallel calls a single score fires spread across the nodes instead of
// hammering one. A node that 429s (or whose RateLimit-Remaining runs low) is
// cooled for its Reset window and skipped — the request never fails while any
// other node is healthy.

import { bumpXrpl } from "./xrplCounters";

export const XRPL_NODES = [
  "https://xrplcluster.com",
  "https://xrpl.ws",
  "https://xrpl.link",
  "https://s1.ripple.com:51234",
  "https://s2.ripple.com:51234",
  "https://rippled.xrptipbot.com",
];

export type XrplRpcResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false };

const DEFAULT_COOL_MS = 10_000;   // 429 with no Reset hint
const TRANSIENT_COOL_MS = 3_000;  // timeout / network blip
const LOW_REMAINING_UNITS = 250;  // proactively cool a node this close to its 10s budget

const coolUntil = new Map<string, number>(); // url -> epoch ms
let ring = Math.floor(Math.random() * XRPL_NODES.length);

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function nextIndex(): number {
  const i = ring % XRPL_NODES.length;
  ring = (ring + 1) % XRPL_NODES.length;
  return i;
}

/** Ordered node list for this call: healthy nodes first (starting at the ring
 *  cursor), then any cooling nodes as a last resort. */
function candidateOrder(): string[] {
  const start = nextIndex();
  const rotated: string[] = [];
  for (let k = 0; k < XRPL_NODES.length; k++) {
    rotated.push(XRPL_NODES[(start + k) % XRPL_NODES.length]);
  }
  const now = Date.now();
  const healthy = rotated.filter((u) => (coolUntil.get(u) ?? 0) <= now);
  const cooling = rotated.filter((u) => (coolUntil.get(u) ?? 0) > now);
  return healthy.length ? [...healthy, ...cooling] : rotated; // all cooling -> try anyway
}

function cool(url: string, ms: number): void {
  coolUntil.set(url, Date.now() + Math.max(1_000, ms));
}

async function callOne(
  url: string,
  method: string,
  params: object,
  timeoutMs: number
): Promise<{ status: "ok"; body: Record<string, unknown> } | { status: "ratelimited"; coolMs: number } | { status: "fail" }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) * 1000;
      const reset = Number(res.headers.get("ratelimit-reset")) * 1000;
      return { status: "ratelimited", coolMs: retry || reset || DEFAULT_COOL_MS };
    }

    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("application/json")) {
      // A rate-limited node often answers with a plain-text body / 5xx.
      const reset = Number(res.headers.get("ratelimit-reset")) * 1000;
      return reset ? { status: "ratelimited", coolMs: reset } : { status: "fail" };
    }

    const body = (await res.json()) as Record<string, unknown>;

    // Proactively cool a node that is about to run out of its 10s budget.
    const remaining = Number(res.headers.get("ratelimit-remaining"));
    const reset = Number(res.headers.get("ratelimit-reset"));
    if (Number.isFinite(remaining) && remaining < LOW_REMAINING_UNITS && Number.isFinite(reset)) {
      cool(url, reset * 1000);
    }

    return { status: "ok", body };
  } catch {
    return { status: "fail" };
  }
}

/**
 * One XRPL JSON-RPC call, rotated across the node pool with per-node cooldown.
 * Returns { ok:false } only when every node failed or is rate-limited.
 */
export async function xrplRpc(
  method: string,
  params: object,
  timeoutMs = 9_000
): Promise<XrplRpcResult> {
  const sweep = await ensureSweepFresh().catch(() => null); // the sweep itself must never break a read
  if (sweep && !sweep.trusted) {
    bumpXrpl("rpc:no-majority");
    return { ok: false };
  }
  for (const url of candidateOrder()) {
    const r = await callOne(url, method, params, timeoutMs);
    if (r.status === "ok") {
      bumpXrpl(`node:${host(url)}`);
      bumpXrpl(`method:${method}`);
      return { ok: true, body: r.body };
    }
    if (r.status === "ratelimited") {
      cool(url, r.coolMs);
      bumpXrpl(`ratelimited:${host(url)}`);
    } else {
      cool(url, TRANSIENT_COOL_MS);
    }
  }
  bumpXrpl(`method:${method}`);
  bumpXrpl("rpc:exhausted");
  return { ok: false };
}

/** For an admin/status view. */
export function nodePoolStatus(): Array<{ host: string; coolingForMs: number }> {
  const now = Date.now();
  return XRPL_NODES.map((u) => ({
    host: host(u),
    coolingForMs: Math.max(0, (coolUntil.get(u) ?? 0) - now),
  }));
}

export function isCooling(url: string): boolean {
  return (coolUntil.get(url) ?? 0) > Date.now();
}

// ─── STALENESS / AMENDMENT-BLOCK DEFENSE ───────────────────────────────────
// The cooling above only sees HTTP-level failure (429, 5xx, timeout). It cannot see a node that answers
// 200 OK with stale data -- which is exactly what an amendment-blocked rippled server does: it keeps
// serving reads, it just stops advancing its own ledger. A periodic server_info sweep (lazily, from
// xrplRpc() itself, and forced from the watchdog) is the only way to catch that, so this cools two more
// things: any node reporting amendment_blocked:true, and any node whose validated ledger has fallen
// meaningfully behind the rest of the ring.
//
// SAFETY FLOOR (MIN_HEALTHY_NODES): this sweep never cools a node if doing so would leave fewer than 3
// nodes out of cooldown. Availability wins over precision when many nodes are bad at once -- if that many
// are actually blocked/lagging together, that's a genuinely dangerous state, but going fully dark is worse
// than serving from a marginal node; the watchdog (below) is what has to alert a human, not this function
// taking the site down.
//
// NO MAJORITY: if the responding nodes' ledger indices don't cluster into one dominant (strict-majority)
// group, there is no basis to say which side is right. xrplRpc() then refuses to serve at all -- returns
// {ok:false}, the exact same shape every caller already treats as "could not read" -- rather than guessing.

const SWEEP_INTERVAL_MS = 5 * 60_000;         // lazy refresh cadence while the ring is trusted
const DISTRUST_RETRY_MS = 15_000;             // retry cadence while in the no-majority state -- recheck fast
const STALE_LEDGER_THRESHOLD = 10;            // ledgers behind the trusted cluster before a node is "lagging"
const CLUSTER_BAND = 3;                       // ledgers apart still counts as "the same" (normal gossip jitter)
export const MIN_HEALTHY_NODES = 3;           // sweep-driven cooling never drops the pool below this
const AMENDMENT_BLOCK_COOL_MS = 10 * 60_000;  // blocked nodes don't self-heal quickly; check back in 10 min
const STALE_COOL_MS = 2 * 60_000;             // a lagging node might just be a slow gossip round; recheck sooner
const SERVER_INFO_TIMEOUT_MS = 6_000;

interface NodeProbe {
  url: string;
  ok: boolean;
  ledgerIndex?: number;
  amendmentBlocked?: boolean;
  /** Seconds since this node's last VALIDATED ledger closed (server_info validated_ledger.age). Grows during a halt. */
  ageSec?: number;
}

async function probeServerInfo(url: string): Promise<NodeProbe> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "server_info", params: [{}] }),
      signal: AbortSignal.timeout(SERVER_INFO_TIMEOUT_MS),
    });
    if (!res.ok) return { url, ok: false };
    const j = (await res.json()) as { result?: { info?: { amendment_blocked?: boolean; validated_ledger?: { seq?: number; age?: number } } } };
    const info = j.result?.info;
    const seq = info?.validated_ledger?.seq;
    if (!info || typeof seq !== "number") return { url, ok: false };
    const age = info.validated_ledger?.age;
    return { url, ok: true, ledgerIndex: seq, amendmentBlocked: !!info.amendment_blocked, ageSec: typeof age === "number" ? age : undefined };
  } catch {
    return { url, ok: false };
  }
}

export interface StalenessSweepResult {
  ranAt: number;
  /** false = no ledger-index majority this round; xrplRpc() refuses reads until a later sweep clears it. */
  trusted: boolean;
  majorityLedgerIndex: number | null;
  clusterSize: number;
  responded: number;
  amendmentBlocked: string[]; // hosts
  lagging: Array<{ host: string; ledgerIndex: number; behindBy: number }>;
  cooled: string[]; // hosts actually cooled this sweep
  /** true = some flagged nodes were deliberately left uncooled to respect MIN_HEALTHY_NODES -- needs a human. */
  floorHit: boolean;
  /** Freshest validated-ledger age (seconds) among responding nodes; null if no node reported one. */
  freshestAgeSec: number | null;
  /** EVERY responding node (≥2) has had no new validated ledger for HALT_AGE_SEC: the whole XRP Ledger stopped. */
  halted: boolean;
  /** Some nodes stale while others are fresh: OUR node(s) are bad, the network is fine. */
  staleHosts: string[];
}

/** No validated ledger for this long on every node = the network is halted (ledgers normally close every ~4 s). */
export const HALT_AGE_SEC = 120;

/** Largest group of values within CLUSTER_BAND of each other; ties keep the first (sorted ascending). */
function largestCluster(values: Array<{ url: string; ledgerIndex: number }>): { members: typeof values; index: number } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a.ledgerIndex - b.ledgerIndex);
  let best: typeof values = [];
  for (const anchor of sorted) {
    const group = sorted.filter((v) => Math.abs(v.ledgerIndex - anchor.ledgerIndex) <= CLUSTER_BAND);
    if (group.length > best.length) best = group;
  }
  const mid = best[Math.floor(best.length / 2)];
  return { members: best, index: mid.ledgerIndex };
}

let lastSweep: StalenessSweepResult | null = null;
let sweepInFlight: Promise<StalenessSweepResult> | null = null;

/**
 * Probe every node's server_info, cool anything amendment-blocked or meaningfully behind the trusted
 * cluster (subject to MIN_HEALTHY_NODES), and decide whether this round's ledger state can be trusted at
 * all. Exported standalone -- not just reachable via xrplRpc's lazy trigger -- so the watchdog can force a
 * fresh read, and so a test can pass a synthetic node list without touching the real ring.
 */
export async function sweepNodeHealth(nodes: string[] = XRPL_NODES): Promise<StalenessSweepResult> {
  const probes = await Promise.all(nodes.map((u) => probeServerInfo(u)));
  const ok = probes.filter((p): p is NodeProbe & { ledgerIndex: number } => p.ok && typeof p.ledgerIndex === "number");
  const amendmentBlockedUrls = probes.filter((p) => p.ok && p.amendmentBlocked).map((p) => p.url);

  const cluster = largestCluster(ok.map((p) => ({ url: p.url, ledgerIndex: p.ledgerIndex })));
  // Trust requires a STRICT MAJORITY of the responding nodes agreeing -- a plurality isn't enough to tell
  // which side of a split ring is actually right.
  const trusted = !!cluster && cluster.members.length > ok.length / 2;

  const lagging: Array<{ url: string; ledgerIndex: number; behindBy: number }> = [];
  if (trusted && cluster) {
    for (const p of ok) {
      const behindBy = cluster.index - p.ledgerIndex;
      if (behindBy > STALE_LEDGER_THRESHOLD) lagging.push({ url: p.url, ledgerIndex: p.ledgerIndex, behindBy });
    }
  }

  // Cool worst-first (amendment-blocked before mere lag, laggards worst-behind first) while respecting the floor.
  const priority = [...amendmentBlockedUrls, ...[...lagging].sort((a, b) => b.behindBy - a.behindBy).map((l) => l.url)];
  const now = Date.now();
  let remainingHealthy = nodes.filter((u) => (coolUntil.get(u) ?? 0) <= now).length;
  const cooled: string[] = [];
  let floorHit = false;
  for (const url of priority) {
    if (cooled.includes(url)) continue;
    const wasHealthy = (coolUntil.get(url) ?? 0) <= now;
    if (wasHealthy && remainingHealthy - 1 < MIN_HEALTHY_NODES) { floorHit = true; continue; }
    cool(url, amendmentBlockedUrls.includes(url) ? AMENDMENT_BLOCK_COOL_MS : STALE_COOL_MS);
    cooled.push(url);
    if (wasHealthy) remainingHealthy--;
  }

  const aged = ok.filter((p) => typeof p.ageSec === "number") as Array<NodeProbe & { ageSec: number }>;
  const freshestAgeSec = aged.length ? Math.min(...aged.map((p) => p.ageSec)) : null;
  const halted = aged.length >= 2 && aged.every((p) => p.ageSec > HALT_AGE_SEC);
  const staleHosts = halted ? [] : aged.filter((p) => p.ageSec > HALT_AGE_SEC).map((p) => host(p.url));
  const result: StalenessSweepResult = {
    ranAt: now,
    freshestAgeSec,
    halted,
    staleHosts,
    trusted,
    majorityLedgerIndex: cluster?.index ?? null,
    clusterSize: cluster?.members.length ?? 0,
    responded: ok.length,
    amendmentBlocked: amendmentBlockedUrls.map(host),
    lagging: lagging.map((l) => ({ host: host(l.url), ledgerIndex: l.ledgerIndex, behindBy: l.behindBy })),
    cooled: cooled.map(host),
    floorHit,
  };
  lastSweep = result;
  return result;
}

function sweepDue(): boolean {
  if (!lastSweep) return true;
  const age = Date.now() - lastSweep.ranAt;
  return age > (lastSweep.trusted ? SWEEP_INTERVAL_MS : DISTRUST_RETRY_MS);
}

/** Lazily refreshes the staleness sweep if it's due, coalescing concurrent callers onto one in-flight probe. */
async function ensureSweepFresh(): Promise<StalenessSweepResult | null> {
  if (!sweepDue()) return lastSweep;
  if (!sweepInFlight) {
    sweepInFlight = sweepNodeHealth().finally(() => { sweepInFlight = null; });
  }
  return sweepInFlight;
}

// ── Is the XRP Ledger moving? (halt detection, 2026-10-11) ───────────────────────────────────────────────────────────
// On 2025-02-04 the XRP Ledger stopped validating for 64 minutes. During a halt every node still answers — with the
// SAME old ledger — so the majority check above stays "trusted". Only the ledger's AGE tells a halt apart.
export type LedgerState = "ok" | "halted" | "degraded" | "unreachable";
export interface LedgerStatus { state: LedgerState; ageSec: number | null; ledgerIndex: number | null; message: string; checkedAt: number }
let lastStatus: LedgerStatus | null = null;
/** Plain-English message customers see while the ledger is halted. */
export const LEDGER_PAUSED_MESSAGE = "The XRP Ledger is paused right now. Nothing is lost — we'll send it as soon as it resumes.";
/** Cached 30 s. Never throws. */
export async function ledgerStatus(maxAgeMs = 30_000): Promise<LedgerStatus> {
  if (lastStatus && Date.now() - lastStatus.checkedAt < maxAgeMs) return lastStatus;
  const r = await sweepNodeHealth().catch(() => null);
  const st: LedgerStatus = !r || r.responded === 0
    ? { state: "unreachable", ageSec: null, ledgerIndex: null, message: "We can't reach the XRP Ledger right now. Nothing is lost — we'll try again shortly.", checkedAt: Date.now() }
    : r.halted
      ? { state: "halted", ageSec: r.freshestAgeSec, ledgerIndex: r.majorityLedgerIndex, message: LEDGER_PAUSED_MESSAGE, checkedAt: Date.now() }
      : r.staleHosts.length
        ? { state: "degraded", ageSec: r.freshestAgeSec, ledgerIndex: r.majorityLedgerIndex, message: "ok (some of our ledger connections are behind; using the healthy ones)", checkedAt: Date.now() }
        : { state: "ok", ageSec: r.freshestAgeSec, ledgerIndex: r.majorityLedgerIndex, message: "ok", checkedAt: Date.now() };
  lastStatus = st;
  return st;
}
