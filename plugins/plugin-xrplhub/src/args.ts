// Turning an ElizaOS message + handler options into validated arguments.
//
// Two rules that matter more than convenience:
//  1. An explicitly supplied argument that is invalid is REFUSED. We never quietly fall back to some other address that
//     happens to be in the chat text — that is how the wrong wallet gets screened or a transaction gets built for the
//     wrong account.
//  2. Ambiguity is refused, not guessed. Two different valid addresses in one message, or one valid plus one that fails
//     its checksum, means we ask which one.

import type { HandlerOptions, Memory } from "@elizaos/core";
import { isMptIssuanceId, isValidXrplAddress, scanAddresses, scanMptIds } from "./address.ts";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function messageText(message: Memory | undefined): string {
  const t = message?.content?.text;
  return typeof t === "string" ? t : "";
}

/** Structured action parameters, when the runtime supplies them (`options.parameters`). */
export function structuredParams(options: HandlerOptions | undefined): Record<string, unknown> {
  const p = options?.parameters;
  return isRecord(p) ? p : {};
}

function pickString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

export const WALLET_KEYS = ["wallet_address", "walletAddress", "account", "address", "wallet"];

export function resolveAddress(text: string, params: Record<string, unknown>, keys: string[] = WALLET_KEYS): Resolved<string> {
  const explicit = pickString(params, keys);
  if (explicit !== undefined) {
    if (isValidXrplAddress(explicit)) return { ok: true, value: explicit };
    return {
      ok: false,
      message: `"${explicit.slice(0, 40)}" is not a valid XRPL address (the checksum does not verify, so it is probably mistyped). Nothing was looked up. Send the correct r-address.`,
    };
  }
  const scan = scanAddresses(text);
  if (scan.malformed.length > 0) {
    return {
      ok: false,
      message: `"${scan.malformed[0]!.slice(0, 40)}" looks like an XRPL address but its checksum does not verify, so it is probably mistyped. Nothing was looked up. Send the correct r-address.`,
    };
  }
  if (scan.valid.length === 1) return { ok: true, value: scan.valid[0]! };
  if (scan.valid.length > 1) {
    return { ok: false, message: `That message contains ${scan.valid.length} different XRPL addresses (${scan.valid.slice(0, 3).join(", ")}${scan.valid.length > 3 ? ", …" : ""}). Which one should I use? Nothing was looked up.` };
  }
  return { ok: false, message: "I need an XRPL wallet address (starts with r, 25–35 characters). None was found." };
}

export function resolveMptId(text: string, params: Record<string, unknown>): Resolved<string> {
  const explicit = pickString(params, ["issuance_id", "issuanceId", "mptIssuanceId", "id"]);
  if (explicit !== undefined) {
    if (isMptIssuanceId(explicit)) return { ok: true, value: explicit.toUpperCase() };
    return { ok: false, message: `"${explicit.slice(0, 60)}" is not an MPTokenIssuanceID (it must be exactly 48 hexadecimal characters). Nothing was looked up.` };
  }
  const ids = scanMptIds(text);
  if (ids.length === 1) return { ok: true, value: ids[0]! };
  if (ids.length > 1) return { ok: false, message: `That message contains ${ids.length} different MPT issuance ids. Which one should I look up?` };
  return { ok: false, message: "I need an MPTokenIssuanceID: exactly 48 hexadecimal characters. None was found." };
}

/** The first balanced {...} JSON object in free text, or undefined. Scans by hand so braces inside strings are handled. */
export function firstJsonObject(text: string): Record<string, unknown> | undefined {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const v: unknown = JSON.parse(text.slice(start, i + 1));
            if (isRecord(v)) return v;
          } catch {
            /* not JSON: try the next "{" */
          }
          break;
        }
      }
    }
  }
  return undefined;
}

const PRODUCT_KEYS = ["product_id", "productId", "service", "service_id", "serviceId"];
const CONFIRM_KEYS = ["confirm_caution", "confirmCaution"];
const RESERVED_KEYS = new Set([...PRODUCT_KEYS, ...WALLET_KEYS, ...CONFIRM_KEYS, "params", "parameters"]);
const MAX_PARAMS = 30;
const MAX_PARAM_CHARS = 2_000;

function primitives(src: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(src)) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (typeof v === "string") out[k] = v.slice(0, MAX_PARAM_CHARS);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export interface BuildArgs {
  productId?: string;
  params: Record<string, string | number | boolean>;
  /** The caller says the wallet owner has read the irreversibility copy. Only ever an explicit true. */
  confirmCaution: boolean;
}

const isTrue = (v: unknown) => v === true || v === "true";

/** product_id + the service's own params, from structured parameters first, then a JSON object in the message text. */
export function readBuildArgs(text: string, sp: Record<string, unknown>): BuildArgs {
  const fromText = firstJsonObject(text) ?? {};
  const productId = pickString(sp, PRODUCT_KEYS) ?? pickString(fromText, PRODUCT_KEYS);
  const confirmCaution = CONFIRM_KEYS.some((k) => isTrue(sp[k]) || isTrue(fromText[k]));

  let nested: Record<string, unknown> | undefined;
  for (const src of [sp, fromText]) {
    const p = src.params;
    if (isRecord(p)) {
      nested = p;
      break;
    }
    if (typeof p === "string") {
      try {
        const parsed: unknown = JSON.parse(p);
        if (isRecord(parsed)) {
          nested = parsed;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (nested) return { productId, params: primitives(nested), confirmCaution };

  // No explicit `params` object: treat leftover keys as the service's params (lenient for models that flatten them).
  const loose: Record<string, unknown> = {};
  for (const src of [fromText, sp]) {
    for (const [k, v] of Object.entries(src)) if (!RESERVED_KEYS.has(k)) loose[k] = v;
  }
  return { productId, params: primitives(loose), confirmCaution };
}
