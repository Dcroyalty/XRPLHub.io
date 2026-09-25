// src/lib/x402Dual.ts
// One URL, two payment rails: USDC on Base (x402 v1, CDP facilitator, X-PAYMENT header — the existing behaviour) AND
// RLUSD on the XRP Ledger (x402 v2, t54 facilitator, PAYMENT-SIGNATURE header). Additive: nothing about the Base flow
// changes for a client that already pays on Base.
//
// HOW A REQUEST IS ROUTED
//   PAYMENT-SIGNATURE present -> XRPL rail: serveX402Paid (verify -> handler -> settle; never charged on a failure,
//                                idempotent, one inline settle retry) — the same flow /api/x402/{score,report,tx} use.
//   anything else            -> the existing Base wrapper (withX402). If that answers with its 402 challenge, we ADD the
//                                XRPL v2 challenge as a `PAYMENT-REQUIRED` header. The body stays the v1 Base challenge
//                                (what CDP Bazaar / existing Base clients read); v2 clients and the xrpl-ai.org directory
//                                read the header (network "xrpl:0").
//
// The handler is SHARED: the XRPL rail calls the very same function the Base rail does and adapts its JSON response, so
// the two rails cannot drift apart. The XRPL rail wraps the result as { data, x402 } (same envelope as /api/x402/score).
//
// PRICING may be per request (a function of the request): /api/x402/tx charges the storefront price of whichever service
// was asked for. The two rails must agree on every request; if they ever do not, the request FAILS CLOSED (HTTP 500 and an
// alert) rather than quoting different prices on different rails.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import {
  X402_ERROR_CODES,
  encodeHeader,
  paymentRequiredChallenge,
  rlusdRequirements,
  serveX402Paid,
  statelessInvoiceId,
  type HandlerResult,
  type X402ErrorCode,
} from "@/lib/x402";
import { TREASURY_ADDRESS } from "@/lib/paycall";
import { notifyError } from "@/lib/notify";

export interface DualSchemas { input: unknown; output: unknown; outputExample?: unknown }

type PerRequest<T> = T | ((req: NextRequest) => T);

export interface DualOpts {
  /** Stable resource path for the challenge + the idempotency key, e.g. "/api/x402/screen/ofac". */
  resource: string;
  /** recordPaidInvoice plan tag, e.g. "x402:screen-ofac". */
  plan: PerRequest<string>;
  amountRlusd: PerRequest<number>;
  /** The Base (USDC) price of the same resource; the two MUST be the same face value on every request. */
  amountUsdc: PerRequest<number>;
  name: string;
  description: string;
  schemas: DualSchemas;
  /** The existing `withX402(handler, …)` export for the Base rail (may pick a wrapper per request). */
  base: (req: NextRequest) => Promise<Response>;
  /** The shared handler both rails run (the same function `base` wraps). Runs only after payment verification. */
  core: (req: NextRequest) => Promise<Response>;
  /** XRPL rail only: reshape the shared handler's JSON body into the `data` of the { data, x402 } envelope (default: as is). */
  xrplData?: (body: unknown) => unknown;
  /** Refuse a malformed request BEFORE any challenge (nothing to pay against). Return a Response to refuse. */
  refuse?: (req: NextRequest) => Response | null | Promise<Response | null>;
}

// The v2 challenge rides in a response header; keep it well inside proxy header limits. Input schema is always included;
// the output schema only when small (the full one is always in /.well-known/x402 and /openapi.json).
const MAX_SCHEMA_CHARS = 4_000;

function headerSchemas(s: DualSchemas): DualSchemas | undefined {
  const size = (v: unknown) => JSON.stringify(v ?? null).length;
  if (size(s.input) > MAX_SCHEMA_CHARS) return undefined;
  const out = size(s.output) + size(s.outputExample) <= MAX_SCHEMA_CHARS;
  return out ? s : { input: s.input, output: { note: "Full output schema: /.well-known/x402 and /openapi.json." } };
}

const CODES = X402_ERROR_CODES as Record<string, string>;

/** Adapt the shared handler's JSON response to the XRPL rail's HandlerResult. */
async function toHandlerResult(res: Response, reshape?: (body: unknown) => unknown): Promise<HandlerResult> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status < 400) return { ok: true, data: reshape ? reshape(body) : body };
  const err = typeof body?.error === "string" ? (body.error as string) : "";
  const message = typeof body?.message === "string" ? (body.message as string) : err || `handler returned HTTP ${res.status}`;
  let code: X402ErrorCode = "handler_failed";
  if (body?.status === "amendment-not-active") code = "amendment_not_active";
  else if (err && err in CODES && err !== "settlement_failed") code = err as X402ErrorCode;
  return { ok: false, code, status: res.status, message, details: body ?? undefined };
}

const resolve = <T>(v: PerRequest<T>, req: NextRequest): T => (typeof v === "function" ? (v as (r: NextRequest) => T)(req) : v);

export function dualX402(opts: DualOpts): (req: NextRequest) => Promise<Response> {
  return async (req: NextRequest): Promise<Response> => {
    const refused = opts.refuse ? await opts.refuse(req) : null;
    if (refused) return refused;

    const amountRlusd = resolve(opts.amountRlusd, req);
    const amountUsdc = resolve(opts.amountUsdc, req);
    const plan = resolve(opts.plan, req);
    // A price drift between the rails would let one rail undercut the other silently. Fail closed and say so.
    if (!(amountRlusd > 0) || Math.abs(amountRlusd - amountUsdc) > 1e-9) {
      void notifyError(`x402Dual price mismatch ${opts.resource}`, new Error(`RLUSD ${amountRlusd} != USDC ${amountUsdc}`), { plan });
      return NextResponse.json({ error: "price_mismatch", message: "This resource is temporarily unavailable (pricing error). Nothing was charged." }, { status: 500 });
    }

    const requirements = (invoiceId: string) =>
      rlusdRequirements({
        payTo: TREASURY_ADDRESS,
        amountRlusd,
        invoiceId,
        name: opts.name,
        description: opts.description,
        schemas: headerSchemas(opts.schemas),
      });

    // XRPL rail
    if (req.headers.get("PAYMENT-SIGNATURE")) {
      return serveX402Paid({
        req,
        prisma,
        resource: new URL(req.url).pathname, // the concrete path (matters for /mpt/{id})
        plan,
        amountRlusd,
        challengeDescription: opts.description.slice(0, 480),
        requirements,
        handler: async () => toHandlerResult(await opts.core(req), opts.xrplData),
      });
    }

    // Base rail (unchanged). Add the XRPL challenge header only to its own 402 challenge.
    const res = await opts.base(req);
    if (res.status !== 402 || req.headers.get("X-PAYMENT")) return res;

    const challenge = paymentRequiredChallenge(requirements(statelessInvoiceId(plan)), new URL(req.url).pathname, opts.description.slice(0, 480));
    const headers = new Headers(res.headers);
    headers.set("PAYMENT-REQUIRED", encodeHeader(challenge));
    headers.set("Cache-Control", "no-store");
    return new NextResponse(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
