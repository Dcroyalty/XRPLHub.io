// src/lib/freeTx.ts
// THE way every one of the 35 transaction services is delivered — FREE, on every path (owner decision 2026-10-05,
// after Xaman removed the original app for charging for transactions Xaman offers free):
//   storefront   POST /api/execute            (+ a Xaman sign request)
//   REST         GET  /api/tx  (and the old /api/x402/tx, same handler)
//   MCP          build_xrpl_transaction
//   ElizaOS      plugin-xrplhub -> GET /api/tx
// No payment step anywhere. What is KEPT: the caution-tier confirmation with its irreversibility copy (a caution-tier
// service is refused until the caller confirms), amendment gating (e.g. delegate), every builder's validation, and
// per-client rate limits at each entry point. XRPLHub never signs: the wallet owner signs every transaction.

import { buildServiceTx } from "@/app/api/execute/txBuilder";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { ADMIN_ONLY_SERVICE_IDS } from "@/lib/servicePrices";
import { buildContextFromView, mptRegimeFor, permanenceNotice } from "@/lib/mptPermanence";
import { confirmationFor, type Confirmation } from "@/lib/txPurchase";
import { isValidXrplAddress } from "@/lib/address";
import type { PlanStep } from "@/lib/paymentGate";
import type { Params } from "@/app/api/execute/buildKit";

const KNOWN = new Set(BUILDABLE_SERVICE_IDS);

export interface FreeTxArgs {
  productId: string;
  account: string;
  params: Params;
  confirmCaution: boolean;
  /** Multi-step services: the plan returned at step 1, and the step being built now (1-based). */
  plan?: PlanStep[] | null;
  step?: number;
}

export type FreeTxResult =
  | { ok: false; status: number; error: string; message: string; needsParams?: string[]; tier?: string }
  | ({ ok: false; status: 409; error: "confirmation_required"; message: string; label?: string; tier: "caution"; totalSteps: number } & Confirmation)
  | {
      ok: true;
      productId: string;
      label: string;
      tier: string;
      /** this step's transaction */
      txjson: Record<string, unknown>;
      step: number;
      totalSteps: number;
      plan: PlanStep[];
      /** every step, in signing order (API callers sign them in order; the storefront signs one at a time) */
      steps: { id: string; label: string; txjson: Record<string, unknown> }[];
      signWith: string;
      notice?: Record<string, unknown>;
    };

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): FreeTxResult =>
  ({ ok: false, status, error, message, ...extra }) as FreeTxResult;

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

export async function buildFreeTx(a: FreeTxArgs): Promise<FreeTxResult> {
  const productId = a.productId.trim().toLowerCase();
  if (ADMIN_ONLY_SERVICE_IDS.has(productId) || !KNOWN.has(productId)) {
    return fail(404, "unknown_service", `Unknown service "${productId.slice(0, 40)}". See /api/mcp list_xrpl_services or /llms.txt.`);
  }
  if (!isValidXrplAddress(a.account)) return fail(400, "bad_request", "Provide a valid XRPL account (r...) — the wallet that will sign.");

  const step = Number.isInteger(a.step) && (a.step as number) >= 1 ? (a.step as number) : 1;
  const view = await mptRegimeFor(productId); // MPT issuance only
  const ctx = { ...(view ? buildContextFromView(view) : {}), ...(a.plan ? { planIds: a.plan.map((s) => s.id) } : {}), step };
  const built = await buildServiceTx(productId, a.account, a.params, ctx);
  if (!built.ok || !built.steps) {
    if (built.tier === "blocked") return fail(403, "blocked", built.error ?? "This operation is disabled for safety.", { tier: "blocked" });
    if (built.needsParams?.length) return fail(422, "missing_params", `${built.error ?? "Missing parameters"}: ${built.needsParams.join(", ")}`, { needsParams: built.needsParams });
    return fail(400, "build_failed", built.error ?? "Could not build the transaction.");
  }

  const plan: PlanStep[] = a.plan ?? built.steps.map((s) => ({ id: s.id, type: String(s.txjson.TransactionType) }));
  const target = plan[step - 1];
  const stepObj = target ? built.steps.find((s) => s.id === target.id) : undefined;
  if (!target || !stepObj) return fail(409, "wrong_step", "That step is not part of this service — start again from step 1.");

  const tier = built.tier ?? "safe";
  // KEPT: caution-tier services are refused until the caller confirms the wallet owner read what is irreversible.
  if (tier === "caution" && !a.confirmCaution && step === 1) {
    const conf = confirmationFor(productId, a.params as Record<string, unknown>, tier, view, built.txjson as Record<string, unknown>);
    return {
      ok: false, status: 409, error: "confirmation_required", tier: "caution", label: built.label, totalSteps: plan.length,
      message: "This service can be hard or impossible to undo. Show the wallet owner what is below, then repeat the request with confirmation.",
      ...(conf ?? { requiresConfirmation: true, warning: "This operation changes how your wallet is controlled and may be difficult or impossible to reverse." }),
    } as FreeTxResult;
  }

  return {
    ok: true, productId, label: built.label ?? productId, tier, txjson: stepObj.txjson, step, totalSteps: plan.length, plan,
    steps: built.steps.map((s) => ({ id: s.id, label: s.label, txjson: s.txjson })),
    signWith: a.account,
    ...(view ? { notice: permanenceNotice(view) as Record<string, unknown> } : {}),
  };
}

export const FREE_TX_NOTE =
  "Free. XRPLHub builds the exact unsigned transaction; you check it and sign it with your own wallet. XRPLHub never signs, never holds keys or funds, and charges nothing for transactions.";
