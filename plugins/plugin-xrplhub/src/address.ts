// XRPL address + MPT id helpers. Pure, no network.
//
// Why a checksum check and not just a regex: an agent that copies an address out of chat text and screens or scores
// the WRONG wallet because of a single mistyped character produces a confident, wrong answer. The XRPL base58 alphabet
// carries a 4-byte double-SHA256 checksum, so a mistyped address is detectable offline and we refuse it before any call.

import { createHash } from "node:crypto";

const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
// r + 24..34 base58 chars (25..35 total), the shape of a classic XRPL address.
const CANDIDATE = /r[1-9A-HJ-NP-Za-km-z]{24,34}/g;

export function isValidXrplAddress(value: string): boolean {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  let n = 0n;
  for (const ch of value) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return false;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const body = Buffer.from(hex, "hex");
  // A classic address decodes to 25 bytes: 0x00 version + 20-byte account id + 4-byte checksum.
  if (body.length > 25) return false;
  const bytes = Buffer.concat([Buffer.alloc(25 - body.length), body]);
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < bytes.length && bytes[leadingZeroBytes] === 0) leadingZeroBytes++;
  let leadingR = 0;
  while (leadingR < value.length && value[leadingR] === ALPHABET[0]) leadingR++;
  if (bytes[0] !== 0 || leadingZeroBytes !== leadingR) return false;
  const payload = bytes.subarray(0, 21);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  return checksum.equals(bytes.subarray(21));
}

export interface AddressScan {
  /** Distinct addresses whose checksum verifies, in order of first appearance. */
  valid: string[];
  /** Address-shaped strings whose checksum FAILS (probably mistyped). */
  malformed: string[];
}

/** Find XRPL addresses in free text. Address-shaped strings inside longer alphanumeric runs (hashes, ids) are ignored. */
export function scanAddresses(text: string): AddressScan {
  const valid: string[] = [];
  const malformed: string[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const at = m.index ?? 0;
    const before = at > 0 ? text.charAt(at - 1) : "";
    const after = text.charAt(at + m[0].length);
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue; // part of a longer token
    const candidate = m[0];
    if (isValidXrplAddress(candidate)) {
      if (!valid.includes(candidate)) valid.push(candidate);
    } else if (!malformed.includes(candidate)) {
      malformed.push(candidate);
    }
  }
  return { valid, malformed };
}

const MPT_ID = /^[0-9A-Fa-f]{48}$/;

export function isMptIssuanceId(value: string): boolean {
  return MPT_ID.test(value);
}

/** Find 48-hex MPTokenIssuanceIDs in free text (standalone tokens only), upper-cased and de-duplicated. */
export function scanMptIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[0-9A-Fa-f]{48}/g)) {
    const at = m.index ?? 0;
    const before = at > 0 ? text.charAt(at - 1) : "";
    const after = text.charAt(at + 48);
    if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;
    const id = m[0].toUpperCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
