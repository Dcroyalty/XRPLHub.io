// src/lib/x402.ts
// Official x402 v2 protocol helpers for XRPL (t54 facilitator scheme).
// Spec: https://xrpl-x402.t54.ai/docs/xrpl-scheme
//
// Flow this supports (seller side):
//   1) Client GETs a protected resource with no payment.
//      -> 402 + PAYMENT-REQUIRED header (base64 JSON) describing terms.
//   2) Client presigns an XRPL Payment blob binding the invoiceId and
//      resends with PAYMENT-SIGNATURE header (base64 JSON).
//   3) We POST that payload to the facilitator /verify then /settle.
//      -> 200 + resource + PAYMENT-RESPONSE header (base64 JSON).
//
// We never hold keys and never sign: the payer signs, the facilitator
// submits. Same no-custody model as the rest of this app.

import { createHash } from "crypto";

// ── Constants from the spec ────────────────────────────────────────────────
export const X402_VERSION = 2;
export const X402_SCHEME = "exact";

// CAIP-2 network ids: mainnet xrpl:0, testnet xrpl:1, devnet xrpl:2
export const XRPL_NETWORK = process.env.X402_NETWORK ?? "xrpl:0";

// Hosted mainnet facilitator (override per env if needed).
export const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://xrpl-facilitator-mainnet.t54.ai";

// Default facilitator SourceTag from the spec.
export const X402_SOURCE_TAG = Number(process.env.X402_SOURCE_TAG ?? 804681468);

// RLUSD canonical 40-hex currency code + official mainnet issuer.
export const RLUSD_ASSET = "524C555344000000000000000000000000000000";
export const RLUSD_ISSUER_ADDR =
  process.env.RLUSD_ISSUER ?? "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

export const MAX_TIMEOUT_SECONDS = 600;

// ── Header codec (base64 JSON both directions) ─────────────────────────────
export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeHeader<T = unknown>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** InvoiceID binding per spec Method B: SHA256(invoiceId), uppercase hex. */
export function invoiceIdHash(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

// ── Payment requirements (what we advertise in PAYMENT-REQUIRED) ───────────
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;          // "XRP" or canonical 40-hex currency code
  payTo: string;          // our treasury classic address
  amount: string;         // drops for XRP, decimal string for IOU
  maxTimeoutSeconds: number;
  extra: {
    invoiceId: string;
    sourceTag: number;
    issuer?: string;      // required for IOU
    destinationTag?: number;
  };
}

/** Build RLUSD payment requirements for a given price + invoice. */
export function rlusdRequirements(opts: {
  payTo: string;
  amountRlusd: number;
  invoiceId: string;
  destinationTag?: number;
}): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: XRPL_NETWORK,
    asset: RLUSD_ASSET,
    payTo: opts.payTo,
    amount: opts.amountRlusd.toFixed(6),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      invoiceId: opts.invoiceId,
      sourceTag: X402_SOURCE_TAG,
      issuer: RLUSD_ISSUER_ADDR,
      ...(opts.destinationTag ? { destinationTag: opts.destinationTag } : {}),
    },
  };
}

/** The full PAYMENT-REQUIRED challenge body. */
export function paymentRequiredChallenge(
  requirements: PaymentRequirements,
  resource: string,
  description?: string
) {
  return {
    x402Version: X402_VERSION,
    accepts: [requirements],
    resource,
    ...(description ? { description } : {}),
  };
}

// ── What the client sends back in PAYMENT-SIGNATURE ────────────────────────
export interface PaymentSignaturePayload {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: { signedTxBlob: string };
}

// ── Facilitator client (/verify then /settle) ──────────────────────────────
export interface FacilitatorResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  error?: string;
}

async function facilitatorPost(
  path: string,
  body: unknown
): Promise<FacilitatorResult> {
  try {
    const res = await fetch(`${FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: e instanceof Error ? e.message : "facilitator unreachable",
    };
  }
}

/** Ask the facilitator to validate the presigned payment against our terms. */
export function verifyPayment(
  paymentPayload: PaymentSignaturePayload,
  paymentRequirements: PaymentRequirements
) {
  return facilitatorPost("/verify", {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
}

/** Ask the facilitator to submit the presigned blob to XRPL. */
export function settlePayment(
  paymentPayload: PaymentSignaturePayload,
  paymentRequirements: PaymentRequirements
) {
  return facilitatorPost("/settle", {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
}

/** Ask the facilitator which networks/schemes it supports (health check). */
export async function facilitatorSupported(): Promise<FacilitatorResult> {
  try {
    const res = await fetch(`${FACILITATOR_URL}/supported`);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: e instanceof Error ? e.message : "facilitator unreachable",
    };
  }
}

/** Truthiness helper — facilitators vary on shape; check the usual suspects. */
export function looksSuccessful(r: FacilitatorResult): boolean {
  if (!r.ok || !r.body) return false;
  const b = r.body as { success?: boolean; isValid?: boolean; valid?: boolean };
  return b.success === true || b.isValid === true || b.valid === true;
}
