// src/lib/xumm.ts
// One place for Xaman (XUMM) platform-API calls. Handles credentials, HTTP 429
// detection with exponential backoff, and payload create + status read.
//
// Used by the storefront (api/create-payment, api/check-payment) and by the
// checkout wallet-connect (api/checkout/xaman[, /status]). Same API keys, same
// payload endpoint the transaction-service signing already uses — no new dep.

const XUMM_PAYLOAD = "https://xumm.app/api/v1/platform/payload";

export class XummNotConfiguredError extends Error {}
export class XummRateLimitError extends Error {}

/** True when XUMM_API_KEY + XUMM_API_SECRET are both set. */
export function xummConfigured(): boolean {
  return Boolean(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
}

function authHeaders(): Record<string, string> {
  const key = process.env.XUMM_API_KEY;
  const secret = process.env.XUMM_API_SECRET;
  if (!key || !secret) {
    throw new XummNotConfiguredError("XUMM_API_KEY / XUMM_API_SECRET not set");
  }
  return { "X-API-Key": key, "X-API-Secret": secret };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() wrapper for the Xaman API.
 *
 * Retries on HTTP 429 (honouring Retry-After, capped at 5s) and on transient
 * 5xx / network errors, with 500ms → 1s → 2s backoff, up to 3 attempts total.
 * Throws XummRateLimitError if the 429s never clear so the caller can degrade
 * to a 503 / manual-pay path instead of hanging.
 */
export async function xummFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1)); // 500ms, 1s

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...authHeaders(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      lastErr = e; // network error / timeout — retry
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(Math.min(retryAfter * 1000, 5_000));
      }
      lastErr = new XummRateLimitError("Xaman rate limit (HTTP 429)");
      continue;
    }

    if (res.status >= 500) {
      lastErr = new Error(`Xaman upstream ${res.status}`);
      continue;
    }

    return res;
  }

  if (lastErr instanceof XummRateLimitError) throw lastErr;
  throw lastErr instanceof Error ? lastErr : new Error("Xaman request failed");
}

export interface CreatedPayload {
  uuid: string;
  qrPng: string | null;
  deepLink: string | null;
  expiresIn: number; // seconds
}

/**
 * Create a sign request. `options.submit` is always true — Xaman submits the
 * signed transaction to the ledger itself, same as the transaction-service flow.
 */
export async function createPayload(body: {
  txjson: Record<string, unknown>;
  instruction?: string;
  identifier?: string;
  blob?: Record<string, unknown>;
  expireMinutes?: number;
}): Promise<CreatedPayload> {
  const res = await xummFetch(XUMM_PAYLOAD, {
    method: "POST",
    body: JSON.stringify({
      txjson: body.txjson,
      options: { submit: true, expire: body.expireMinutes ?? 15 },
      custom_meta: {
        ...(body.identifier ? { identifier: body.identifier } : {}),
        ...(body.blob ? { blob: JSON.stringify(body.blob) } : {}),
        ...(body.instruction ? { instruction: body.instruction } : {}),
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.uuid) {
    throw new Error(data?.error?.reference || data?.message || "Xaman payload rejected");
  }

  return {
    uuid: data.uuid,
    qrPng: data.refs?.qr_png ?? null,
    deepLink: data.next?.always ?? null,
    expiresIn: 900,
  };
}

export type PayloadState = "pending" | "signed" | "rejected" | "expired" | "not_found";

export interface PayloadStatus {
  state: PayloadState;
  txid: string | null;
  signer: string | null;
}

export async function getPayloadStatus(uuid: string): Promise<PayloadStatus> {
  const res = await xummFetch(`${XUMM_PAYLOAD}/${encodeURIComponent(uuid)}`, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  const meta = data?.meta;

  if (!meta?.exists) return { state: "not_found", txid: null, signer: null };
  if (meta.expired) return { state: "expired", txid: null, signer: null };
  if (meta.cancelled) return { state: "rejected", txid: null, signer: null };
  if (!meta.signed) return { state: "pending", txid: null, signer: null };

  // Xaman has moved the txid between response shapes across versions — probe both.
  const txid =
    (data?.response?.txid as string | undefined) ??
    (data?.payload?.response?.txid as string | undefined) ??
    null;
  const signer =
    (data?.response?.account as string | undefined) ??
    (data?.payload?.response?.account as string | undefined) ??
    null;

  return { state: "signed", txid, signer };
}
