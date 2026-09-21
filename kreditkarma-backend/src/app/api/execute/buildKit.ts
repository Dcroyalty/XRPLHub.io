// src/app/api/execute/buildKit.ts
// Shared types and helpers for the service builders (txBuilder.ts, serviceBuilders.ts).

import type { BuildContext } from '@/lib/mptPermanence';
import { isValidXrplAddress } from "@/lib/address";

export type SafetyTier = 'safe' | 'caution' | 'blocked';

/** One transaction the customer signs. A service is one or more steps, signed in order. */
export interface BuildStep {
  /** stable id — the plan is fixed at step 1 and later steps are built BY ID */
  id: string;
  label: string;
  txjson: Record<string, unknown>;
}

export interface BuildResult {
  ok: boolean;
  /** the FIRST step's txjson (single-step services: the only one) */
  txjson?: Record<string, unknown>;
  /** every step, in signing order. Always set on success by buildServiceTx. */
  steps?: BuildStep[];
  tier?: SafetyTier;
  label?: string;
  error?: string;
  needsParams?: string[]; // params we required but didn't get
}

export interface Params { [k: string]: string | number | boolean | undefined }

export type Builder = (account: string, p: Params, ctx?: BuildContext) => BuildResult | Promise<BuildResult>;

export const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();
export const isAddr = (v: string) => isValidXrplAddress(v);
export const xrpToDrops = (xrp: number) => String(Math.round(xrp * 1_000_000));
export const truthy = (v: unknown) => v === true || v === 'true' || v === 'on' || v === 'yes' || v === 1 || v === '1';

export const SAFE = (txjson: Record<string, unknown>, label: string): BuildResult => ({ ok: true, txjson, tier: 'safe', label });
export const CAUTION = (txjson: Record<string, unknown>, label: string): BuildResult => ({ ok: true, txjson, tier: 'caution', label });
export const NEED = (needsParams: string[]): BuildResult => ({ ok: false, error: 'missing required parameters', needsParams });
export const BAD = (error: string): BuildResult => ({ ok: false, error });
export const BLOCKED = (error: string): BuildResult => ({ ok: false, tier: 'blocked', error });
export const SAFE_STEPS = (steps: BuildStep[], label: string): BuildResult => ({ ok: true, steps, txjson: steps[0].txjson, tier: 'safe', label });
export const CAUTION_STEPS = (steps: BuildStep[], label: string): BuildResult => ({ ok: true, steps, txjson: steps[0].txjson, tier: 'caution', label });

// ── XRPL value helpers ───────────────────────────────────────────────────────

const HEX40 = /^[0-9A-Fa-f]{40}$/;

/**
 * An XRPL currency code as the ledger wants it: "XRP", a 3-character code as-is, or a
 * 40-hex code. Anything else printable (1-20 chars, e.g. "RLUSD", which is 5) is
 * hex-encoded and zero-padded to 40 — passing "RLUSD" raw is rejected by the ledger.
 * Returns null if it can't be a currency code.
 */
export function currencyCode(raw: string): string | null {
  const c = raw.trim();
  if (!c) return null;
  if (c.toUpperCase() === 'XRP') return 'XRP';
  if (HEX40.test(c)) return c.toUpperCase();
  if (/^[A-Za-z0-9]{3}$/.test(c)) return c;
  if (/^[\x21-\x7E]{4,20}$/.test(c)) return Buffer.from(c, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
  return null;
}

/** Positive decimal string ("12", "0.5") — no exponents, no signs. */
export const positiveDecimal = (v: string) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;

export interface AssetSpec { currency: string; issuer?: string }

/** Build a currency spec from form fields; null + reason if invalid. */
export function assetFrom(currencyRaw: string, issuerRaw: string): { ok: true; asset: AssetSpec } | { ok: false; error: string } {
  const cur = currencyCode(currencyRaw || 'XRP');
  if (!cur) return { ok: false, error: `"${currencyRaw}" is not a valid XRPL currency code (3 characters, or up to 20 that we hex-encode for you)` };
  if (cur === 'XRP') return { ok: true, asset: { currency: 'XRP' } };
  const issuer = issuerRaw.trim();
  if (!isAddr(issuer)) return { ok: false, error: `an issuer address is required for ${currencyRaw}` };
  return { ok: true, asset: { currency: cur, issuer } };
}

/** An amount of an asset: XRP -> drops string, issued -> {currency, issuer, value}. */
export function amountOf(asset: AssetSpec, value: string): string | { currency: string; issuer: string; value: string } {
  return asset.currency === 'XRP' ? xrpToDrops(Number(value)) : { currency: asset.currency, issuer: asset.issuer as string, value };
}

/** A lowercase ASCII hostname (what the XRPL Domain field is meant to hold). */
export function isDomain(d: string): boolean {
  return d.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d);
}
export const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
