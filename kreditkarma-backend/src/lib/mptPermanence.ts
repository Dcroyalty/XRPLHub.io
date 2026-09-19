// src/lib/mptPermanence.ts
// What is — and is not — permanent about an MPT issuance, stated for the
// amendment regime that actually applies RIGHT NOW.
//
// Background (XLS-94 DynamicMPT, verified against the spec text): once active,
// an issuance with no ImmutableFlags is mutable by default —
//   MUTABLE       MPTokenMetadata (incl. our backing declaration), TransferFee
//   ENABLE-ONLY   the capability flags (off -> on, never on -> off)
//   NEVER         MaximumAmount, AssetScale, the issuance id
// and the issuer can opt out per item with ImmutableFlags (bits only ever get
// added). The spec has no carve-out for issuances created before activation.
//
// So "permanent" is a claim about the future that depends on a validator vote.
// Every surface that says it must take a regime from getMptRegimeView() (a live
// read of the Amendments object) and use the copy below. The three regimes:
//   pre-activation   DynamicMPT read as inactive
//   post-activation  DynamicMPT read as active
//   unknown          could not be read -> hedged wording, never "permanent"

import { getAmendmentStatuses, type AmendmentState, type AmendmentStatus } from "./amendments";
import {
  MPT_FLAGS,
  MPT_FLAG_BITS,
  MPT_LSF_CAN_HOLD_CONFIDENTIAL,
  lockFlagName,
  type MptFlagKey,
  type MptRegime,
} from "./mptFlags";

export type { MptRegime };

// ── Live regime ──────────────────────────────────────────────────────────────

export interface MptRegimeView {
  regime: MptRegime;
  dynamicMpt: AmendmentStatus;
  confidentialTransfer: AmendmentStatus;
}

export function regimeFromState(s: AmendmentState): MptRegime {
  return s === "active" ? "post-activation" : s === "inactive" ? "pre-activation" : "unknown";
}

/** Read the live amendment state (one ledger read, cached — see amendments.ts). Never throws. */
export async function getMptRegimeView(): Promise<MptRegimeView> {
  const s = await getAmendmentStatuses(["DynamicMPT", "ConfidentialTransfer"] as const);
  return { regime: regimeFromState(s.DynamicMPT.state), dynamicMpt: s.DynamicMPT, confidentialTransfer: s.ConfidentialTransfer };
}

/** Compact, auditable record of what the response's claims rest on. */
export function amendmentEvidence(view: MptRegimeView) {
  return {
    regime: view.regime,
    dynamicMpt: {
      state: view.dynamicMpt.state,
      ledgerIndex: view.dynamicMpt.ledgerIndex,
      checkedAt: view.dynamicMpt.checkedAt,
      majoritySince: view.dynamicMpt.majoritySince,
      earliestActivation: view.dynamicMpt.earliestActivation,
    },
    confidentialTransfer: { state: view.confidentialTransfer.state, ledgerIndex: view.confidentialTransfer.ledgerIndex },
    note: stateNote(view),
  };
}

function stateNote(view: MptRegimeView): string {
  const s = view.dynamicMpt;
  return s.state === "unknown"
    ? "The live DynamicMPT amendment state could not be read from any XRPL node, so the hedged wording is used."
    : `DynamicMPT read as ${s.state} from the XRPL validated ledger${s.ledgerIndex ? ` #${s.ledgerIndex}` : ""}${s.checkedAt ? ` at ${s.checkedAt}` : ""}.`;
}

const day = (iso: string) => `${iso.slice(0, 10)} UTC`;

// ── ImmutableFlags (locks) ───────────────────────────────────────────────────

export interface LockItem {
  key: string;
  bit: number;
  /** form / API param name */
  param: string;
  label: string;
  /** transaction bit name (tif…) */
  tif: string;
  help: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const FLAG_LOCKS: LockItem[] = MPT_FLAGS.map((f) => ({
  key: f.key,
  bit: f.bit, // tif bits reuse the lsf/tf values 0x02…0x40
  param: `lock${cap(f.key)}`,
  label: f.label,
  tif: lockFlagName(f),
  help: `Permanently lock "${f.label}" so it can never be switched on later (if it is off) — and it can never be switched off if it is on.`,
}));

export const LOCK_ITEMS: LockItem[] = [
  ...FLAG_LOCKS,
  {
    key: "metadata",
    bit: 0x00010000,
    param: "lockMetadata",
    label: "Metadata (incl. backing declaration)",
    tif: "tifMPTMetadata",
    help: "Permanently lock the metadata — the name, ticker and backing declaration can never be rewritten by the issuer.",
  },
  {
    key: "transferFee",
    bit: 0x00020000,
    param: "lockTransferFee",
    label: "Transfer fee",
    tif: "tifMPTTransferFee",
    help: "Permanently lock the transfer fee — it can never be changed or removed by the issuer.",
  },
];

/** Locked only alongside ConfidentialTransfer (XLS-96): tifMPTCanHoldConfidentialBalance. */
export const CONFIDENTIAL_LOCK: LockItem = {
  key: "canHoldConfidentialBalance",
  bit: MPT_LSF_CAN_HOLD_CONFIDENTIAL,
  param: "lockCanHoldConfidentialBalance",
  label: "Confidential balances",
  tif: "tifMPTCanHoldConfidentialBalance",
  help: "Permanently lock the confidential-balance flag (XLS-96).",
};

/** Amendment states the builder needs; undefined = "unknown" (never adds ImmutableFlags). */
export interface BuildContext {
  dynamicMpt?: AmendmentState;
  confidentialTransfer?: AmendmentState;
  /** multi-step services: the step ids fixed at step 1, so later steps are built by id */
  planIds?: string[];
  /** multi-step services: the 1-based step being built (lets a builder run step-specific pre-checks) */
  step?: number;
}

/** Build context from an already-read regime view, so copy and builder agree within a request. */
export const buildContextFromView = (v: MptRegimeView): BuildContext => ({
  dynamicMpt: v.dynamicMpt.state,
  confidentialTransfer: v.confidentialTransfer.state,
});

/** Read the live regime — only for productId 'mptissue', so other products pay no RPC. */
export async function mptRegimeFor(productId: string): Promise<MptRegimeView | null> {
  return productId === "mptissue" ? getMptRegimeView() : null;
}

const truthy = (v: unknown) => v === true || v === "true" || v === "on" || v === "yes" || v === 1 || v === "1";

export type ParsedLocks =
  | { ok: true; value: number; locked: string[]; confidentialLeftUnlocked: boolean }
  | { ok: false; error: string };

/**
 * Turn the lock params into an ImmutableFlags value. Returns value 0 (=> omit the
 * field: the ledger rejects ImmutableFlags: 0 with temINVALID_FLAG) when nothing is
 * locked. Refuses — rather than silently dropping — any lock request unless
 * DynamicMPT is confirmed ACTIVE, because the ledger rejects the field otherwise
 * (temDISABLED) and the customer would already have paid.
 */
export function parseMptLocks(p: Record<string, unknown>, ctx?: BuildContext): ParsedLocks {
  const lockAll = truthy(p.lockAll);
  const wanted = LOCK_ITEMS.filter((i) => lockAll || truthy(p[i.param]));
  const wantsConfidential = truthy(p[CONFIDENTIAL_LOCK.param]);
  if (wanted.length === 0 && !wantsConfidential) return { ok: true, value: 0, locked: [], confidentialLeftUnlocked: false };

  const dyn = ctx?.dynamicMpt ?? "unknown";
  if (dyn !== "active") {
    return {
      ok: false,
      error:
        dyn === "inactive"
          ? "Locks (ImmutableFlags) are not available yet: the DynamicMPT amendment is not active on XRPL mainnet, and a transaction carrying ImmutableFlags would be rejected by the ledger (temDISABLED). Until it activates, nothing can be locked at issuance."
          : "Locks (ImmutableFlags) can't be added right now: the live DynamicMPT amendment state could not be read, and a transaction carrying ImmutableFlags is rejected by the ledger if the amendment is not active. Try again shortly.",
    };
  }

  const items = [...wanted];
  const confActive = ctx?.confidentialTransfer === "active";
  let confidentialLeftUnlocked = false;
  if (wantsConfidential || lockAll) {
    if (confActive) items.push(CONFIDENTIAL_LOCK);
    else if (wantsConfidential) {
      return {
        ok: false,
        error:
          "The confidential-balance flag can only be locked once the ConfidentialTransfer amendment is active, and it is not (or its state could not be read).",
      };
    } else confidentialLeftUnlocked = true;
  }
  let value = 0;
  for (const i of items) value |= i.bit;
  return { ok: true, value, locked: items.map((i) => i.key), confidentialLeftUnlocked };
}

const KNOWN_LOCK_MASK = [...LOCK_ITEMS, CONFIDENTIAL_LOCK].reduce((m, i) => m | i.bit, 0);

/** Which locks an ImmutableFlags value (from a tx or a ledger object) sets. */
export function decodeImmutableFlags(value: number): { locked: LockItem[]; unknownBits: number } {
  const all = [...LOCK_ITEMS, CONFIDENTIAL_LOCK];
  return { locked: all.filter((i) => (value & i.bit) !== 0), unknownBits: value & ~KNOWN_LOCK_MASK };
}

// ── Regime copy ──────────────────────────────────────────────────────────────

const at = (s: AmendmentStatus) => (s.ledgerIndex ? ` (ledger #${s.ledgerIndex})` : "");

/** Opening statement — which regime applies and what it means. */
export function regimeHeadline(view: MptRegimeView): string[] {
  const s = view.dynamicMpt;
  if (view.regime === "post-activation") {
    return [
      `DynamicMPT (XLS-94) is ACTIVE on XRPL mainnet${at(s)}. Unless you lock an item with ImmutableFlags at issuance, the issuer account can change it later.`,
    ];
  }
  if (view.regime === "pre-activation") {
    const out = [
      `Today, none of these choices can be changed after you sign. But DynamicMPT (XLS-94), an amendment XRPL validators are voting on, is not active yet${at(s)}.`,
      "If it activates, this token — like every existing MPT — becomes changeable by the issuer account: the metadata (including the backing declaration) and the transfer fee could be rewritten, and any flag you leave off could be switched on (never off), unless an ImmutableFlags lock is set. Locks cannot be set at issuance until DynamicMPT is active, so a token created today cannot be pre-locked.",
    ];
    if (s.majoritySince && s.earliestActivation) {
      out.push(
        `Validators reached the 80% threshold on ${day(s.majoritySince)}; it can activate no earlier than ${day(s.earliestActivation)}.`
      );
    }
    return out;
  }
  return [
    "We could not read the live DynamicMPT amendment state from any XRPL node right now, so do not treat any choice below as permanent.",
    "If DynamicMPT is active, the issuer account can change the metadata and transfer fee and switch flags that are off on (never off), unless they are locked with ImmutableFlags.",
  ];
}

/** True in every regime — the only things that are genuinely permanent. */
export const ALWAYS_PERMANENT = [
  "Maximum supply and decimal scale — no transaction can change them.",
  "Every capability flag you switch ON — flags can be enabled later but never disabled.",
  "The token's ID and its tie to your issuing account. The issuance can only be destroyed while zero tokens are outstanding.",
];

const FLAG_LABELS = MPT_FLAGS.map((f) => f.label).join(", ");

/** The metadata / fee / off-flag lines for the confirmation manifest. */
export function changeableLines(view: MptRegimeView, opts: { transferFeeSet: boolean }): string[] {
  const fee = opts.transferFeeSet ? "The transfer fee you set" : "The transfer fee (currently none)";
  if (view.regime === "post-activation") {
    return [
      "MUTABLE — metadata (MPTokenMetadata, including the backing declaration): the issuer can replace or clear it at any time unless locked (tifMPTMetadata).",
      `MUTABLE — ${fee.toLowerCase()} (TransferFee, 0–50%): the issuer can change or remove it at any time unless locked (tifMPTTransferFee). A non-zero fee needs "holders can transfer" on.`,
      `ENABLE-ONLY — the capability flags (${FLAG_LABELS}): a flag that is off can be switched on at any time unless locked; a flag that is on can never be switched off.`,
    ];
  }
  if (view.regime === "pre-activation") {
    return [
      "Metadata, including the backing declaration — fixed today. If DynamicMPT activates, the issuer could rewrite it unless it is locked.",
      `${fee} — fixed today. If DynamicMPT activates, the issuer could change or remove it unless it is locked.`,
      "Flags left OFF — cannot be switched on today. If DynamicMPT activates, the issuer could switch them on (never off) unless they are locked.",
    ];
  }
  return [
    "Metadata, including the backing declaration — may be rewritable by the issuer (DynamicMPT state unknown).",
    `${fee} — may be changeable or removable by the issuer (DynamicMPT state unknown).`,
    "Flags left OFF — may be switchable on by the issuer (DynamicMPT state unknown); a flag that is on can never be switched off.",
  ];
}

/** How ImmutableFlags works / why it isn't offered. */
export function lockGuide(view: MptRegimeView): string[] {
  if (view.regime === "post-activation") {
    const bits = [...LOCK_ITEMS]
      .map((i) => `${i.tif} 0x${i.bit.toString(16).toUpperCase()}`)
      .join(", ");
    const conf =
      view.confidentialTransfer.state === "active"
        ? "The confidential-balance bit (tifMPTCanHoldConfidentialBalance 0x80) can be locked too, because ConfidentialTransfer is active."
        : "The confidential-balance flag (0x80) cannot be locked until the separate ConfidentialTransfer amendment is active — so even a token locked on every other item could later gain confidential balances if that amendment activates and the issuer switches the flag on.";
    return [
      `ImmutableFlags is an optional field on the issuance transaction (the issuer can also add bits later). Each bit permanently locks one item: ${bits}.`,
      "Bits are only ever added, never cleared. A locked flag that is off can never be switched on; a locked flag that is on stays on; locked metadata or transfer fee can never change again.",
      conf,
      "Locking nothing is a choice: holders and registries will see the token as changeable by its issuer.",
    ];
  }
  if (view.regime === "pre-activation") {
    return [
      "Locks (ImmutableFlags) cannot be set until DynamicMPT is active — a transaction carrying the field is rejected by the ledger. Until then a token cannot be pre-locked, and the lock options are not offered.",
    ];
  }
  return [
    "Locks (ImmutableFlags) are only accepted once DynamicMPT is active. We can't confirm that right now, so this builder will not add them.",
  ];
}

export interface ConfirmCopy {
  heading: string;
  listTitle: string;
  warning: string;
  confirmPrompt: string;
  hardLineFlags: string;
}

/** The confirmation-step wording (execute route + UI). */
export function confirmCopy(view: MptRegimeView, locked: string[] = []): ConfirmCopy {
  const listTitle = "What can and cannot change after you sign";
  const backing = "and that XRPLHub publishes my backing declaration without verifying it.";
  if (view.regime === "post-activation") {
    return {
      heading: "Read every line — what you are locking, and what stays changeable",
      listTitle,
      warning:
        "MPTokenIssuanceCreate is the ONLY chance to lock these. DynamicMPT is active: unless you lock an item with " +
        "ImmutableFlags now, the issuer account can later change the metadata (including the backing declaration) and " +
        "the transfer fee, and switch flags that are off on. Maximum supply and decimals are permanent either way." +
        (locked.length ? "" : " You have not locked anything."),
      confirmPrompt:
        "I understand that what I have locked is permanent, that everything I have not locked can still be changed by the " +
        `issuer account, and that flags I switch on can never be switched off — ${backing}`,
      hardLineFlags:
        "These flags are the issuer's power over holders. Clawback means you can take the token back from anyone. A flag you switch on stays on forever; a flag you leave off can be switched on later unless you lock it now.",
    };
  }
  if (view.regime === "pre-activation") {
    return {
      heading: "Read every line — what is permanent, and what may not stay that way",
      listTitle,
      warning:
        "MPTokenIssuanceCreate is the ONLY chance to set these. Today none of it can be changed after you sign — but the " +
        "pending DynamicMPT amendment, if validators activate it, would let the issuer account change the metadata " +
        "(including the backing declaration) and the transfer fee and switch flags that are off on, and locks can't be " +
        "set until then. Maximum supply, decimals and any flag you switch on are permanent regardless.",
      confirmPrompt:
        "I understand that flags I switch on are permanent, that the metadata, transfer fee and flags I leave off are only " +
        `fixed while DynamicMPT stays inactive, ${backing}`,
      hardLineFlags:
        "These flags are the issuer's power over holders. Clawback means you can take the token back from anyone. A flag you switch on stays on forever, and today there is no way to lock one off.",
    };
  }
  return {
    heading: "Read every line — treat nothing here as permanent",
    listTitle,
    warning:
      "We could not read the live DynamicMPT amendment state. Do not treat any of this as permanent: if DynamicMPT is " +
      "active, the issuer account can change the metadata (including the backing declaration) and the transfer fee and " +
      "switch flags that are off on. Maximum supply, decimals and any flag you switch on are permanent regardless.",
    confirmPrompt:
      "I understand that only the maximum supply, decimals and flags I switch on are certain to be permanent, that " +
      `everything else may be changeable by the issuer account, ${backing}`,
    hardLineFlags:
      "These flags are the issuer's power over holders. Clawback means you can take the token back from anyone. A flag you switch on stays on forever; a flag you leave off may be switchable on later.",
  };
}

/** One paragraph for surfaces that hand out a build without the full manifest (MCP, x402). */
export function permanenceNotice(view: MptRegimeView): { notice: string; amendment: ReturnType<typeof amendmentEvidence> } {
  return { notice: regimeHeadline(view).join(" "), amendment: amendmentEvidence(view) };
}

// ── Form help (server-driven so the page never hard-codes "Permanent") ───────

const tail = (view: MptRegimeView): string =>
  view.regime === "post-activation"
    ? "ON is permanent. OFF can still be switched on later unless you lock it below."
    : view.regime === "pre-activation"
    ? "ON is permanent. OFF is fixed today, but could be switched on later if DynamicMPT activates (locks aren't available yet)."
    : "ON is permanent. OFF may be switchable on later (DynamicMPT state unavailable).";

export function formHelp(view: MptRegimeView): Record<string, string> {
  const feeTail =
    view.regime === "post-activation"
      ? "Changeable by the issuer any time unless you lock it below."
      : view.regime === "pre-activation"
      ? "Fixed today; changeable if DynamicMPT activates (locks aren't available yet)."
      : "May be changeable later (DynamicMPT state unavailable).";
  return {
    maximumAmount: "Permanent in every case. Creating the token mints 0 — you distribute later with Send MPT.",
    assetScale: "0–19. 2 = smallest unit is 0.01. Permanent in every case.",
    canTransfer: `OFF = closed-loop / store credit — holders can only send it back to you. ${tail(view)}`,
    canTrade: tail(view),
    canEscrow: tail(view),
    canLock: `You could freeze one holder or every holder. ${tail(view)}`,
    requireAuth: `Nobody can hold it until you authorize their account. ${tail(view)}`,
    canClawback: `You could take the token back from any holder, anytime, without their consent. ${tail(view)}`,
    transferFee: `0–50%. Requires "holders can transfer" ON. ${feeTail}`,
    metadataUrl: view.regime === "post-activation" ? "Stored in metadata as weblink. Changeable by the issuer unless you lock metadata below." : "Stored in metadata as weblink",
  };
}

export interface FormField {
  key: string;
  label: string;
  type: "select";
  options: string[];
  default: string;
  help: string;
}

/** Lock fields for the issuance form — empty unless DynamicMPT is confirmed active. */
export function lockFormFields(view: MptRegimeView): FormField[] {
  if (view.regime !== "post-activation") return [];
  const sel = (key: string, label: string, help: string): FormField => ({ key, label, type: "select", options: ["off", "on"], default: "off", help });
  const confNote =
    view.confidentialTransfer.state === "active"
      ? " Includes the confidential-balance flag."
      : " Does not include the confidential-balance flag (ConfidentialTransfer isn't active).";
  return [
    sel("lockAll", "🔒 Lock everything (true permanence)", `Sets ImmutableFlags for every item below in one step.${confNote}`),
    ...LOCK_ITEMS.map((i) => sel(i.param, `🔒 Lock: ${i.label}`, i.help)),
  ];
}

// ── Registry view: what a LIVE issuance's ledger object says about mutability ─

export type FlagMutability =
  | "on-permanent"
  | "off-locked"
  | "off-can-be-enabled"
  | "off-can-be-enabled-if-DynamicMPT-activates"
  | "off-possibly-enableable";
export type FieldMutability = "locked" | "changeable" | "changeable-if-DynamicMPT-activates" | "possibly-changeable";

/**
 * Mutability of one live issuance, from its ledger object (Flags + ImmutableFlags).
 * ImmutableFlags absent = nothing locked (spec: mutable by default once DynamicMPT is active).
 */
export function issuanceMutability(node: { Flags?: unknown; ImmutableFlags?: unknown }, view: MptRegimeView) {
  const flags = Number(node.Flags ?? 0);
  const imm = Number(node.ImmutableFlags ?? 0);
  const { locked, unknownBits } = decodeImmutableFlags(imm);
  const isLocked = (bit: number) => (imm & bit) !== 0;

  const field = (bit: number): FieldMutability =>
    isLocked(bit)
      ? "locked"
      : view.regime === "post-activation"
      ? "changeable"
      : view.regime === "pre-activation"
      ? "changeable-if-DynamicMPT-activates"
      : "possibly-changeable";
  const flag = (k: MptFlagKey): FlagMutability =>
    (flags & MPT_FLAG_BITS[k]) !== 0
      ? "on-permanent"
      : isLocked(MPT_FLAG_BITS[k])
      ? "off-locked"
      : view.regime === "post-activation"
      ? "off-can-be-enabled"
      : view.regime === "pre-activation"
      ? "off-can-be-enabled-if-DynamicMPT-activates"
      : "off-possibly-enableable";

  return {
    dynamicMpt: { state: view.dynamicMpt.state, ledgerIndex: view.dynamicMpt.ledgerIndex, checkedAt: view.dynamicMpt.checkedAt },
    immutableFlagsRaw: imm || null,
    lockedItems: locked.map((i) => i.key),
    unknownLockBits: unknownBits || null,
    metadata: field(0x00010000),
    transferFee: field(0x00020000),
    flags: Object.fromEntries((Object.keys(MPT_FLAG_BITS) as MptFlagKey[]).map((k) => [k, flag(k)])) as Record<MptFlagKey, FlagMutability>,
    note:
      "issuerPowers above is what the issuer can do NOW. Only 'on-permanent' and locked ('off-locked', 'locked') items are guaranteed unchanging; " +
      "anything else can change (or could, if DynamicMPT activates) by the issuer's own transaction. Max supply and decimals never change.",
  };
}
