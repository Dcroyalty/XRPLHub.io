// src/lib/freeTx.ts
// Request-parsing helpers for POST /api/execute (the builder for XRPLHub's OWN product transactions: MPT issuance with a
// recorded declaration, the XRPLScore-gated Permissioned Domain, and the admin health check). The generic transaction
// catalog and its free build paths (/api/tx, MCP build_xrpl_transaction, the ElizaOS build action) were removed
// 2026-10-07 — see src/lib/retiredTx.ts.

import type { PlanStep } from "@/lib/paymentGate";
import type { Params } from "@/app/api/execute/buildKit";

export function sanitizeParams(raw: unknown): Params {
  const out: Params = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 30)) {
    if (typeof v === "string") out[k] = v.slice(0, 2000);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function parsePlan(raw: unknown): PlanStep[] | null {
  let v = raw;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || !v.length || v.length > 5) return null;
  const plan = v.map((s) => ({ id: String((s as PlanStep)?.id ?? ""), type: String((s as PlanStep)?.type ?? "") }));
  return plan.every((s) => /^[a-z0-9_-]{1,32}$/i.test(s.id) && /^[A-Za-z]{2,40}$/.test(s.type)) ? plan : null;
}
