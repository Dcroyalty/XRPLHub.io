// The three actions — all read-only lookups against XRPLHub's public MCP tools (score, sanctions screen, MPT issuer risk).
// The transaction list/preview/build actions were removed on 2026-10-07 along with XRPLHub's generic transaction catalog.
// There is no signing, no key handling, no submission and no setting anywhere in this package.

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { scanAddresses, scanMptIds } from "./address.ts";
import { messageText, resolveAddress, resolveMptId, structuredParams } from "./args.ts";
import type { XrplhubClient } from "./client.ts";
import { clean, formatMpt, formatScore, formatScreen } from "./format.ts";

export const ACTION_NAMES = {
  score: "XRPLHUB_SCORE_WALLET",
  screen: "XRPLHUB_SCREEN_ADDRESS",
  mpt: "XRPLHUB_MPT_RISK",
} as const;

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

/** This plugin is read-only: a transaction a (misbehaving) server put in a response is never passed on. */
function withoutTx(d: Record<string, unknown>): Record<string, unknown> {
  const { transaction: _a, txjson: _b, transactions: _c, ...rest } = d;
  void _a; void _b; void _c;
  return rest;
}

const example = (user: string, agent: string, action: string) => [
  { name: "{{name1}}", content: { text: user } },
  { name: "{{agentName}}", content: { text: agent, actions: [action] } },
];

export function createActions(client: XrplhubClient): Action[] {
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
        data: { wallet: a.value, xrplScore: res.data.xrplScore ?? null, grade: res.data.grade ?? null, raw: withoutTx(res.data) },
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
        data: { address: a.value, raw: withoutTx(res.data) },
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
        data: { issuanceId: id.value, raw: withoutTx(res.data) },
      });
    },
    examples: [
      example("Is MPT 0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045 safe to hold?", "Looking up that issuance's issuer powers.", ACTION_NAMES.mpt),
    ],
  };

  return [score, screen, mpt];
}
