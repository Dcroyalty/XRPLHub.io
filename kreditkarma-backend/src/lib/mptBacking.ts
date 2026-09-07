// src/lib/mptBacking.ts
// Every MPT issued through XRPLHub declares what — if anything — backs it. The
// declaration is written into MPTokenMetadata, so it is on-ledger and immutable.
//
// HARD LINE (repeated in the confirmation step and every response that carries a
// backingDeclaration):
//   XRPLHub publishes what the issuer declared. We do not verify it, we cannot
//   verify it, and a declaration is not evidence. An unbacked token and a token
//   whose issuer merely claims backing look identical on-ledger — the
//   declaration only records the claim.

export const BACKING_TYPES = [
  "none",
  "physical-custody",
  "legal-entity",
  "other-onchain",
  "self-declared",
  "other",
] as const;
export type BackingType = (typeof BACKING_TYPES)[number];

export const REDEEMABLE_VALUES = ["yes", "no", "unspecified"] as const;
export type Redeemable = (typeof REDEEMABLE_VALUES)[number];

export interface BackingDeclaration {
  backingType: BackingType;
  /** Free text — what the issuer claims backs the token. */
  backingStatement: string;
  /** Who verifies the backing, if anyone. NEVER XRPLHub. */
  verifiedBy: string | null;
  /** Can a holder exchange the token for the underlying? */
  redeemable: Redeemable;
}

export const DEFAULT_BACKING: BackingDeclaration = {
  backingType: "none",
  backingStatement: "This token represents nothing. It is not backed by any asset.",
  verifiedBy: null,
  redeemable: "unspecified",
};

export const BACKING_HARD_LINE =
  "XRPLHub publishes what the issuer declared. We do not verify it, we cannot verify it, and a declaration " +
  "is not evidence. An unbacked token and a token whose issuer merely claims backing look identical " +
  "on-ledger — the declaration only records the claim.";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Coerce arbitrary form input into a valid BackingDeclaration. Missing /
 *  unrecognised backingType falls back to the default "none" declaration. */
export function normalizeBacking(input: Partial<BackingDeclaration> | undefined | null): BackingDeclaration {
  if (!input) return { ...DEFAULT_BACKING };
  const type = (BACKING_TYPES as readonly string[]).includes(String(input.backingType ?? ""))
    ? (input.backingType as BackingType)
    : "none";

  if (type === "none") {
    // A "none" declaration always carries the canonical statement — the issuer
    // can't attach a backing claim to an unbacked token.
    return { ...DEFAULT_BACKING };
  }

  const redeemable = (REDEEMABLE_VALUES as readonly string[]).includes(String(input.redeemable ?? ""))
    ? (input.redeemable as Redeemable)
    : "unspecified";
  const statement = clip(String(input.backingStatement ?? "").trim(), 480);
  const verifiedBy = input.verifiedBy ? clip(String(input.verifiedBy).trim(), 120) : null;

  return { backingType: type, backingStatement: statement, verifiedBy, redeemable };
}

/** Returns an error string if the declaration is unusable, else null. */
export function validateBacking(b: BackingDeclaration): string | null {
  if (b.backingType === "none") return null;
  if (!b.backingStatement || b.backingStatement.length < 8) {
    return `A "${b.backingType}" backing declaration needs a backingStatement describing what backs the token (at least 8 characters), or set backingType to "none".`;
  }
  return null;
}

/** Pull a BackingDeclaration out of decoded MPTokenMetadata. Returns null when
 *  the metadata has no `backing` block (issuances created before this builder,
 *  or by other tools). Never throws. */
export function parseBackingFromMetadata(decoded: string | null): BackingDeclaration | null {
  if (!decoded) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(decoded);
  } catch {
    return null;
  }
  const root = obj as Record<string, unknown>;
  const b = (root?.backing ?? (root?.xrplhub as Record<string, unknown>)?.backing) as
    | Record<string, unknown>
    | undefined;
  if (!b || typeof b !== "object") return null;
  return normalizeBacking({
    backingType: b.backingType as BackingType,
    backingStatement: typeof b.backingStatement === "string" ? b.backingStatement : "",
    verifiedBy: typeof b.verifiedBy === "string" ? b.verifiedBy : null,
    redeemable: b.redeemable as Redeemable,
  });
}

/** The `backingDeclaration` object every registry response carries. `declared`
 *  is null when the issuance predates the declaration convention. */
export function backingDeclarationView(decoded: string | null) {
  const declared = parseBackingFromMetadata(decoded);
  return {
    declared, // null | BackingDeclaration
    present: declared !== null,
    note: declared
      ? BACKING_HARD_LINE
      : "This issuance carries no backing declaration in its on-ledger metadata. That is not a statement about whether it is backed — only that the issuer did not declare.",
  };
}
