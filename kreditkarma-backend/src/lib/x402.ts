// src/lib/x402.ts
// Official x402 v2 protocol helpers for XRPL (t54 facilitator scheme).
//
// AMOUNT: the exact scheme requires paymentRequirements.amount to equal the
// transaction's Amount.value EXACTLY. XRPL IOU amounts are canonical decimal
// strings ("0.02", not "0.020000"). We therefore emit a trimmed canonical
// amount so it matches the on-ledger Amount.value the payer signs.
// NETWORK: CAIP-2 "xrpl:0". RESOURCE: ResourceInfo object. No custody.

import { createHash, randomUUID } from "crypto";
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
    extra: {
      invoiceId: opts.invoiceId,
      sourceTag: X402_SOURCE_TAG,
      areFeesSponsored: false,
      issuer: RLUSD_ISSUER_ADDR,
      ...(opts.destinationTag ? { destinationTag: opts.destinationTag } : {}),
    },
  };
}

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

// Structural type so this lib needs no Prisma import.
type PaidInvoiceRecorder = {
  invoice: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
};

// Best-effort books entry for a SETTLED x402 payment. Never throws â€” a
// bookkeeping failure must not block delivery to a paying customer. Only
// reached after settlement, so probes never create rows.
export async function recordPaidInvoice(
  db: PaidInvoiceRecorder,
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
