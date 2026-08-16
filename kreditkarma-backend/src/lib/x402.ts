// src/lib/x402.ts
// Official x402 v2 protocol helpers for XRPL (t54 facilitator scheme).
//
// NETWORK: CAIP-2 "xrpl:0" (required by the @x402 SDK).
// RESOURCE: x402 v2 requires `resource` to be an OBJECT {url, description,
// mimeType}, NOT a bare URL string. The payer SDK echoes this object into the
// paymentPayload it sends to the facilitator; if it's a string the facilitator
// rejects it with a Pydantic 422 (paymentPayload.resource must be an object).
// No custody: payer signs, facilitator submits.

import { createHash } from "crypto";

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

// Public origin, used to build absolute resource URLs.
export const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://www.xrplhub.io";

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

// x402 v2 ResourceInfo object.
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

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
    amount: opts.amountRlusd.toFixed(6),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    name: opts.name ?? "XRPLScore - Wallet Risk Score",
    description:
      opts.description ??
      "300-850 on-chain risk score for any XRPL wallet, from 9 signals. Pay per call in RLUSD.",
    extra: {
      invoiceId: opts.invoiceId,
      sourceTag: X402_SOURCE_TAG,
      areFeesSponsored: false,
      issuer: RLUSD_ISSUER_ADDR,
      ...(opts.destinationTag ? { destinationTag: opts.destinationTag } : {}),
    },
  };
}

// Build the resource as an OBJECT (x402 v2 ResourceInfo). resourcePath is the
// route path like "/api/x402/score"; we make it an absolute URL.
export function makeResource(resourcePath: string, description?: string): ResourceInfo {
  const url = resourcePath.startsWith("http")
    ? resourcePath
    : `${PUBLIC_ORIGIN}${resourcePath}`;
  return {
    url,
    description: description ?? "XRPLHub paid API resource",
    mimeType: "application/json",
  };
}

export function paymentRequiredChallenge(
  requirements: PaymentRequirements,
  resource: string,
  description?: string
) {
  return {
    x402Version: X402_VERSION,
    accepts: [requirements],
    // resource is an OBJECT per x402 v2 (not a bare string).
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
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
  error?: string;
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

// Ensure the payload we forward has resource as an OBJECT. If the client sent a
// string (older SDK) or omitted it, coerce to a proper ResourceInfo so the
// facilitator's Pydantic model accepts it.
function normalizePayload(
  p: PaymentSignaturePayload,
  resourcePath: string
): PaymentSignaturePayload {
  const r = p.resource as unknown;
  let resource: ResourceInfo;
  if (r && typeof r === "object" && typeof (r as ResourceInfo).url === "string") {
    resource = r as ResourceInfo;
  } else if (typeof r === "string") {
    resource = makeResource(r);
  } else {
    resource = makeResource(resourcePath);
  }
  return { ...p, resource };
}

export function verifyPayment(
  p: PaymentSignaturePayload,
  r: PaymentRequirements,
  resourcePath = "/api/x402/score"
) {
  const payload = normalizePayload(p, resourcePath);
  return facilitatorPost("/verify", { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: r });
}
export function settlePayment(
  p: PaymentSignaturePayload,
  r: PaymentRequirements,
  resourcePath = "/api/x402/score"
) {
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
