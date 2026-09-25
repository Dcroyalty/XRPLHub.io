// The five actions. Every one is READ-ONLY or BUILD-ONLY:
//   - it calls XRPLHub's public MCP tools and returns text + data;
//   - the only thing it ever hands back that could move value is an UNSIGNED transaction object for the agent's
//     own wallet to sign. There is no signing, no key handling, no submission and no setting anywhere in this package.

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { scanAddresses, scanMptIds } from "./address.ts";
import { isRecord, messageText, readBuildArgs, resolveAddress, resolveMptId, structuredParams } from "./args.ts";
import type { XrplhubClient } from "./client.ts";
import { clean, formatMpt, formatScore, formatScreen, formatServices, parseServices, UNSIGNED_NOTE, type ServiceSummary } from "./format.ts";

export const ACTION_NAMES = {
  score: "XRPLHUB_SCORE_WALLET",
  screen: "XRPLHUB_SCREEN_ADDRESS",
  mpt: "XRPLHUB_MPT_RISK",
  list: "XRPLHUB_LIST_SERVICES",
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
      "List every XRPL transaction XRPLHub can build unsigned (trustlines, escrows, AMM, NFTs, multisig, MPT issuance and more), with each one's parameters. Call this first so you pass the right product_id and params to XRPLHUB_BUILD_TRANSACTION. Read-only, free.",
    validate: async (_runtime, message) => /xrplhub|xrpl.{0,40}(service|transaction|build)|(build|create|set up).{0,30}(trustline|escrow|nft|amm|multisig|check)/i.test(messageText(message)),
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
    examples: [example("What XRPL transactions can XRPLHub build for me?", "Here is the list of services.", ACTION_NAMES.list)],
  };

  // ── 5. build (UNSIGNED) ─────────────────────────────────────────────────────
  const build: Action = {
    name: ACTION_NAMES.build,
    similes: ["BUILD_XRPL_TRANSACTION", "XRPL_TXJSON", "PREPARE_XRPL_TRANSACTION", "CREATE_UNSIGNED_XRPL_TX"],
    description:
      "Build an UNSIGNED, ready-to-sign XRPL transaction (txjson) for one of XRPLHub's services (trustline, escrow, AMM, NFT, multisig, MPT issuance…) for a given wallet. XRPLHub never signs and never holds keys: you sign and submit it with your own wallet. Parameters: product_id, wallet_address, params (object; see XRPLHUB_LIST_SERVICES).",
    validate: async (_runtime, message) => {
      const text = messageText(message);
      const s = scanAddresses(text);
      return (s.valid.length > 0 || s.malformed.length > 0) && /build|create|prepare|txjson|transaction|trustline|escrow|nft|amm|multisig|regular key|deposit auth|mpt/i.test(text);
    },
    handler: async (runtime, message, state, options, callback) => {
      const c: Ctx = { runtime, message, state, options, callback };
      const text = messageText(message);
      const sp = structuredParams(options);

      const wallet = resolveAddress(text, sp);
      if (!wallet.ok) return refusal(ACTION_NAMES.build, c, "bad_address", wallet.message);

      const args = readBuildArgs(text, sp);
      let productId = args.productId;

      if (!productId) {
        // No product named: try to match exactly one known service id in the text, otherwise show the menu.
        const s = await services();
        if (!s.ok) return refusal(ACTION_NAMES.build, c, "unavailable", `Could not load the service list: ${clean(s.error, 300)}`);
        const lower = text.toLowerCase();
        const hits = s.services.filter((svc) => new RegExp(`(^|[^a-z0-9])${svc.id.toLowerCase()}([^a-z0-9]|$)`).test(lower));
        if (hits.length === 1) productId = hits[0]!.id;
        else {
          return refusal(
            ACTION_NAMES.build,
            c,
            "product_id_required",
            `Which service should I build? Pass product_id as one of these ids.\n${formatServices(s.services)}`,
          );
        }
      }

      const res = await client.callTool("build_xrpl_transaction", { product_id: productId, wallet_address: wallet.value, params: args.params });
      if (!res.ok) {
        const missing = Array.isArray(res.data?.missingParams) ? (res.data!.missingParams as unknown[]).map((m) => clean(m, 60)).filter(Boolean) : [];
        const hint = missing.length ? ` Missing parameters: ${missing.join(", ")}. Provide them in params and call again.` : "";
        return refusal(ACTION_NAMES.build, c, res.retryable ? "unavailable" : "build_failed", `Could not build "${clean(productId, 60)}": ${clean(res.error, 300)}${hint}`);
      }

      // The server builds the transaction FOR this wallet. Verify that before handing it to a signer: a transaction whose
      // Account is anything else must never reach a wallet the agent then signs.
      const d = res.data;
      const steps: { id?: string; label?: string; tx: Record<string, unknown> }[] = [];
      if (Array.isArray(d.transactions) && d.transactions.length > 0) {
        for (const t of d.transactions) {
          if (!isRecord(t) || !isRecord(t.transaction)) return refusal(ACTION_NAMES.build, c, "bad_response", "XRPLHub returned a malformed multi-step transaction; refusing to use it.");
          steps.push({ id: typeof t.id === "string" ? clean(t.id, 40) : undefined, label: typeof t.label === "string" ? clean(t.label, 120) : undefined, tx: t.transaction });
        }
      } else if (isRecord(d.transaction)) {
        steps.push({ tx: d.transaction });
      } else {
        return refusal(ACTION_NAMES.build, c, "bad_response", "XRPLHub returned no transaction; refusing to continue.");
      }
      for (const s of steps) {
        if (typeof s.tx.TransactionType !== "string" || s.tx.Account !== wallet.value) {
          return refusal(
            ACTION_NAMES.build,
            c,
            "account_mismatch",
            `Refusing to return this transaction: it is not built for ${wallet.value} (Account is ${clean(s.tx.Account, 40) || "missing"}). Nothing should be signed.`,
          );
        }
      }

      const tier = typeof d.safetyTier === "string" ? clean(d.safetyTier, 20) : "unknown";
      const label = typeof d.label === "string" ? clean(d.label, 120) : clean(productId, 60);
      const lines = [
        `${label} — UNSIGNED transaction${steps.length > 1 ? "s" : ""} for ${wallet.value} (safety tier: ${tier}).`,
        UNSIGNED_NOTE,
      ];
      if (steps.length > 1) lines.push(`This service is ${steps.length} transactions. Sign and submit them IN ORDER, waiting for each to validate before the next.`);
      steps.forEach((s, i) => lines.push(`${steps.length > 1 ? `Step ${i + 1}${s.label ? ` (${s.label})` : ""}: ` : "txjson: "}${JSON.stringify(s.tx)}`));
      if (tier === "caution") lines.push("CAUTION: this changes account security or permissions and can be hard or impossible to undo. Show it to the wallet owner and get explicit confirmation before signing.");
      for (const k of ["permanenceNotice", "permanence", "notice"]) {
        if (typeof d[k] === "string") lines.push(clean(d[k], 600));
      }
      const txs = steps.map((s) => ({ ...(s.id ? { id: s.id } : {}), ...(s.label ? { label: s.label } : {}), txjson: s.tx }));
      return done(ACTION_NAMES.build, message, callback, {
        success: true,
        text: lines.join("\n"),
        values: { xrplhubUnsignedTransactions: txs },
        data: { productId, wallet: wallet.value, safetyTier: tier, unsigned: true, transactions: txs },
      });
    },
    examples: [
      example(
        "Build me a trustline to RLUSD for rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF.",
        "Building the unsigned trustline transaction; you sign it with your own wallet.",
        ACTION_NAMES.build,
      ),
    ],
  };

  return [score, screen, mpt, list, build];
}
