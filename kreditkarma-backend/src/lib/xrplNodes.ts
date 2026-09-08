// src/lib/xrplNodes.ts
// XRPL mainnet JSON-RPC with round-robin rotation and per-node cooldown.
//
// Every node below was verified 2026-09-08: server_info -> network_id 0, full
// history (complete_ledgers "32570-<tip>"), and a live account_info call.
//
// Rotation: each xrplRpc() call takes the next node in the ring, so the 7
// parallel calls a single score fires land on 7 different nodes instead of
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
  "https://s-west.ripple.com:51234",
  "https://s-east.ripple.com:51234",
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
