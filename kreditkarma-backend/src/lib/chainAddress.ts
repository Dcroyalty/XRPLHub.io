// src/lib/chainAddress.ts
// Multi-chain address recognition for SANCTIONS SCREENING.
//
// Why this exists: the sanctions lists we screen against (OFAC SDN, UK Sanctions List, EU Consolidated list) name crypto
// addresses on several chains — Bitcoin, Ethereum/BSC (EVM), Tron — and almost none on the XRP Ledger. To compare a query
// address to a list we must (a) know which chain it belongs to, (b) refuse a mistyped one (every family here carries a
// checksum, so a typo is detectable offline), and (c) reduce it to ONE canonical comparison string.
//
// SUPPORTED FAMILIES (nothing else is screened; an unsupported format is REFUSED, never answered "not listed"):
//   xrpl  — classic r-address, base58check (XRPL alphabet), version 0x00      -> compared verbatim
//   evm   — 0x + 40 hex (Ethereum, BNB Smart Chain, Arbitrum, Base, …)          -> EIP-55 verified if mixed-case; compared lower-cased
//   btc   — legacy P2PKH/P2SH base58check (versions 0x00/0x05) and bech32/bech32m (bc1…) -> compared verbatim (bech32 lower-cased)
//   tron  — base58check, version 0x41, starts with T                           -> compared verbatim
//
// No BigInt literals (the project targets ES2017).

import { createHash } from "crypto";
import { isAddress } from "viem";
import { isValidXrplAddress } from "./address";

export type Chain = "xrpl" | "evm" | "btc" | "tron";
export const SUPPORTED_CHAINS: readonly Chain[] = ["xrpl", "evm", "btc", "tron"];

export const CHAIN_LABEL: Record<Chain, string> = {
  xrpl: "XRP Ledger",
  evm: "EVM (Ethereum, BNB Smart Chain, Arbitrum, Base, …)",
  btc: "Bitcoin",
  tron: "Tron",
};

const BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BTC_INDEX: Record<string, number> = Object.fromEntries([...BTC_ALPHABET].map((c, i) => [c, i]));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** Bitcoin-alphabet base58 decode (leading '1' digits become leading zero bytes). null on a bad character. */
function base58DecodeBtc(s: string): Buffer | null {
  const digits: number[] = [];
  for (const ch of s) {
    let carry = BTC_INDEX[ch];
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
  for (let k = 0; k < s.length && s[k] === "1"; k++) digits.push(0);
  return Buffer.from(digits.reverse());
}

/** Decode base58check (Bitcoin alphabet) and return the payload (version byte + data) if the checksum verifies. */
function base58CheckBtc(s: string): Buffer | null {
  if (s.length < 25 || s.length > 36) return null;
  const bytes = base58DecodeBtc(s);
  if (!bytes || bytes.length < 5) return null;
  const payload = bytes.subarray(0, bytes.length - 4);
  const check = sha256(sha256(payload)).subarray(0, 4);
  return check.equals(bytes.subarray(bytes.length - 4)) ? payload : null;
}

// ── bech32 / bech32m (BIP-173 / BIP-350) ─────────────────────────────────────
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function bech32Decode(str: string): { hrp: string; data: number[]; spec: "bech32" | "bech32m" } | null {
  if (str.length < 8 || str.length > 90) return null;
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null; // mixed case is invalid
  const s = str.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (const ch of s.slice(pos + 1)) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const hrpExp: number[] = [];
  for (const ch of hrp) hrpExp.push(ch.charCodeAt(0) >> 5);
  hrpExp.push(0);
  for (const ch of hrp) hrpExp.push(ch.charCodeAt(0) & 31);
  const pm = polymod([...hrpExp, ...data]);
  const spec = pm === 1 ? "bech32" : pm === 0x2bc830a3 ? "bech32m" : null;
  return spec ? { hrp, data: data.slice(0, -6), spec } : null;
}

function isValidBtcBech32(addr: string): boolean {
  const d = bech32Decode(addr);
  if (!d || d.hrp !== "bc" || d.data.length < 1) return false;
  const version = d.data[0];
  if (version > 16) return false;
  if ((version === 0) !== (d.spec === "bech32")) return false; // v0 => bech32, v1+ => bech32m
  // convert 5-bit groups -> 8-bit program, strictly
  let acc = 0, bits = 0;
  const program: number[] = [];
  for (const v of d.data.slice(1)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return false; // non-zero padding
  if (program.length < 2 || program.length > 40) return false;
  if (version === 0 && program.length !== 20 && program.length !== 32) return false;
  if (version === 1 && program.length !== 32) return false;
  return true;
}

export interface RecognisedAddress {
  chain: Chain;
  /** The verbatim address (whitespace trimmed) — what a receipt records as the subject. */
  address: string;
  /** The one canonical comparison string (EVM/bech32 lower-cased; others verbatim). */
  normalized: string;
}

export function isValidEvmAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a) && isAddress(a); // viem verifies EIP-55 only when the address is mixed-case
}
export function isValidTronAddress(a: string): boolean {
  if (a.length !== 34 || a[0] !== "T") return false;
  const p = base58CheckBtc(a);
  return !!p && p.length === 21 && p[0] === 0x41;
}
export function isValidBtcAddress(a: string): boolean {
  if (/^(bc1|BC1)/.test(a)) return isValidBtcBech32(a);
  if (a[0] !== "1" && a[0] !== "3") return false;
  const p = base58CheckBtc(a);
  return !!p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05);
}

/** Recognise an address on one of the supported chains, or null. Trims surrounding whitespace only. */
export function recogniseAddress(raw: unknown): RecognisedAddress | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim();
  if (!a || a.length > 100) return null;
  if (a[0] === "r" && isValidXrplAddress(a)) return { chain: "xrpl", address: a, normalized: a };
  if (a.startsWith("0x") || a.startsWith("0X")) {
    return isValidEvmAddress("0x" + a.slice(2)) ? { chain: "evm", address: a, normalized: a.toLowerCase() } : null;
  }
  if (a[0] === "T" && isValidTronAddress(a)) return { chain: "tron", address: a, normalized: a };
  if (isValidBtcAddress(a)) return { chain: "btc", address: a, normalized: /^bc1/i.test(a) ? a.toLowerCase() : a };
  return null;
}

/** Human message for a query that is not on a supported chain (or has a typo). One wording for every endpoint. */
export const UNSUPPORTED_ADDRESS_MESSAGE =
  "Not a valid address on a supported chain (XRP Ledger r-address, EVM 0x address, Bitcoin, or Tron), or its checksum does not verify (probably a typo). " +
  "Nothing was screened or recorded. An address on an unsupported chain is refused rather than reported as \"not listed\".";

// ── Extracting addresses from the free text of a sanctions list ───────────────
export interface ExtractedFromText {
  chain: Chain;
  address: string; // verbatim, after re-joining a fragment that was split by whitespace
  normalized: string;
  /** The currency label written next to it in the source text (ETH, XBT, USDT, TRX…), or null. Informational only. */
  labelInSource: string | null;
  /** true when the address only validated after joining two or three whitespace-separated fragments. */
  rejoined: boolean;
}

const LABEL = /^[A-Za-z]{2,6}:?$/;
const SPLIT = /[\s,;()[\]{}<>|]+/;

/**
 * Find every address in a piece of free text. Each candidate must pass its chain's CHECKSUM, so a random token never
 * matches (false-positive odds ~2^-32 per token) and a mistyped address in the source is reported as unparsed by the
 * caller, not guessed at. A source that splits one address across a space ("TNZx…DXV5 97Yf…nV") is repaired by trying
 * adjacent fragments joined; the repair is accepted only if the joined string verifies.
 */
export function extractAddresses(text: string): ExtractedFromText[] {
  // Cheap exit: every supported address (or the longest fragment of a split one) contains a run of 20+ alphanumerics.
  if (!/[A-Za-z0-9]{20,}/.test(text)) return [];
  const tokens = text.split(SPLIT).filter(Boolean);
  const out: ExtractedFromText[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    // trim trailing punctuation the list author may have attached ("…nV;", "…nV.")
    const clean = (t: string) => t.replace(/^[:"'`]+|[.:"'`]+$/g, "");
    let hit: { rec: RecognisedAddress; used: number } | null = null;
    for (let span = 1; span <= 3 && i + span <= tokens.length; span++) {
      const joined = clean(tokens.slice(i, i + span).join(""));
      if (joined.length < 26 || joined.length > 64) continue;
      const rec = recogniseAddress(joined);
      if (rec) {
        hit = { rec, used: span };
        break;
      }
    }
    if (hit) {
      let label: string | null = null;
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        if (LABEL.test(tokens[k]) && !/^(address|addresses|wallet|wallets|known|crypto|following|and|the|of|in|by|to|as|for|on)$/i.test(tokens[k].replace(/:$/, ""))) {
          label = tokens[k].replace(/:$/, "").toUpperCase();
          break;
        }
      }
      const key = hit.rec.chain + ":" + hit.rec.normalized;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ chain: hit.rec.chain, address: hit.rec.address, normalized: hit.rec.normalized, labelInSource: label, rejoined: hit.used > 1 });
      }
      i += hit.used;
    } else {
      i += 1;
    }
  }
  return out;
}
