// src/lib/serviceAmendments.ts
// Storefront services that only exist once an amendment is live on mainnet. Same posture as lending
// (lendingLedger.ts): FAIL CLOSED — "inactive" and "unknown" both mean unavailable — and it switches on by
// itself: amendments.ts reads the validated ledger at request time, so the moment the amendment activates the
// next request sees "active". Never a build-time flag.
//
// Enforced in two places, both BEFORE any money moves:
//   - /api/create-payment refuses to start a payment for an unavailable service;
//   - the product's own builder refuses to build (so /api/execute refuses too).

import { getAmendmentStatuses, type AmendmentStatus } from "./amendments";

/** productId -> the amendment it needs. */
// Empty since 2026-10-07: the only amendment-gated service (delegate) was removed along with the generic builders. The gate
// stays so a future product transaction that needs an amendment is fail-closed from day one.
export const SERVICE_REQUIRED_AMENDMENT: Readonly<Record<string, string>> = Object.freeze({});

export interface ServiceAvailability {
  productId: string;
  available: boolean;
  amendment: string | null;
  state: AmendmentStatus["state"] | null;
  majoritySince: string | null;
  earliestActivation: string | null;
  /** Customer-facing explanation when unavailable; null when available. */
  message: string | null;
}

function messageFor(s: AmendmentStatus): string {
  if (s.state === "unknown") {
    return `Temporarily unavailable: we could not read the XRP Ledger to confirm the ${s.name} amendment is active. Try again in a few minutes.`;
  }
  const when = s.earliestActivation
    ? ` It has validator majority and activates on its own at the earliest ${new Date(s.earliestActivation).toUTCString().replace(":00 GMT", " UTC")}.`
    : " It does not have validator majority yet.";
  return `Not available yet: this needs the ${s.name} amendment, which is not active on the XRP Ledger.${when} This service switches on automatically the moment it does.`;
}

/** Availability for many products from ONE ledger read. Products with no amendment requirement are always available. */
export async function servicesAvailability(productIds: readonly string[]): Promise<Record<string, ServiceAvailability>> {
  const needed = [...new Set(productIds.map((p) => SERVICE_REQUIRED_AMENDMENT[p]).filter(Boolean))];
  const statuses = needed.length ? await getAmendmentStatuses(needed) : ({} as Record<string, AmendmentStatus>);
  const out: Record<string, ServiceAvailability> = {};
  for (const productId of productIds) {
    const amendment = SERVICE_REQUIRED_AMENDMENT[productId] ?? null;
    if (!amendment) {
      out[productId] = { productId, available: true, amendment: null, state: null, majoritySince: null, earliestActivation: null, message: null };
      continue;
    }
    const s = statuses[amendment];
    const available = s.state === "active";
    out[productId] = {
      productId, available, amendment, state: s.state,
      majoritySince: s.majoritySince, earliestActivation: s.earliestActivation,
      message: available ? null : messageFor(s),
    };
  }
  return out;
}

export async function serviceAvailability(productId: string): Promise<ServiceAvailability> {
  return (await servicesAvailability([productId]))[productId];
}
