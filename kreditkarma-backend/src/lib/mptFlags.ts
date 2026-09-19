// src/lib/mptFlags.ts
// The MPTokenIssuanceCreate flag guide — one source of truth for the builder,
// the free preview, the confirmation manifest, and the frontend form.
//
// PERMANENCE IS REGIME-DEPENDENT. XLS-33 sets these six capability flags at
// creation. XLS-94 (DynamicMPT) — voted on by validators, NOT necessarily
// active — makes every capability flag ENABLE-ONLY after issuance: an OFF flag
// can later be switched ON by the issuer unless an ImmutableFlags lock was set,
// and an ON flag can never be switched off. So:
//   - a flag that is ON is permanent in every regime;
//   - a flag that is OFF is permanent only while DynamicMPT is inactive (or
//     once the issuer locks it with ImmutableFlags, which needs DynamicMPT).
// Nothing here may say "can never be changed" about an OFF flag without a regime.
// The regime is read from the live Amendments object (see amendments.ts) — never
// a constant. lsfMPTLocked is a runtime lock, not a creation flag.
//
// We scored 34 issuers on these flags and found nobody explains what they let
// the issuer do TO a holder. This module says it plainly.

/** Which permanence regime a statement applies to. "unknown" = amendment state
 *  couldn't be read; it must render the hedged wording, never "permanent". */
export type MptRegime = "pre-activation" | "post-activation" | "unknown";

export const MPT_FLAG_BITS = {
  canLock: 0x0002, // tfMPTCanLock
  requireAuth: 0x0004, // tfMPTRequireAuth
  canEscrow: 0x0008, // tfMPTCanEscrow
  canTrade: 0x0010, // tfMPTCanTrade
  canTransfer: 0x0020, // tfMPTCanTransfer
  canClawback: 0x0040, // tfMPTCanClawback
} as const;

/** lsfMPTCanHoldConfidentialBalance (XLS-96 ConfidentialTransfer). One-way: once
 *  set it can never be cleared. Not a flag our builder sets. */
export const MPT_LSF_CAN_HOLD_CONFIDENTIAL = 0x0080;

export type MptFlagKey = keyof typeof MPT_FLAG_BITS;

export interface MptFlagInfo {
  key: MptFlagKey;
  bit: number;
  txFlag: string; // tfMPT...
  category: "issuer-power-over-holders" | "holder-capability";
  label: string;
  /** The blunt one-liner. */
  plain: string;
  /** What switching this on LATER would mean (only reachable under DynamicMPT). */
  ifEnabledLater: string;
}

export const MPT_FLAGS: MptFlagInfo[] = [
  {
    key: "canClawback",
    bit: MPT_FLAG_BITS.canClawback,
    txFlag: "tfMPTCanClawback",
    category: "issuer-power-over-holders",
    label: "Clawback",
    plain:
      "You can take this token back from any holder, at any time, without their consent, using a Clawback transaction.",
    ifEnabledLater: "Switching it on later would let the issuer claw back balances holders already hold.",
  },
  {
    key: "canLock",
    bit: MPT_FLAG_BITS.canLock,
    txFlag: "tfMPTCanLock",
    category: "issuer-power-over-holders",
    label: "Lock / freeze balances",
    plain:
      "You can freeze one holder's balance, or every holder's balance at once. A frozen holder cannot send or receive the token.",
    ifEnabledLater: "Switching it on later would let the issuer freeze balances holders already hold.",
  },
  {
    key: "requireAuth",
    bit: MPT_FLAG_BITS.requireAuth,
    txFlag: "tfMPTRequireAuth",
    category: "issuer-power-over-holders",
    label: "Require issuer authorization",
    plain:
      "Nobody can hold this token until you individually approve their account. You control the entire holder list.",
    ifEnabledLater: "Switching it on later would let the issuer start requiring its approval to hold the token.",
  },
  {
    key: "canTransfer",
    bit: MPT_FLAG_BITS.canTransfer,
    txFlag: "tfMPTCanTransfer",
    category: "holder-capability",
    label: "Holders can transfer",
    plain:
      "Holders can send the token to each other. WITHOUT this, a holder can only ever send it back to you (closed-loop / store credit).",
    ifEnabledLater: "Switching it on later would open a closed-loop token to holder-to-holder transfers.",
  },
  {
    key: "canTrade",
    bit: MPT_FLAG_BITS.canTrade,
    txFlag: "tfMPTCanTrade",
    category: "holder-capability",
    label: "Holders can trade on the DEX/AMM",
    plain: "Holders can place this token on the XRP Ledger DEX and in AMM pools.",
    ifEnabledLater: "Switching it on later would let holders list the token on the DEX and in AMM pools.",
  },
  {
    key: "canEscrow",
    bit: MPT_FLAG_BITS.canEscrow,
    txFlag: "tfMPTCanEscrow",
    category: "holder-capability",
    label: "Holders can escrow",
    plain: "Holders can lock their own balance into an on-ledger escrow.",
    ifEnabledLater: "Switching it on later would let holders escrow their balance.",
  },
];

const byKey = new Map(MPT_FLAGS.map((f) => [f.key, f]));

/** The ImmutableFlags transaction bit that locks this flag (tif…), e.g. tifMPTCanClawback. */
export const lockFlagName = (f: MptFlagInfo): string => f.txFlag.replace(/^tf/, "tif");

/** Permanence of a flag that is ON — identical in every regime (enable-only). */
export const FLAG_ON_PERMANENCE =
  "Switched on at issuance, it stays on for the life of the token: no transaction can ever turn a capability flag off, with or without DynamicMPT.";

/** What it means for a flag that is OFF, in the given regime. */
export function flagOffPermanence(f: MptFlagInfo, regime: MptRegime): string {
  switch (regime) {
    case "pre-activation":
      return (
        "Off, and it cannot be switched on today. If the pending DynamicMPT amendment activates, the issuer account " +
        `could switch it on later (never off) unless an ImmutableFlags lock is set. ${f.ifEnabledLater}`
      );
    case "post-activation":
      return (
        "Off — but DynamicMPT is active, so the issuer account can still switch it ON at any time unless you lock " +
        `it now with ImmutableFlags (${lockFlagName(f)}). ${f.ifEnabledLater}`
      );
    default:
      return (
        "Off. Whether it can be switched on later depends on DynamicMPT, whose live state could not be read — " +
        `assume the issuer account can switch it on. ${f.ifEnabledLater}`
      );
  }
}

/** Both halves of a flag's permanence, for the guide. */
export function flagPermanence(f: MptFlagInfo, regime: MptRegime): { ifOn: string; ifOff: string } {
  return { ifOn: FLAG_ON_PERMANENCE, ifOff: flagOffPermanence(f, regime) };
}

/** Build the Flags integer for an MPTokenIssuanceCreate from a selection map. */
export function buildMptFlagsValue(sel: Partial<Record<MptFlagKey, boolean>>): number {
  let v = 0;
  for (const f of MPT_FLAGS) if (sel[f.key]) v |= f.bit;
  return v;
}

export interface FlagExplanation {
  set: MptFlagInfo[];
  unset: MptFlagInfo[];
  issuerPowersGranted: string[];
  issuerPowersNotGranted: string[];
}

/** Decode a Flags integer into the human explanation used everywhere. */
export function explainMptFlags(flagsRaw: number, regime: MptRegime): FlagExplanation {
  const set = MPT_FLAGS.filter((f) => (flagsRaw & f.bit) !== 0);
  const unset = MPT_FLAGS.filter((f) => (flagsRaw & f.bit) === 0);
  const powers = MPT_FLAGS.filter((f) => f.category === "issuer-power-over-holders");
  return {
    set,
    unset,
    issuerPowersGranted: powers.filter((f) => (flagsRaw & f.bit) !== 0).map((f) => f.plain),
    issuerPowersNotGranted: powers
      .filter((f) => (flagsRaw & f.bit) === 0)
      .map((f) => `NOT granted at issuance: ${f.label} — ${flagOffPermanence(f, regime)}`),
  };
}

/** Parse the string form values ("on"/"true"/true) into a selection map. */
export function flagSelectionFromParams(p: Record<string, unknown>): Record<MptFlagKey, boolean> {
  const on = (v: unknown) => v === true || v === "true" || v === "on" || v === "yes" || v === 1 || v === "1";
  return {
    canLock: on(p.canLock),
    requireAuth: on(p.requireAuth),
    canEscrow: on(p.canEscrow),
    canTrade: on(p.canTrade),
    canTransfer: on(p.canTransfer),
    canClawback: on(p.canClawback),
  };
}

export { byKey as MPT_FLAG_BY_KEY };
