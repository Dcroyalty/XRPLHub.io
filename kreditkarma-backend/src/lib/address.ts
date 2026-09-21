// src/lib/address.ts
// ONE address validator for every endpoint that screens, scores, attests or builds for a wallet.
//
// XRPL classic addresses are base58check: the last 4 bytes are a checksum. A regex on the character set
// (what this codebase used to do) accepts a mistyped address — and a screening receipt for a mistyped
// sanctioned address said "not listed". An address that fails the checksum is not an address: reject it
// before any lookup, receipt or attestation is produced.

import { createHash } from "crypto";

// The XRPL base58 alphabet (NOT Bitcoin's) — 'r' is the zero digit, which is why classic addresses start with r.
const ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const INDEX: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** Decode an XRPL base58 string to bytes (leading 'r' digits become leading zero bytes). null on a bad character. No BigInt: the project targets an ES level without BigInt literals. */
function base58Decode(s: string): Buffer | null {
  const digits: number[] = []; // base-256, least significant first
  for (const ch of s) {
    let carry = INDEX[ch];
    if (carry === undefined) return null;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === ALPHABET[0]; k++) digits.push(0);
  return Buffer.from(digits.reverse());
}

/**
 * True only for a well-formed XRPL classic address: r-prefixed, base58 in the XRPL alphabet, 25 bytes,
 * account-ID version byte 0x00, and a correct double-SHA-256 checksum. X-addresses (tagged) and anything else are rejected.
 */
export function isValidXrplAddress(addr: unknown): boolean {
  if (typeof addr !== "string" || addr.length < 25 || addr.length > 35 || addr[0] !== "r") return false;
  const bytes = base58Decode(addr);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x00) return false;
  const expected = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
  return expected.equals(bytes.subarray(21));
}

/** The message every endpoint returns for a rejected address (one wording, so clients can rely on it). */
export const INVALID_ADDRESS_MESSAGE =
  "Not a valid XRPL classic address (an r-address whose checksum verifies). Check for a typo — nothing was looked up, screened or recorded.";
