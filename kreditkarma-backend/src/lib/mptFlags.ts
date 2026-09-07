// src/lib/mptFlags.ts
// The MPTokenIssuanceCreate flag guide — one source of truth for the builder,
// the free preview, the confirmation manifest, and the frontend form.
//
// ALL of these flags are set once, at creation, and can NEVER be changed
// (XLS-33 §2.1.1.2.2; DynamicMPT is not enabled on mainnet). lsfMPTLocked is the
// only mutable one and it is not a creation flag.
//
// We scored 34 issuers on these flags and found nobody explains what they let
// the issuer do TO a holder. This module says it plainly.

export const MPT_FLAG_BITS = {
  canLock: 0x0002, // tfMPTCanLock
  requireAuth: 0x0004, // tfMPTRequireAuth
  canEscrow: 0x0008, // tfMPTCanEscrow
  canTrade: 0x0010, // tfMPTCanTrade
  canTransfer: 0x0020, // tfMPTCanTransfer
  canClawback: 0x0040, // tfMPTCanClawback
} as const;

export type MptFlagKey = keyof typeof MPT_FLAG_BITS;

export interface MptFlagInfo {
  key: MptFlagKey;
  bit: number;
  txFlag: string; // tfMPT...
  category: "issuer-power-over-holders" | "holder-capability";
  label: string;
  /** The blunt one-liner. */
  plain: string;
  /** What it means that this is permanent. */
  permanence: string;
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
    permanence:
      "If you do not set this now you can NEVER add it. If you do set it, holders can never remove your ability to claw back.",
  },
  {
    key: "canLock",
    bit: MPT_FLAG_BITS.canLock,
    txFlag: "tfMPTCanLock",
    category: "issuer-power-over-holders",
    label: "Lock / freeze balances",
    plain:
      "You can freeze one holder's balance, or every holder's balance at once. A frozen holder cannot send or receive the token.",
    permanence: "Set once. You can never grant yourself this power later, and never give it up.",
  },
  {
    key: "requireAuth",
    bit: MPT_FLAG_BITS.requireAuth,
    txFlag: "tfMPTRequireAuth",
    category: "issuer-power-over-holders",
    label: "Require issuer authorization",
    plain:
      "Nobody can hold this token until you individually approve their account. You control the entire holder list.",
    permanence: "Set once. Cannot be added or removed after creation.",
  },
  {
    key: "canTransfer",
    bit: MPT_FLAG_BITS.canTransfer,
    txFlag: "tfMPTCanTransfer",
    category: "holder-capability",
    label: "Holders can transfer",
    plain:
      "Holders can send the token to each other. WITHOUT this, a holder can only ever send it back to you (closed-loop / store credit).",
    permanence: "Set once. A closed-loop token can never be opened up later, and an open one can never be closed.",
  },
  {
    key: "canTrade",
    bit: MPT_FLAG_BITS.canTrade,
    txFlag: "tfMPTCanTrade",
    category: "holder-capability",
    label: "Holders can trade on the DEX/AMM",
    plain: "Holders can place this token on the XRP Ledger DEX and in AMM pools.",
    permanence: "Set once. Cannot be added or removed after creation.",
  },
  {
    key: "canEscrow",
    bit: MPT_FLAG_BITS.canEscrow,
    txFlag: "tfMPTCanEscrow",
    category: "holder-capability",
    label: "Holders can escrow",
    plain: "Holders can lock their own balance into an on-ledger escrow.",
    permanence: "Set once. Cannot be added or removed after creation.",
  },
];

const byKey = new Map(MPT_FLAGS.map((f) => [f.key, f]));

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
export function explainMptFlags(flagsRaw: number): FlagExplanation {
  const set = MPT_FLAGS.filter((f) => (flagsRaw & f.bit) !== 0);
  const unset = MPT_FLAGS.filter((f) => (flagsRaw & f.bit) === 0);
  const powers = MPT_FLAGS.filter((f) => f.category === "issuer-power-over-holders");
  return {
    set,
    unset,
    issuerPowersGranted: powers.filter((f) => (flagsRaw & f.bit) !== 0).map((f) => f.plain),
    issuerPowersNotGranted: powers
      .filter((f) => (flagsRaw & f.bit) === 0)
      .map((f) => `NOT granted: ${f.label} — ${f.permanence}`),
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
