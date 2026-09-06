// src/lib/x402.ts
// Official x402 v2 protocol helpers for XRPL (t54 facilitator scheme).
//
// AMOUNT: the exact scheme requires paymentRequirements.amount to equal the
// transaction's Amount.value EXACTLY. XRPL IOU amounts are canonical decimal
// strings ("0.02", not "0.020000"). We therefore emit a trimmed canonical
// amount so it matches the on-ledger Amount.value the payer signs.
// NETWORK: CAIP-2 "xrpl:0". RESOURCE: ResourceInfo object. No custody.

import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { notifyError } from "./notify";

export const X402_VERSION = 2;
export const X402_SCHEME = "exact";
export const XRPL_NETWORK = process.env.X402_NETWORK ?? "xrpl:0";
export const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://xrpl-facilitator-mainnet.t54.ai";
export const X402_SOURCE_TAG = Number(process.env.X402_SOURCE_TAG ?? 804681468);
export const RLUSD_ASSET = "524C555344000000000000000000000000000000";
export const RLUSD_ISSUER_ADDR =
  process.env.RLUSD_ISSUER ?? "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
export const MAX_TIMEOUT_SECONDS = 600;
export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://www.xrplhub.io";

// Canonical XRPL IOU amount string: no trailing zeros, no trailing dot.
// 0.02 -> "0.02"; 0.080000 -> "0.08"; 1 -> "1"; 0.15 -> "0.15".
export function canonicalAmount(n: number): string {
  let s = n.toFixed(6);          // "0.020000"
  if (s.indexOf(".") >= 0) {
    s = s.replace(/0+$/, "");     // strip trailing zeros -> "0.02"
    s = s.replace(/\.$/, "");     // strip trailing dot if any -> "2"
  }
  return s;
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}
export function decodeHeader<T = unknown>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T; }
  catch { return null; }
}
export function invoiceIdHash(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

export interface ResourceInfo { url: string; description?: string; mimeType?: string; }

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  name?: string;
  description?: string;
  // Embedded so an agent that hits the endpoint cold — without fetching
  // /.well-known/x402 first — knows every parameter and the response shape.
  // Shape mirrors what x402-next/CDP emits: outputSchema.{input,output}.
  outputSchema?: { input: unknown; output: unknown; outputExample?: unknown };
  extra: {
    invoiceId: string;
    sourceTag: number;
    areFeesSponsored: boolean;
    issuer?: string;
    destinationTag?: number;
  };
}

export function rlusdRequirements(opts: {
  payTo: string;
  amountRlusd: number;
  invoiceId: string;
  destinationTag?: number;
  name?: string;
  description?: string;
  schemas?: { input: unknown; output: unknown; outputExample?: unknown };
}): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: XRPL_NETWORK,
    asset: RLUSD_ASSET,
    payTo: opts.payTo,
    amount: canonicalAmount(opts.amountRlusd), // "0.02" not "0.020000"
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    name: opts.name ?? "XRPLScore - Wallet Risk Score",
    description:
      opts.description ??
      "300-850 on-chain creditworthiness score for any XRPL wallet, from 8 signals. Pay per call in RLUSD, no signup.",
    ...(opts.schemas
      ? { outputSchema: { input: opts.schemas.input, output: opts.schemas.output, ...(opts.schemas.outputExample ? { outputExample: opts.schemas.outputExample } : {}) } }
      : {}),
    extra: {
      invoiceId: opts.invoiceId,
      sourceTag: X402_SOURCE_TAG,
      areFeesSponsored: false,
      issuer: RLUSD_ISSUER_ADDR,
      ...(opts.destinationTag ? { destinationTag: opts.destinationTag } : {}),
    },
  };
}

// Stable machine-readable failure codes for every paid path. Documented in
// /.well-known/x402, /openapi.json, and /llms.txt.
export const X402_ERROR_CODES = {
  payment_required: "No PAYMENT-SIGNATURE header — this is the 402 challenge.",
  bad_request: "Missing or invalid request parameters (see the message).",
  invalid_payment_payload: "PAYMENT-SIGNATURE could not be decoded, wrong x402Version, or missing `accepted`.",
  invoice_binding_missing: "The payment payload has no accepted.extra.invoiceId to bind the payment to.",
  payment_verification_failed: "The facilitator rejected the payment at /verify. You were NOT charged. See `facilitator`.",
  handler_failed: "The paid work failed AFTER verification but BEFORE settlement. You were NOT charged. Retry with the same PAYMENT-SIGNATURE within maxTimeoutSeconds, or fetch a new challenge.",
  account_not_found: "The wallet is not an activated account on XRPL mainnet. You were NOT charged.",
  settlement_pending: "The result is delivered and correct; on-ledger settlement is still being retried. You were NOT double-charged.",
  idempotent_replay: "This Idempotency-Key (or invoiceId) was already processed — the original response is returned unchanged.",
  request_in_progress: "A request with this Idempotency-Key (or invoiceId) is still being processed. Retry shortly.",
  retired: "This endpoint is retired. Use the endpoint named in `useInstead`.",
} as const;
export type X402ErrorCode = keyof typeof X402_ERROR_CODES;

export function makeResource(resourcePath: string, description?: string): ResourceInfo {
  const url = resourcePath.startsWith("http") ? resourcePath : `${PUBLIC_ORIGIN}${resourcePath}`;
  return { url, description: description ?? "XRPLHub paid API resource", mimeType: "application/json" };
}

export function paymentRequiredChallenge(
  requirements: PaymentRequirements,
  resource: string,
  description?: string
) {
  return {
    x402Version: X402_VERSION,
    accepts: [requirements],
    resource: makeResource(resource, description),
    network: XRPL_NETWORK,
    ...(description ? { description } : {}),
  };
}

export interface PaymentSignaturePayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: { signedTxBlob: string };
  resource?: ResourceInfo;
}

export interface FacilitatorResult {
  ok: boolean; status: number; body: Record<string, unknown> | null; error?: string;
}

async function facilitatorPost(path: string, body: unknown): Promise<FacilitatorResult> {
  try {
    const res = await fetch(`${FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | null = null;
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { parsed = null; }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : "facilitator unreachable" };
  }
}

function normalizePayload(p: PaymentSignaturePayload, resourcePath: string): PaymentSignaturePayload {
  const r = p.resource as unknown;
  let resource: ResourceInfo;
  if (r && typeof r === "object" && typeof (r as ResourceInfo).url === "string") resource = r as ResourceInfo;
  else if (typeof r === "string") resource = makeResource(r);
  else resource = makeResource(resourcePath);
  return { ...p, resource };
}

export function verifyPayment(p: PaymentSignaturePayload, r: PaymentRequirements, resourcePath = "/api/x402/score") {
  const payload = normalizePayload(p, resourcePath);
  return facilitatorPost("/verify", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: r });
}
export function settlePayment(p: PaymentSignaturePayload, r: PaymentRequirements, resourcePath = "/api/x402/score") {
  const payload = normalizePayload(p, resourcePath);
  return facilitatorPost("/settle", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: r });
}
export async function facilitatorSupported(): Promise<FacilitatorResult> {
  try {
    const res = await fetch(`${FACILITATOR_URL}/supported`);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { parsed = null; }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : "facilitator unreachable" };
  }
}
export function looksSuccessful(r: FacilitatorResult): boolean {
  if (!r.ok || !r.body) return false;
  const b = r.body as { success?: boolean; isValid?: boolean; valid?: boolean };
  return b.success === true || b.isValid === true || b.valid === true;
}

/**
 * Alert on a t54-facilitator fault that isn't the customer's fault.
 *  - phase "settle": always loud (verify already passed → payment was valid,
 *    the customer paid and we couldn't complete the exchange).
 *  - phase "verify": loud only when the facilitator is unreachable (status 0)
 *    or erroring (5xx) — a clean 4xx is a bad payment, not our outage.
 */
export function reportFacilitatorFault(
  phase: "verify" | "settle",
  result: FacilitatorResult,
  ctx: Record<string, unknown>
): void {
  const infraDown = result.status === 0 || result.status >= 500;
  if (phase === "verify" && !infraDown) return;
  void notifyError(`x402/t54 ${phase}`, new Error(result.error ?? `facilitator ${phase} failed (HTTP ${result.status})`), {
    ...ctx,
    facilitatorStatus: result.status,
    facilitatorBody: result.body ? JSON.stringify(result.body).slice(0, 400) : null,
  });
}

// ---------------------------------------------------------------------------

export function statelessInvoiceId(plan: string): string {
  return `${plan}~${randomUUID()}`;
}

// Best-effort books entry for a SETTLED x402 payment. Never throws â€” a
// bookkeeping failure must not block delivery to a paying customer. Only
// reached after settlement, so probes never create rows.
export async function recordPaidInvoice(
  db: Pick<PrismaClient, "invoice">,
  opts: { plan: string; amountRlusd: number; txHash?: string | null }
): Promise<void> {
  const MAX_TAG = 2_147_483_647; // Invoice.destinationTag is a unique 32-bit int
  for (let i = 0; i < 3; i++) {
    try {
      await db.invoice.create({
        data: {
          plan: opts.plan,
          amountRlusd: opts.amountRlusd,
          destinationTag: 1 + Math.floor(Math.random() * (MAX_TAG - 1)),
          status: "paid",
          txHash: opts.txHash ?? null,
          deliveredRlusd: opts.amountRlusd,
          paidAt: new Date(),
          expiresAt: new Date(),
        },
      });
      return;
    } catch {
      /* unique-tag collision or transient error â€” retry a couple times, then give up */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// serveX402Paid — the full paid-route flow, agent-safe.
//
// GUARANTEE: settlement fires ONLY after the paid work returns success — the
// same "never charge for a failure" contract x402-next/CDP gives. On a handler
// failure the caller's signed payment is untouched and can be retried. On a
// settle failure AFTER a successful handler, the caller still gets the result
// (they did their part) and settlement is retried in the background.
//
// IDEMPOTENCY: keyed on the `Idempotency-Key` header, else the payload
// invoiceId. A retried request returns the stored response verbatim — an agent
// can never pay twice.
// ─────────────────────────────────────────────────────────────────────────────

export type HandlerResult =
  | { ok: true; data: unknown }
  | { ok: false; code: X402ErrorCode; status: number; message: string };

export interface ServeX402Opts {
  req: Request;
  prisma: PrismaClient;
  resource: string; // "/api/x402/score"
  plan: string; // recordPaidInvoice plan tag, e.g. "x402:score"
  amountRlusd: number;
  /** Build requirements for a given invoiceId. Called for the challenge AND the paid call. */
  requirements: (invoiceId: string) => PaymentRequirements;
  challengeDescription: string;
  /** Runs BEFORE settlement. Return ok:false to refuse without charging. */
  handler: () => Promise<HandlerResult>;
}

const IN_PROGRESS_TTL_MS = 120_000;

export async function serveX402Paid(opts: ServeX402Opts): Promise<NextResponse> {
  const { req, prisma, resource, plan, amountRlusd } = opts;
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");

  // 1) No signature → the 402 challenge (crawler-safe, stateless).
  if (!sigHeader) {
    const invoiceId = statelessInvoiceId(plan);
    const challenge = paymentRequiredChallenge(opts.requirements(invoiceId), resource, opts.challengeDescription);
    return NextResponse.json(challenge, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodeHeader(challenge), "Cache-Control": "no-store" },
    });
  }

  // 2) Decode + bind.
  const payload = decodeHeader<PaymentSignaturePayload>(sigHeader);
  if (!payload || payload.x402Version !== X402_VERSION || !payload.accepted) {
    return errJson("invalid_payment_payload", 400);
  }
  const invoiceId = payload.accepted?.extra?.invoiceId;
  if (!invoiceId) return errJson("invoice_binding_missing", 400);

  const idemKey = (req.headers.get("Idempotency-Key") || invoiceId).slice(0, 200);

  // 3) Idempotency.
  const prior = await prisma.x402PaidRequest.findUnique({ where: { key: idemKey } }).catch(() => null);
  if (prior) {
    if (prior.status === "completed" && prior.responseJson) {
      return NextResponse.json(prior.responseJson, {
        status: prior.httpStatus ?? 200,
        headers: { "Idempotency-Replay": "true", "Cache-Control": "no-store" },
      });
    }
    if (prior.status === "in_progress" && Date.now() - prior.createdAt.getTime() < IN_PROGRESS_TTL_MS) {
      return errJson("request_in_progress", 409);
    }
    // stale in_progress or a prior failure → let it proceed (delete + reclaim below)
    await prisma.x402PaidRequest.update({ where: { key: idemKey }, data: { status: "in_progress", createdAt: new Date() } }).catch(() => {});
  } else {
    await prisma.x402PaidRequest.create({ data: { key: idemKey, resource, invoiceId, status: "in_progress" } }).catch(() => {});
  }

  const finish = async (body: Record<string, unknown>, status: number, settled: boolean, txHash: string | null, extraHeaders?: Record<string, string>) => {
    await prisma.x402PaidRequest
      .update({ where: { key: idemKey }, data: { status: status < 400 ? "completed" : "failed", settled, txHash, responseJson: body as object, httpStatus: status, completedAt: new Date() } })
      .catch(() => {});
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...(extraHeaders ?? {}) } });
  };

  const requirements = opts.requirements(invoiceId);

  // 4) Verify — no money moves here.
  const verified = await verifyPayment(payload, requirements, resource);
  if (!looksSuccessful(verified)) {
    reportFacilitatorFault("verify", verified, { resource, invoiceId });
    return finish(
      { error: "payment_verification_failed", message: X402_ERROR_CODES.payment_verification_failed, facilitator: verified.body ?? verified.error ?? null, facilitatorStatus: verified.status, settled: false },
      402, false, null
    );
  }

  // 5) HANDLER — before settlement. A failure here costs the caller nothing.
  let result: unknown;
  try {
    const h = await opts.handler();
    if (!h.ok) {
      return finish(
        { error: h.code, message: h.message, settled: false, retry: X402_ERROR_CODES.handler_failed },
        h.status, false, null
      );
    }
    result = h.data;
  } catch (err) {
    void notifyError(`x402 handler ${resource}`, err, { invoiceId });
    return finish(
      { error: "handler_failed", message: err instanceof Error ? err.message : "handler failed", settled: false, retry: X402_ERROR_CODES.handler_failed },
      502, false, null
    );
  }

  // 6) Settle — the caller has already earned the result; collect the money.
  let settled = await settlePayment(payload, requirements, resource);
  let settledOk = looksSuccessful(settled);
  if (!settledOk) {
    reportFacilitatorFault("settle", settled, { resource, invoiceId });
    settled = await settlePayment(payload, requirements, resource); // one inline retry
    settledOk = looksSuccessful(settled);
  }
  const txHash = settledOk ? ((settled.body ?? {}) as { transaction?: string }).transaction ?? null : null;
  const payer = ((settled.body ?? {}) as { payer?: string }).payer ?? null;

  if (settledOk) {
    await recordPaidInvoice(prisma, { plan, amountRlusd, txHash });
  } else {
    void notifyError(`x402 settle-after-delivery ${resource}`, new Error("settlement failed after a successful handler — result delivered, money uncollected"), { invoiceId });
  }

  const paymentResponse = {
    success: true,
    settled: settledOk,
    transaction: txHash,
    network: process.env.X402_NETWORK ?? "xrpl",
    payer,
    ...(settledOk ? {} : { note: X402_ERROR_CODES.settlement_pending }),
  };
  return finish(
    { data: result, x402: paymentResponse },
    200, settledOk, txHash,
    { "PAYMENT-RESPONSE": encodeHeader(paymentResponse) }
  );
}

function errJson(code: X402ErrorCode, status: number): NextResponse {
  return NextResponse.json({ error: code, message: X402_ERROR_CODES[code] }, { status, headers: { "Cache-Control": "no-store" } });
}
