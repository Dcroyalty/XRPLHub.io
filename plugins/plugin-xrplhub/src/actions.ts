// The six actions. Every one is READ-ONLY, DESCRIBE-ONLY or PAYMENT-INFO-ONLY:
//   - it calls XRPLHub's public MCP tools and returns text + data;
//   - none of them ever returns a signable transaction. The transaction (txjson) is sold: XRPLHub delivers it only after an
//     x402 payment (USDC on Base or RLUSD on XRPL). XRPLHUB_BUILD_TRANSACTION returns the PAYMENT RESOURCE for the agent's
//     own x402 client/wallet to pay; XRPLHUB_PREVIEW_TRANSACTION describes a transaction for free.
//   - there is no signing, no key handling, no submission and no setting anywhere in this package.

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { scanAddresses, scanMptIds } from "./address.ts";
import { messageText, readBuildArgs, resolveAddress, resolveMptId, structuredParams, type BuildArgs } from "./args.ts";
import type { XrplhubClient } from "./client.ts";
import {
  checkPaymentResource,
  clean,
  confirmationLines,
  formatMpt,
  formatPreview,
  formatScore,
  formatScreen,
  formatServices,
  parseServices,
  UNSIGNED_NOTE,
  type ServiceSummary,
} from "./format.ts";
import { isRecord } from "./args.ts";

export const ACTION_NAMES = {
  score: "XRPLHUB_SCORE_WALLET",
  screen: "XRPLHUB_SCREEN_ADDRESS",
  mpt: "XRPLHUB_MPT_RISK",
  list: "XRPLHUB_LIST_SERVICES",
  preview: "XRPLHUB_PREVIEW_TRANSACTION",
  build: "XRPLHUB_BUILD_TRANSACTION",
} as const;

const SERVICE_LIST_TTL_MS = 10 * 60 * 1000;

type Ctx = { runtime: IAgentRuntime; message: Memory; state?: State; options?: HandlerOptions; callback?: HandlerCallback };

function done(name: string, message: Memory, callback: HandlerCallback | undefined, result: ActionResult): ActionResult {
  if (callback && result.text) {
    // Never let a callback failure turn a finished lookup into a thrown error inside the runtime.
    void Promise.resolve(callback({ text: result.text, actions: [name], source: message.content?.source })).catch(() => undefined);
  }
  return result;
}

function refusal(name: string, c: Ctx, code: string, text: string): ActionResult {
  return done(name, c.message, c.callback, { success: false, text, error: code });
}

const example = (user: string, agent: string, action: string) => [
  { name: "{{name1}}", content: { text: user } },
  { name: "{{agentName}}", content: { text: agent, actions: [action] } },
];

const SERVICE_WORDS = /trustline|escrow|nft|amm|multisig|regular key|deposit auth|mpt|credential|permissioned|check|ticket|payment channel|freeze|did\b/i;

export function createActions(client: XrplhubClient): Action[] {
  let serviceCache: { at: number; services: ServiceSummary[] } | undefined;

  async function services(): Promise<{ ok: true; services: ServiceSummary[] } | { ok: false; error: string }> {
    if (serviceCache && Date.now() - serviceCache.at < SERVICE_LIST_TTL_MS) return { ok: true, services: serviceCache.services };
    const res = await client.callTool("list_xrpl_services", {});
    if (!res.ok) return { ok: false, error: res.error };
    const list = parseServices(res.data);
    if (list.length === 0) return { ok: false, error: "XRPLHub returned an empty service list." };
    serviceCache = { at: Date.now(), services: list };
    return { ok: true, services: list };
  }

  /** The service asked for: explicit product_id, else exactly one known id named in the text, else the menu. */
  async function resolveProduct(name: string, c: Ctx, text: string, args: BuildArgs, verb: string): Promise<{ ok: true; productId: string } | { ok: false; result: ActionResult }> {
    if (args.productId) return { ok: true, productId: args.productId.toLowerCase() };
    const s = await services();
    if (!s.ok) return { ok: false, result: refusal(name, c, "unavailable", `Could not load the service list: ${clean(s.error, 300)}`) };
    const lower = text.toLowerCase();
    const hits = s.services.filter((svc) => new RegExp(`(^|[^a-z0-9])${svc.id.toLowerCase()}([^a-z0-9]|$)`).test(lower));
    if (hits.length === 1) return { ok: true, productId: hits[0]!.id };
    return { ok: false, result: refusal(name, c, "product_id_required", `Which service should I ${verb}? Pass product_id as one of these ids.\n${formatServices(s.services)}`) };
  }

  // ── 1. score ────────────────────────────────────────────────────────────────
  const score: Action = {
    name: ACTION_NAMES.score,
    similes: ["CHECK_XRPL_SCORE", "XRPLSCORE", "WALLET_CREDIT_SCORE", "XRPL_WALLET_REPUTATION", "CHECK_XRPL_WALLET"],
    description:
      "Get the XRPLScore (300–850, 8 on-chain signals) for one XRPL wallet address. Use it BEFORE paying, lending to, or onboarding an XRPL wallet. Read-only, free, no signup.",
    validate: async (_runtime, message) => {
      const s = scanAddresses(messageText(message));
      return s.valid.length > 0 || s.malformed.length > 0;
    },
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const a = resolveAddress(messageText(message), structuredParams(options));
      if (!a.ok) return refusal(ACTION_NAMES.score, c, "bad_address", a.message);
      const res = await client.callTool("check_xrpl_score", { wallet_address: a.value });
      if (!res.ok) return refusal(ACTION_NAMES.score, c, res.retryable ? "unavailable" : "lookup_failed", `Could not score ${a.value}: ${clean(res.error, 300)}`);
      return done(ACTION_NAMES.score, message, callback, {
        success: true,
        text: formatScore(a.value, res.data),
        data: { wallet: a.value, xrplScore: res.data.xrplScore ?? null, grade: res.data.grade ?? null, raw: res.data },
      });
    },
    examples: [
      example("What's the credit score of rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF?", "Checking its XRPLScore now.", ACTION_NAMES.score),
    ],
  };

  // ── 2. screen ───────────────────────────────────────────────────────────────
  const screen: Action = {
    name: ACTION_NAMES.screen,
    similes: ["OFAC_SCREEN", "SCREEN_XRPL_ADDRESS", "SANCTIONS_CHECK_XRPL", "CHECK_OFAC_XRPL"],
    description:
      "Compare one XRPL address against a pinned OFAC SDN snapshot and return a verifiable receipt. Attests to process, not ground truth: 'no match' does NOT mean an address is clean or unsanctioned. Read-only, free.",
    validate: async (_runtime, message) => {
      const text = messageText(message);
      const s = scanAddresses(text);
      return (s.valid.length > 0 || s.malformed.length > 0) && /ofac|sdn|sanction|screen|compliance|blocklist/i.test(text);
    },
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const a = resolveAddress(messageText(message), structuredParams(options));
      if (!a.ok) return refusal(ACTION_NAMES.screen, c, "bad_address", a.message);
      const res = await client.callTool("screen_address_ofac", { address: a.value });
      if (!res.ok) return refusal(ACTION_NAMES.screen, c, res.retryable ? "unavailable" : "screen_failed", `Could not screen ${a.value}: ${clean(res.error, 300)}`);
      return done(ACTION_NAMES.screen, message, callback, {
        success: true,
        text: formatScreen(a.value, res.data),
        data: { address: a.value, raw: res.data },
      });
    },
    examples: [
      example("Screen rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF against OFAC before I send funds.", "Running the OFAC SDN screening.", ACTION_NAMES.screen),
    ],
  };

  // ── 3. mpt ──────────────────────────────────────────────────────────────────
  const mpt: Action = {
    name: ACTION_NAMES.mpt,
    similes: ["CHECK_MPT_RISK", "MPT_ISSUER_RISK", "LOOKUP_MPT", "XRPL_MPT_RISK"],
    description:
      "Look up one XLS-33 Multi-Purpose Token (48-hex MPTokenIssuanceID): what the issuer can do to a holder (clawback, freeze, require-auth, non-transferable) plus the issuer's XRPLScore. Read-only, free.",
    validate: async (_runtime, message) => scanMptIds(messageText(message)).length > 0,
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const id = resolveMptId(messageText(message), structuredParams(options));
      if (!id.ok) return refusal(ACTION_NAMES.mpt, c, "bad_issuance_id", id.message);
      const res = await client.callTool("check_mpt_risk", { issuance_id: id.value });
      if (!res.ok) return refusal(ACTION_NAMES.mpt, c, res.retryable ? "unavailable" : "lookup_failed", `Could not look up ${id.value}: ${clean(res.error, 300)}`);
      return done(ACTION_NAMES.mpt, message, callback, {
        success: true,
        text: formatMpt(id.value, res.data),
        data: { issuanceId: id.value, raw: res.data },
      });
    },
    examples: [
      example("Is MPT 0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045 safe to hold?", "Looking up that issuance's issuer powers.", ACTION_NAMES.mpt),
    ],
  };

  // ── 4. list services ────────────────────────────────────────────────────────
  const list: Action = {
    name: ACTION_NAMES.list,
    similes: ["LIST_XRPL_SERVICES", "XRPL_SERVICE_CATALOG", "WHAT_CAN_XRPLHUB_BUILD"],
    description:
      "List every XRPL transaction XRPLHub sells (trustlines, escrows, AMM, NFTs, multisig, MPT issuance and more) with each one's price and parameters. Call this first so you pass the right product_id and params to XRPLHUB_PREVIEW_TRANSACTION or XRPLHUB_BUILD_TRANSACTION. Read-only, free.",
    validate: async (_runtime, message) => /xrplhub|xrpl.{0,40}(service|transaction|build)|(build|create|set up|buy).{0,30}(trustline|escrow|nft|amm|multisig|check)/i.test(messageText(message)),
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const s = await services();
      if (!s.ok) return refusal(ACTION_NAMES.list, c, "unavailable", `Could not load the service list: ${clean(s.error, 300)}`);
      return done(ACTION_NAMES.list, message, callback, {
        success: true,
        text: formatServices(s.services),
        data: { count: s.services.length, services: s.services },
      });
    },
    examples: [example("What XRPL transactions can XRPLHub build for me?", "Here is the list of services and prices.", ACTION_NAMES.list)],
  };

  // ── 5. preview (FREE description, no transaction) ───────────────────────────
  const preview: Action = {
    name: ACTION_NAMES.preview,
    similes: ["DESCRIBE_XRPL_TRANSACTION", "PREVIEW_XRPL_TRANSACTION", "XRPL_TRANSACTION_PRICE", "WHAT_DOES_THIS_XRPL_TX_DO"],
    description:
      "FREE. Describe one XRPL transaction before buying it: what it does, what is irreversible, the price, and every field it needs. Returns NO signable transaction. Parameters: product_id (from XRPLHUB_LIST_SERVICES), params (optional).",
    validate: async (_runtime, message) => {
      const text = messageText(message);
      return SERVICE_WORDS.test(text) && /preview|describe|what (does|would)|how much|price|cost|irreversible|undo|explain/i.test(text);
    },
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const text = messageText(message);
      const args = readBuildArgs(text, structuredParams(options));
      const p = await resolveProduct(ACTION_NAMES.preview, c, text, args, "describe");
      if (!p.ok) return p.result;
      const res = await client.callTool("preview_xrpl_transaction", { product_id: p.productId, params: args.params });
      if (!res.ok) return refusal(ACTION_NAMES.preview, c, res.retryable ? "unavailable" : "preview_failed", `Could not describe "${clean(p.productId, 60)}": ${clean(res.error, 300)}`);
      const d = res.data;
      return done(ACTION_NAMES.preview, message, callback, {
        success: true,
        text: formatPreview(d),
        // Whitelisted fields only: a description, never a transaction.
        data: {
          productId: p.productId,
          label: typeof d.label === "string" ? clean(d.label, 120) : p.productId,
          safetyTier: typeof d.safetyTier === "string" ? clean(d.safetyTier, 20) : "unknown",
          priceUsd: isRecord(d.price) && typeof d.price.usd === "number" ? d.price.usd : null,
          requiresConfirmation: isRecord(d.irreversible) && d.irreversible.requiresConfirmation === true,
          transactionIncluded: false,
        },
      });
    },
    examples: [
      example("What does a multisig lockdown do and how much is it?", "Here is what it does, what cannot be undone, and the price.", ACTION_NAMES.preview),
    ],
  };

  // ── 6. build = BUY: returns the x402 payment resource, never the transaction ─
  const build: Action = {
    name: ACTION_NAMES.build,
    similes: ["BUY_XRPL_TRANSACTION", "BUILD_XRPL_TRANSACTION", "GET_XRPL_TXJSON_PAYMENT", "PREPARE_XRPL_TRANSACTION"],
    description:
      "BUY the unsigned transaction for one XRPL service. This action returns the x402 PAYMENT RESOURCE (an https://www.xrplhub.io/api/x402/tx URL) and the price; it does not return the transaction. Pay the resource with your own x402 client (USDC on Base or RLUSD on XRPL) and that response is the txjson to sign with your own wallet. XRPLHub never signs and never holds keys. Parameters: product_id, wallet_address, params (object), confirm_caution (caution-tier only, after the wallet owner has read the preview).",
    validate: async (_runtime, message) => {
      const text = messageText(message);
      const s = scanAddresses(text);
      return (s.valid.length > 0 || s.malformed.length > 0) && (/build|buy|purchase|create|prepare|txjson|transaction/i.test(text) || SERVICE_WORDS.test(text));
    },
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const text = messageText(message);
      const sp = structuredParams(options);

      const wallet = resolveAddress(text, sp);
      if (!wallet.ok) return refusal(ACTION_NAMES.build, c, "bad_address", wallet.message);

      const args = readBuildArgs(text, sp);
      const p = await resolveProduct(ACTION_NAMES.build, c, text, args, "buy");
      if (!p.ok) return p.result;
      const productId = p.productId;

      const payload: Record<string, unknown> = { product_id: productId, wallet_address: wallet.value, params: args.params };
      if (args.confirmCaution) payload.confirm_caution = true;
      const res = await client.callTool("build_xrpl_transaction", payload);
      if (!res.ok) {
        const missing = Array.isArray(res.data?.missingParams) ? (res.data!.missingParams as unknown[]).map((m) => clean(m, 60)).filter(Boolean) : [];
        const hint = missing.length ? ` Missing parameters: ${missing.join(", ")}. Provide them in params and call again. Nothing was charged.` : "";
        return refusal(ACTION_NAMES.build, c, res.retryable ? "unavailable" : "build_failed", `Could not prepare "${clean(productId, 60)}": ${clean(res.error, 300)}${hint}`);
      }
      const d = res.data;

      // Caution-tier and not yet confirmed: the server withholds the payment resource. Pass the warning on; buy nothing.
      if (d.requiresConfirmation === true) {
        const conf = isRecord(d.irreversible) ? confirmationLines(d.irreversible) : ["CAUTION — this can be hard or impossible to undo. Show the preview to the wallet owner before buying."];
        return done(ACTION_NAMES.build, message, callback, {
          success: false,
          error: "confirmation_required",
          text: [
            `CONFIRMATION REQUIRED before buying "${clean(productId, 60)}". Nothing was charged and no payment resource was issued.`,
            ...conf,
            "When the wallet owner has confirmed, call XRPLHUB_BUILD_TRANSACTION again with confirm_caution: true.",
          ].join("\n"),
          data: { productId, wallet: wallet.value, requiresConfirmation: true, transactionIncluded: false },
        });
      }

      // The payment resource is where money goes: only ever surface XRPLHub's own URL for exactly this service and wallet.
      const checked = checkPaymentResource(d.resource, productId, wallet.value);
      if (!checked.ok) {
        return refusal(ACTION_NAMES.build, c, "bad_payment_resource", `Refusing to give you a payment URL: ${checked.reason}. Nothing was charged.`);
      }
      const usd = isRecord(d.price) && typeof d.price.usd === "number" ? d.price.usd : null;
      const label = typeof d.label === "string" ? clean(d.label, 120) : clean(productId, 60);
      return done(ACTION_NAMES.build, message, callback, {
        success: true,
        text: [
          `${label} for ${wallet.value}: the signable transaction is delivered after payment.`,
          `Payment resource: GET ${checked.url}`,
          usd != null ? `Price: $${usd} (USD = RLUSD = USDC). Pay in USDC on Base or RLUSD on the XRP Ledger with your own x402 client; you are charged only if the transaction builds.` : "Pay with your own x402 client (USDC on Base or RLUSD on XRPL); you are charged only if the transaction builds.",
          `After payment: check every returned transaction's Account equals ${wallet.value}, then sign with your own wallet and submit it (multi-step services: in order). ${UNSIGNED_NOTE}`,
        ].join("\n"),
        values: { xrplhubPaymentResource: checked.url },
        // Whitelisted fields only. No transaction is ever in here.
        data: { productId, wallet: wallet.value, resource: checked.url, priceUsd: usd, payWith: ["USDC on Base (x402 v1)", "RLUSD on XRPL (x402 v2 via t54)"], transactionIncluded: false },
      });
    },
    examples: [
      example(
        "Buy me a trustline transaction for rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF (RLUSD, limit 100).",
        "Here is the payment resource and price; pay it with your x402 wallet and you get the unsigned transaction to sign.",
        ACTION_NAMES.build,
      ),
    ],
  };

  return [score, screen, mpt, list, preview, build];
}
