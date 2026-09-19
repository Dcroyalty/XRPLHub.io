// src/lib/serviceChain.ts
// Read-only ledger lookups the service builders need to build a CORRECT transaction
// (existing trust-line limit, whether an AMM exists, a real payment path, whether an
// account already has a regular key…). All go through xrplRpc (shared node rotation,
// cooldown and call counters). Every function returns null when the ledger can't be
// reached, so a builder can decide whether to fail closed.

import { xrplRpc } from "./xrplNodes";

type Obj = Record<string, unknown>;

type Rpc = (method: string, params: object) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }>;
let rpc: Rpc = xrplRpc;

/** Test-only: replace the ledger RPC (null restores the real one) so builders can be tested against simulated ledger states. */
export function _setChainRpcForTest(fn: Rpc | null): void {
  rpc = fn ?? xrplRpc;
}

async function call(method: string, params: Obj): Promise<Obj | null> {
  const r = await rpc(method, { ...params, ledger_index: "validated" });
  if (!r.ok) return null;
  return (r.body.result as Obj | undefined) ?? null;
}

/** AccountRoot flag bits we care about. */
export const LSF = {
  DISABLE_MASTER: 0x00100000,
  NO_FREEZE: 0x00200000,
  GLOBAL_FREEZE: 0x00400000,
  DEFAULT_RIPPLE: 0x00800000,
} as const;

export interface AccountSummary {
  found: boolean;
  flags: number;
  regularKey: string | null;
  ownerCount: number;
  signerListCount: number;
}

/** null = ledger unreachable. found:false = account not activated. */
export async function getAccount(account: string): Promise<AccountSummary | null> {
  const r = await call("account_info", { account, signer_lists: true });
  if (!r) return null;
  if (r.error === "actNotFound") return { found: false, flags: 0, regularKey: null, ownerCount: 0, signerListCount: 0 };
  const d = r.account_data as Obj | undefined;
  if (!d) return null;
  const lists = (d.signer_lists as unknown[] | undefined) ?? (r.signer_lists as unknown[] | undefined) ?? [];
  return {
    found: true,
    flags: Number(d.Flags ?? 0),
    regularKey: typeof d.RegularKey === "string" ? d.RegularKey : null,
    ownerCount: Number(d.OwnerCount ?? 0),
    signerListCount: Array.isArray(lists) ? lists.length : 0,
  };
}

export interface TrustLine {
  account: string; // the counterparty
  currency: string;
  balance: string; // from the queried account's view
  limit: string; // the queried account's limit
  limit_peer: string;
}

/** The queried account's trust lines with `peer` (or all). null = unreachable. */
export async function getLines(account: string, peer?: string): Promise<TrustLine[] | null> {
  const out: TrustLine[] = [];
  let marker: unknown;
  for (let i = 0; i < 5; i++) {
    const r = await call("account_lines", { account, ...(peer ? { peer } : {}), limit: 400, ...(marker ? { marker } : {}) });
    if (!r) return null;
    if (r.error === "actNotFound") return [];
    const lines = r.lines as TrustLine[] | undefined;
    if (!lines) return null;
    out.push(...lines);
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}

export type Asset = { currency: string; issuer?: string };

/** true = pool exists, false = no such AMM, null = unreachable/unknown. */
export async function ammExists(a: Asset, b: Asset): Promise<boolean | null> {
  const r = await call("amm_info", { asset: a, asset2: b });
  if (!r) return null;
  if (r.error === "actNotFound" || r.error === "ammNotFound") return false;
  if (r.error) return null;
  return Boolean(r.amm);
}

export interface PathAlternative {
  paths_computed: unknown[][];
  /** XRP drops string, or {currency, issuer, value} */
  source_amount: string | { currency: string; issuer?: string; value: string };
}

/**
 * ripple_path_find for a fixed destination amount. Returns the alternatives the server
 * computed (best first is NOT guaranteed — callers pick). null = unreachable/error.
 */
export async function findPaths(args: {
  source: string;
  destination: string;
  destinationAmount: string | { currency: string; issuer: string; value: string };
  sourceCurrency: Asset;
}): Promise<PathAlternative[] | null> {
  const r = await call("ripple_path_find", {
    source_account: args.source,
    destination_account: args.destination,
    destination_amount: args.destinationAmount,
    source_currencies: [args.sourceCurrency],
  });
  if (!r || r.error) return null;
  return (r.alternatives as PathAlternative[] | undefined) ?? [];
}
