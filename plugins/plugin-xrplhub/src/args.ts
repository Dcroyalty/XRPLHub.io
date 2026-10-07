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
