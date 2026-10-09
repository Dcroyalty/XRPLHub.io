// src/lib/xumm.ts
// One place for Xaman (XUMM) platform-API calls. Handles credentials, HTTP 429
// detection with exponential backoff, and payload create + status read.
//
// Used by the storefront (api/create-payment, api/check-payment) and by the
// checkout wallet-connect (api/checkout/xaman[, /status]). Same API keys, same
// payload endpoint the transaction-service signing already uses — no new dep.

import { notifyError } from "./notify";

const XUMM_PAYLOAD = "https://xumm.app/api/v1/platform/payload";

export class XummNotConfiguredError extends Error {}
export class XummRateLimitError extends Error {}

/** True when XUMM_API_KEY + XUMM_API_SECRET are both set. */
export function xummConfigured(): boolean {
  return Boolean(process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET);
}

/** Xaman's documented custom_meta.identifier max (docs.xaman.dev's post-payload reference). Exceeding
 *  it doesn't get truncated or warned by their API -- it's an outright HTTP 413, no payload created at
 *  all. Found live 2026-09-29: `xrplhub_exec_${productId}_${Date.now()}` silently overflowed this for
 *  any productId longer than 13 chars (depositpreauth, credentialissue -- real, paid services). */
const IDENTIFIER_MAX = 40;

/**
 * A custom_meta.identifier that is NEVER allowed to exceed IDENTIFIER_MAX, however long a future
 * productId/tag gets. Only the middle (variable) part is ever shortened -- prefix and the trailing
 * timestamp (which is what makes each identifier unique to Xaman) are always kept intact.
 */
export function safeIdentifier(prefix: string, variable: string, suffix: string): string {
  const fixed = prefix.length + suffix.length;
  const budget = Math.max(0, IDENTIFIER_MAX - fixed);
  return `${prefix}${variable.slice(0, budget)}${suffix}`;
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

/** What Xaman tells us about the user who opened our xApp (subset of xumm-sdk's xAppOttData). */
export interface XappOtt {
  account: string | null;
  /** The user token for push (same concept as application.issued_user_token). */
  userToken: string | null;
  nodetype: string | null;      // "MAINNET" | "TESTNET" | ...
  accountaccess: string | null; // "FULL" | "READONLY"
}

/**
 * Resolve an xApp one-time token (the `xAppToken` query param Xaman opens our xApp with) — server-side, with our API
 * key + secret, so the account can't be spoofed by the page. Single use: a second resolve of the same token fails.
 * Endpoint per xumm-sdk xApp.get(ott): GET /platform/xapp/ott/{ott}.
 */
export async function getXappOtt(ott: string): Promise<XappOtt | null> {
  const res = await xummFetch(`https://xumm.app/api/v1/platform/xapp/ott/${encodeURIComponent(ott)}`, { method: "GET" });
  const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !d || d.error) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { account: str(d.account), userToken: str(d.user), nodetype: str(d.nodetype), accountaccess: str(d.accountaccess) };
}

/**
 * One authenticated call to Xaman's platform ping — the cheapest call that proves the API key + secret are accepted.
 * Never throws. `ok` means Xaman answered 2xx without an error body; `rejected` means it refused the credentials.
 */
export async function xummPing(): Promise<{ ok: boolean; rejected: boolean; status: number; detail: string }> {
  try {
    const res = await fetch("https://xumm.app/api/v1/platform/ping", {
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal: AbortSignal.timeout(7_000),
    });
    const body = (await res.json().catch(() => null)) as { error?: { code?: number; reference?: string } } | null;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, rejected: true, status: res.status, detail: `Xaman rejected the API key/secret (HTTP ${res.status}${body?.error?.code ? `, code ${body.error.code}` : ""})` };
    }
    if (res.ok && !body?.error) return { ok: true, rejected: false, status: res.status, detail: "Xaman accepted the API key/secret" };
    return { ok: false, rejected: false, status: res.status, detail: `Xaman ping returned HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, rejected: false, status: 0, detail: `Xaman unreachable: ${e instanceof Error ? e.message : "error"}` };
  }
}

export interface CreatedPayload {
  uuid: string;
  qrPng: string | null;
  deepLink: string | null;
  expiresIn: number; // seconds
  /** Only when created with a userToken: Xaman confirmed it pushed the request to the user's app. */
  pushed?: boolean;
  /** The payload's status websocket (refs.websocket_status). */
  websocket?: string | null;
}

/**
 * Create a sign request. `options.submit` defaults to true (Xaman submits the
 * signed transaction to the ledger, like the transaction-service flow); pass
 * `submit: false` for a SignIn payload where there is nothing to submit.
 */
export async function createPayload(body: {
  txjson: Record<string, unknown>;
  instruction?: string;
  identifier?: string;
  blob?: Record<string, unknown>;
  expireMinutes?: number;
  submit?: boolean;
  /** Xaman push: a user token (application.issued_user_token from an earlier signed payload) sends this request
   *  straight to that user's Xaman app (docs.xaman.dev, "Push"). Valid 30 days after the user's last signature. */
  userToken?: string;
}): Promise<CreatedPayload> {
  const res = await xummFetch(XUMM_PAYLOAD, {
    method: "POST",
    body: JSON.stringify({
      txjson: body.txjson,
      ...(body.userToken ? { user_token: body.userToken } : {}),
      options: { submit: body.submit ?? true, expire: body.expireMinutes ?? 15 },
      custom_meta: {
        ...(body.identifier ? { identifier: body.identifier } : {}),
        ...(body.blob ? { blob: JSON.stringify(body.blob) } : {}),
        ...(body.instruction ? { instruction: body.instruction } : {}),
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.uuid) {
    const reason = data?.error?.reference || data?.message || `Xaman payload rejected (HTTP ${res.status})`;
    // A rejected payload with valid inputs means the Xaman app / API keys are
    // bad (revoked, deleted, quota) — every Xaman payment + free-key SignIn is
    // down until it's fixed. Make it loud.
    void notifyError("lib/xumm createPayload", new Error(String(reason)), {
      status: res.status,
      identifier: body.identifier ?? null,
    });
    throw new Error(String(reason));
  }

  return {
    uuid: data.uuid,
    qrPng: data.refs?.qr_png ?? null,
    deepLink: data.next?.always ?? null,
    expiresIn: 900,
    ...(body.userToken ? { pushed: data.pushed === true } : {}),
    websocket: data.refs?.websocket_status ?? null,
  };
}

export type PayloadState = "pending" | "signed" | "rejected" | "expired" | "not_found";

export interface PayloadStatus {
  state: PayloadState;
  txid: string | null;
  signer: string | null;     // the account that signed (for SignIn: the connected wallet)
  identifier: string | null; // custom_meta.identifier we set at create time
  /** application.issued_user_token — present once signed; lets us push later requests to this user. */
  userToken?: string | null;
  /** The signed transaction blob (response.hex) — what a submit:false request returns. */
  hex?: string | null;
}

export async function getPayloadStatus(uuid: string): Promise<PayloadStatus> {
  const res = await xummFetch(`${XUMM_PAYLOAD}/${encodeURIComponent(uuid)}`, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  const meta = data?.meta;

  const identifier =
    (data?.custom_meta?.identifier as string | undefined) ??
    (data?.payload?.custom_meta?.identifier as string | undefined) ??
    null;

  if (!meta?.exists) return { state: "not_found", txid: null, signer: null, identifier };
  if (meta.expired) return { state: "expired", txid: null, signer: null, identifier };
  if (meta.cancelled) return { state: "rejected", txid: null, signer: null, identifier };
  if (!meta.signed) return { state: "pending", txid: null, signer: null, identifier };

  // Xaman has moved the txid between response shapes across versions — probe both.
  const txid =
    (data?.response?.txid as string | undefined) ??
    (data?.payload?.response?.txid as string | undefined) ??
    null;
  const signer =
    (data?.response?.account as string | undefined) ??
    (data?.payload?.response?.account as string | undefined) ??
    null;

  const userToken =
    (data?.application?.issued_user_token as string | undefined) ?? null;
  const hex =
    (data?.response?.hex as string | undefined) ??
    (data?.payload?.response?.hex as string | undefined) ??
    null;
  return { state: "signed", txid, signer, identifier, userToken, hex };
}
