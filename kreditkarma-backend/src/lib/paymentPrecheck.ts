// src/lib/paymentPrecheck.ts
// The AGENT PAYMENT PRE-CHECK: before an agent pays an XRPL address, one call returns the destination's XRPLScore, a
// sanctions screen (every list we hold, with its own Merkle-anchored receipt), the account's age and ledger flags, the
// reasons a payment would be REJECTED by the ledger, and red flags — resolved into one verdict by fixed, published rules.
// Answers "a spending limit is a fence, not judgment": limits say whether you can afford it, this says whether to send it.
//
// The verdict is mechanical, not advice: every reason is listed with the rule that fired, so an agent (or its owner) can
// apply its own policy instead. "proceed" never means safe — it means none of these rules fired at the time of the check.
//
//   block    — a sanctions list names this address, OR the ledger would reject this payment as described (wouldFail).
//   caution  — a red flag fired (new account, low score, blackholed, DisallowXRP, sanctions screen unavailable, score
//              unreadable). Pay only if your own policy accepts it.
//   proceed  — no rule fired.

import type { PrismaClient } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import { isValidXrplAddress } from "./address";
import { computeScore, AccountNotFoundError, type ScoreResult } from "./engine";
import { ListUnavailableError, screenAll, type ScreenOutcome } from "./screen";
import { RLUSD_HEX, RLUSD_ISSUER } from "./pricing";

export const PRECHECK_VERSION = "payment-precheck-v1";

// AccountRoot flags
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DISALLOW_XRP = 0x00080000;
const LSF_DISABLE_MASTER = 0x00100000;
const LSF_DEPOSIT_AUTH = 0x01000000;

/** Thresholds, published with every response (rules[]). */
export const NEW_ACCOUNT_DAYS = 7;
export const LOW_SCORE = 500;

export type Verdict = "block" | "caution" | "proceed";
export interface PrecheckReason { code: string; severity: "block" | "caution"; detail: string }

export interface PrecheckInput {
  destination: string;
  amount?: string | null;
  currency?: "XRP" | "RLUSD" | null;
  destinationTag?: number | null;
  from?: string | null;
}

export const PRECHECK_RULES = [
  "block: a sanctions list we hold names the destination address (exact address match, list versions in sanctions.lists)",
  "block (wouldFail): the destination account does not exist and the payment is not enough XRP to create it, or is not XRP",
  "block (wouldFail): the destination requires a destination tag and none was given",
  "block (wouldFail): the destination has Deposit Authorization on and `from` is not preauthorized",
  "block (wouldFail): an RLUSD payment to an account with no RLUSD trust line",
  `caution: account younger than ${NEW_ACCOUNT_DAYS} days`,
  `caution: XRPLScore below ${LOW_SCORE}`,
  "caution: blackholed account (master key disabled, no regular key, no signer list) — funds sent there can never move again",
  "caution: the destination asks not to receive XRP (DisallowXRP — advisory, not enforced by the ledger)",
  "caution: the sanctions screen or the score could not be completed right now (fail closed: never 'proceed')",
] as const;

export const PRECHECK_DISCLAIMER =
  "A mechanical pre-payment check of public XRP Ledger data and the sanctions list versions named, at the stated time. " +
  "The verdict comes from the fixed rules listed; it is not advice, not a guarantee that a payment is safe or lawful, and " +
  "'proceed' only means none of the rules fired. A sanctions 'no match' is not a statement that the address is unsanctioned. " +
  "XRPLHub is not a regulated entity and makes no compliance decision. You remain responsible for your own payments.";

// Discovery schemas (the route, .well-known/x402 and openapi share them).
export const PRECHECK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    destination: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$", description: "The XRPL address you are about to pay." },
    amount: { type: "string", description: "Optional. The amount you intend to send (plain decimal)." },
    currency: { type: "string", enum: ["XRP", "RLUSD"], description: "Optional. Default XRP when amount is given." },
    destinationTag: { type: "integer", description: "Optional. The destination tag you will use." },
    from: { type: "string", description: "Optional. Your paying address — lets us check Deposit Authorization preauth." },
  },
  required: ["destination"],
} as const;

export const PRECHECK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["block", "caution", "proceed"] },
    wouldFail: { type: "boolean", description: "true = the ledger would reject this payment as described." },
    reasons: { type: "array", items: { type: "object", properties: { code: { type: "string" }, severity: { type: "string" }, detail: { type: "string" } } } },
    xrplScore: { type: "object", properties: { score: { type: "integer" }, grade: { type: "string" }, percentile: { type: "number" } } },
    sanctions: { type: "object", properties: { listed: { type: "boolean" }, lists: { type: "array" }, queryId: { type: "string" }, verify: { type: "string" } } },
    account: { type: "object", properties: { exists: { type: "boolean" }, ageDays: { type: "integer" }, requiresDestinationTag: { type: "boolean" }, depositAuth: { type: "boolean" }, disallowXrp: { type: "boolean" }, blackholed: { type: "boolean" } } },
    rules: { type: "array", items: { type: "string" } },
    disclaimer: { type: "string" },
  },
  required: ["verdict", "reasons", "rules"],
} as const;

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const r = await xrplRpc(method, { ...params, ledger_index: "validated" });
  return r.ok ? ((r.body.result as Record<string, unknown>) ?? null) : null;
}

export class PrecheckInputError extends Error {}

export function parsePrecheckInput(q: Record<string, unknown>): PrecheckInput {
  const destination = String(q.destination ?? q.address ?? "").trim();
  if (!isValidXrplAddress(destination)) throw new PrecheckInputError("destination must be a valid XRPL r-address (checksum verified)");
  const cur = q.currency == null || q.currency === "" ? null : String(q.currency).toUpperCase();
  if (cur !== null && cur !== "XRP" && cur !== "RLUSD") throw new PrecheckInputError("currency must be XRP or RLUSD");
  const amount = q.amount == null || q.amount === "" ? null : String(q.amount).trim();
  if (amount !== null && !/^\d+(\.\d{1,15})?$/.test(amount)) throw new PrecheckInputError("amount must be a plain positive decimal");
  const tagRaw = q.destinationTag ?? q.tag;
  const destinationTag = tagRaw == null || tagRaw === "" ? null : Number(tagRaw);
  if (destinationTag !== null && (!Number.isInteger(destinationTag) || destinationTag < 0 || destinationTag > 4_294_967_295)) {
    throw new PrecheckInputError("destinationTag must be a whole number 0–4294967295");
  }
  const from = q.from == null || q.from === "" ? null : String(q.from).trim();
  if (from !== null && !isValidXrplAddress(from)) throw new PrecheckInputError("from must be a valid XRPL r-address");
  return { destination, amount, currency: cur as PrecheckInput["currency"], destinationTag, from };
}

export async function runPaymentPrecheck(prisma: PrismaClient, input: PrecheckInput, requestedBy: string) {
  const reasons: PrecheckReason[] = [];
  const { destination } = input;

  // Ledger reads + score + sanctions, in parallel.
  const [info, state, scoreR, screenR] = await Promise.all([
    rpc("account_info", { account: destination, signer_lists: true }),
    rpc("server_state", {}),
    computeScore(destination).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
    screenAll(prisma, destination, requestedBy).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })),
  ]);

  // ── account ──
  const vl = (state?.state as { validated_ledger?: { reserve_base?: number; seq?: number } } | undefined)?.validated_ledger;
  const baseReserveXrp = (vl?.reserve_base ?? 1_000_000) / 1e6;
  const exists = !!info && info.error !== "actNotFound" && !!info.account_data;
  const readable = !!info;
  const d = (info?.account_data ?? {}) as { Flags?: number; RegularKey?: string; Balance?: string; signer_lists?: unknown[] };
  const flags = Number(d.Flags ?? 0);
  const signerLists = (info?.signer_lists as unknown[] | undefined) ?? d.signer_lists ?? [];
  const account = {
    exists: readable ? exists : null,
    ageDays: scoreR.ok ? scoreR.v.details.accountAgeDays : null,
    balanceXrp: exists ? Number(d.Balance ?? 0) / 1e6 : null,
    requiresDestinationTag: exists ? !!(flags & LSF_REQUIRE_DEST_TAG) : null,
    depositAuth: exists ? !!(flags & LSF_DEPOSIT_AUTH) : null,
    disallowXrp: exists ? !!(flags & LSF_DISALLOW_XRP) : null,
    blackholed: exists ? !!(flags & LSF_DISABLE_MASTER) && !d.RegularKey && !(Array.isArray(signerLists) && signerLists.length) : null,
  };

  const currency = input.currency ?? (input.amount ? "XRP" : null);
  if (!readable) {
    reasons.push({ code: "LEDGER_UNREADABLE", severity: "caution", detail: "Could not read the destination account from the XRP Ledger just now." });
  } else if (!exists) {
    const amt = Number(input.amount ?? 0);
    if (currency && currency !== "XRP") reasons.push({ code: "DESTINATION_NOT_FOUND", severity: "block", detail: `The destination account does not exist; a ${currency} payment to it will fail (only XRP can create an account).` });
    else if (input.amount && amt < baseReserveXrp) reasons.push({ code: "DESTINATION_NOT_FOUND", severity: "block", detail: `The destination account does not exist; a payment under ${baseReserveXrp} XRP (the base reserve) can't create it and will fail.` });
    else reasons.push({ code: "DESTINATION_NOT_FOUND", severity: "caution", detail: `The destination account does not exist yet. Only an XRP payment of at least ${baseReserveXrp} XRP creates it.` });
  } else {
    if (account.requiresDestinationTag && input.destinationTag == null) {
      reasons.push({ code: "DESTINATION_TAG_REQUIRED", severity: "block", detail: "The destination requires a destination tag (typically an exchange or custodian account) and none was given — the payment will be rejected." });
    }
    if (account.depositAuth) {
      if (input.from) {
        const auth = await rpc("deposit_authorized", { source_account: input.from, destination_account: destination });
        if (auth && auth.deposit_authorized === false) reasons.push({ code: "DEPOSIT_AUTH_NOT_PREAUTHORIZED", severity: "block", detail: "The destination has Deposit Authorization on and `from` is not preauthorized — the payment will be rejected." });
        else if (!auth) reasons.push({ code: "DEPOSIT_AUTH_UNCHECKED", severity: "caution", detail: "The destination has Deposit Authorization on; whether `from` is preauthorized could not be read." });
      } else {
        reasons.push({ code: "DEPOSIT_AUTH", severity: "caution", detail: "The destination has Deposit Authorization on: only preauthorized senders can pay it. Pass `from` to check yours." });
      }
    }
    if (currency === "RLUSD") {
      const lines = await rpc("account_lines", { account: destination, peer: RLUSD_ISSUER });
      const has = ((lines?.lines as { currency?: string }[] | undefined) ?? []).some((l) => String(l.currency).toUpperCase() === RLUSD_HEX);
      if (lines && !has) reasons.push({ code: "NO_RLUSD_TRUSTLINE", severity: "block", detail: "The destination has no RLUSD trust line, so it can't receive RLUSD — the payment will fail." });
    }
    if (account.blackholed) reasons.push({ code: "BLACKHOLED", severity: "caution", detail: "The destination is blackholed (master key disabled, no regular key, no signer list): funds sent there can never move again." });
    if (account.disallowXrp && (currency ?? "XRP") === "XRP") reasons.push({ code: "DISALLOW_XRP", severity: "caution", detail: "The destination has asked not to receive XRP (DisallowXRP). The ledger doesn't enforce it, but the owner may not expect it." });
  }

  // ── score ──
  let xrplScore: { score: number; grade: string; percentile: number } | null = null;
  if (scoreR.ok) {
    const v: ScoreResult = scoreR.v;
    xrplScore = { score: v.score, grade: v.grade, percentile: v.percentile };
    if (v.details.accountAgeDays < NEW_ACCOUNT_DAYS) reasons.push({ code: "NEW_ACCOUNT", severity: "caution", detail: `The account is ${v.details.accountAgeDays} day(s) old (under ${NEW_ACCOUNT_DAYS}).` });
    if (v.score < LOW_SCORE) reasons.push({ code: "LOW_SCORE", severity: "caution", detail: `XRPLScore ${v.score} (${v.grade}) is below ${LOW_SCORE}.` });
  } else if (!(scoreR.e instanceof AccountNotFoundError)) {
    reasons.push({ code: "SCORE_UNAVAILABLE", severity: "caution", detail: "The XRPLScore could not be computed right now." });
  }

  // ── sanctions ──
  let sanctions: Record<string, unknown>;
  if (screenR.ok) {
    const o: ScreenOutcome = screenR.v;
    const result = o.leaf.result as { listed: boolean; matches?: unknown[] };
    sanctions = {
      listed: result.listed,
      ...(result.listed ? { matches: result.matches } : {}),
      lists: o.listsUsed.map((l) => ({ name: l.name, vintage: l.vintage, sha256: l.sha256, xrplAddressesOnList: l.chainAddressCount })),
      queryId: o.queryId,
      verify: `/api/attest/verify?queryId=${o.queryId}`,
    };
    if (result.listed) reasons.push({ code: "SANCTIONS_MATCH", severity: "block", detail: "A sanctions list we hold names this exact address. Do not pay it." });
  } else {
    const msg = screenR.e instanceof ListUnavailableError ? screenR.e.message : "the screen could not run";
    sanctions = { listed: null, unavailable: true, detail: msg };
    reasons.push({ code: "SANCTIONS_UNAVAILABLE", severity: "caution", detail: `The sanctions screen could not be completed (${msg}).` });
  }

  const verdict: Verdict = reasons.some((r) => r.severity === "block") ? "block" : reasons.length ? "caution" : "proceed";
  return {
    version: PRECHECK_VERSION,
    destination,
    checkedAt: new Date().toISOString(),
    ledgerIndex: vl?.seq ?? null,
    verdict,
    wouldFail: reasons.some((r) => r.severity === "block" && r.code !== "SANCTIONS_MATCH"),
    reasons,
    xrplScore,
    sanctions,
    account,
    payment: { amount: input.amount ?? null, currency, destinationTag: input.destinationTag ?? null, from: input.from ?? null },
    rules: PRECHECK_RULES,
    disclaimer: PRECHECK_DISCLAIMER,
  };
}
