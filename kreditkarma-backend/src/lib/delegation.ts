// src/lib/delegation.ts
// Permission Delegation (XLS-75, amendment PermissionDelegationV1_1) — the DelegateSet builder's rules and copy.
//
// What the ledger does (verified on Devnet 2026-10-05 with xrpl.js 4.6.0, where the amendment is live):
//   - DelegateSet { Account, Authorize, Permissions[] } lets `Authorize` sign the listed transaction types FOR `Account`
//     (a delegated tx carries Account = you, Delegate = them, and THEIR signature; they pay the fee).
//   - Re-sending DelegateSet for the same Authorize REPLACES the whole list (not merged).
//   - Permissions: [] deletes the grant (revoke). Revoking a grant that doesn't exist -> tecNO_ENTRY.
//   - One Delegate object per (Account, Authorize) pair, 1 owner reserve (0.2 XRP), charged to Account.
//   - A type that wasn't granted -> terNO_DELEGATE_PERMISSION (never applies, no fee charged).
//   - Authorize must be a funded account (tecNO_TARGET otherwise) and not Account itself.
//   - Max 10 permissions, no duplicates, nothing non-delegable (temARRAY_TOO_LARGE / temMALFORMED).
//
// Permission values follow XLS-75 ("tx-level permission is tx type plus one") and XLS-74 granular permissions
// (65537..65548). xrpl.js takes them as strings — { Permission: { PermissionValue: "Payment" } } — and the codec
// maps the names. Spec: github.com/XRPLF/XRPL-Standards XLS-0075 / XLS-0074.

import { validate } from "xrpl";

import { DELEGABLE_PERMISSIONS, MAX_DELEGATE_PERMISSIONS, type DelegablePermission } from "./delegationPermissions";
export { DELEGABLE_PERMISSIONS, DELEGATION_NEVER, MAX_DELEGATE_PERMISSIONS, type DelegablePermission, type DelegationRisk } from "./delegationPermissions";

export const DELEGATION_AMENDMENT = "PermissionDelegationV1_1";

/** XLS-75's non-delegable list in full. xrpl.js 4.6's validator only knows the first nine — the rest are enforced here. */
export const NON_DELEGABLE = new Set([
  "AccountSet", "SetRegularKey", "SignerListSet", "DelegateSet", "AccountDelete", "Batch",
  "EnableAmendment", "SetFee", "UNLModify", "ConfidentialMPTConvert",
  "VaultCreate", "VaultSet", "VaultDelete", "VaultDeposit", "VaultWithdraw", "VaultClawback",
  "LoanBrokerSet", "LoanBrokerDelete", "LoanBrokerCoverDeposit", "LoanBrokerCoverWithdraw", "LoanBrokerCoverClawback",
  "LoanSet", "LoanDelete", "LoanManage", "LoanPay", "SponsorshipTransfer",
]);

const BY_VALUE = new Map(DELEGABLE_PERMISSIONS.map((p) => [p.value.toLowerCase(), p]));

export function permissionInfo(value: string): DelegablePermission | undefined {
  return BY_VALUE.get(value.trim().toLowerCase());
}

export type ParsedPermissions = { ok: true; values: string[] } | { ok: false; error: string };

/** "Payment, CheckCreate" or ["Payment"] -> canonical names. 1..10, unique, all from the curated list. */
export function parsePermissions(raw: unknown): ParsedPermissions {
  const items = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return { ok: false, error: "choose at least one permission to grant" };
  const out: string[] = [];
  for (const item of items) {
    const info = permissionInfo(item);
    if (!info) {
      return { ok: false, error: NON_DELEGABLE.has(item) ? `"${item}" can never be delegated on the XRPL` : `"${item}" is not a permission we can grant` };
    }
    if (NON_DELEGABLE.has(info.value)) return { ok: false, error: `"${info.value}" can never be delegated on the XRPL` };
    if (out.includes(info.value)) return { ok: false, error: `"${info.value}" is listed twice` };
    out.push(info.value);
  }
  if (out.length > MAX_DELEGATE_PERMISSIONS) {
    return { ok: false, error: `the XRPL allows at most ${MAX_DELEGATE_PERMISSIONS} permissions per delegate (you chose ${out.length})` };
  }
  return { ok: true, values: out };
}

type Built = { ok: true; txjson: Record<string, unknown> } | { ok: false; error: string };

function checked(txjson: Record<string, unknown>): Built {
  try {
    // validate() needs the fields autofill would add; they are stripped again before the txjson is returned.
    validate({ ...txjson, Fee: "12", Sequence: 1 } as Parameters<typeof validate>[0]);
    return { ok: true, txjson };
  } catch (e) {
    return { ok: false, error: `the transaction failed validation: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Grant (or replace) a delegate's permissions. */
export function buildDelegateGrant(account: string, delegate: string, permissions: string[]): Built {
  if (delegate === account) return { ok: false, error: "the delegate must be a different account from yours" };
  return checked({
    TransactionType: "DelegateSet",
    Account: account,
    Authorize: delegate,
    Permissions: permissions.map((p) => ({ Permission: { PermissionValue: p } })),
  });
}

/** Revoke every permission a delegate holds (empty Permissions deletes the Delegate object). */
export function buildDelegateRevoke(account: string, delegate: string): Built {
  if (delegate === account) return { ok: false, error: "the delegate must be a different account from yours" };
  return checked({ TransactionType: "DelegateSet", Account: account, Authorize: delegate, Permissions: [] });
}

/** Read an existing grant's permission names from a raw Delegate ledger object. */
export function grantedPermissions(node: unknown): string[] {
  const perms = (node as { Permissions?: { Permission?: { PermissionValue?: unknown } }[] } | null)?.Permissions;
  return Array.isArray(perms) ? perms.map((p) => String(p?.Permission?.PermissionValue ?? "")).filter(Boolean) : [];
}
