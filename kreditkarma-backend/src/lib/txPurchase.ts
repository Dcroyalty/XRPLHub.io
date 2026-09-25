// src/lib/txPurchase.ts
// The one place that turns "a service, for a wallet" into (a) a FREE description an agent can decide on and (b) the PAID
// x402 resource that delivers the signable transaction. Used by the MCP tools, POST /api/execute/preview and
// /api/x402/tx so the price, the irreversibility wording and the payment URL cannot drift apart.
//
// THE RULE: nothing in here ever returns signable txjson. The description says what a transaction does, what cannot be
// undone, what it costs and which fields it needs. The transaction itself is delivered only by /api/x402/tx (after an
// x402 payment, USDC on Base or RLUSD on XRPL) or by the paid /api/execute flow.

import { SERVICE_CATALOG, type ServiceDef } from "@/app/api/execute/serviceCatalog";
import { priceUsd } from "@/lib/pricing";
import { cautionCopyFor } from "@/lib/serviceCaution";
import { describeMptIssuanceCreate } from "@/lib/mptMeta";
import { BACKING_HARD_LINE } from "@/lib/mptBacking";
import { confirmCopy, mptRegimeFor, permanenceNotice, type MptRegimeView } from "@/lib/mptPermanence";

export const TX_RESOURCE_PATH = "/api/x402/tx";
/** Query keys on the paid resource that are NOT service params. */
export const TX_RESERVED_QUERY_KEYS: ReadonlySet<string> = new Set(["productid", "account", "confirmcaution"]);

const CATALOG = new Map<string, ServiceDef>(SERVICE_CATALOG.map((s) => [s.id, s]));

export function serviceDef(productId: string): ServiceDef | undefined {
  return CATALOG.get(productId);
}

export type Primitive = string | number | boolean;

/** Required params (by catalogue) that are absent/empty in `params`. `false` and `0` count as present. */
export function missingRequiredParams(def: ServiceDef, params: Record<string, unknown>): string[] {
  return def.params
    .filter((p) => p.required)
    .filter((p) => {
      const v = params[p.name];
      return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    })
    .map((p) => p.name);
}

/** The paid x402 resource URL for one service + wallet + params. Contains no secret and no signable data. */
export function paymentResourceUrl(origin: string, productId: string, account: string, params: Record<string, Primitive>, confirmCaution = false): string {
  const q = new URLSearchParams({ productId, account });
  for (const [k, v] of Object.entries(params)) {
    if (TX_RESERVED_QUERY_KEYS.has(k.toLowerCase())) continue;
    q.set(k, String(v));
  }
  if (confirmCaution) q.set("confirmCaution", "true");
  return `${origin}${TX_RESOURCE_PATH}?${q.toString()}`;
}

export interface PriceInfo {
  usd: number;
  /** USD = RLUSD = USDC at face value; the XRP amount (storefront checkout only) is derived from a live rate. */
  note: string;
  payWith: string[];
}

export function priceInfo(productId: string): PriceInfo | null {
  const usd = priceUsd(productId);
  if (usd == null) return null;
  return {
    usd,
    note: "Storefront list price. Face value is the same on both x402 rails (1 USDC = 1 RLUSD = $1). The price is set by the server and verified on every payment.",
    payWith: ["USDC on Base (x402 v1, X-PAYMENT header)", "RLUSD on the XRP Ledger (x402 v2 via t54, PAYMENT-SIGNATURE header)"],
  };
}

export interface Confirmation {
  requiresConfirmation: true;
  heading?: string;
  warning: string;
  irreversible?: string[];
  confirmPrompt?: string;
  permanence?: unknown;
  backingNotice?: string;
}

const GENERIC_CAUTION =
  "This operation changes how your wallet is controlled or what it permits and may be difficult or impossible to reverse. The wallet owner must read this and confirm before signing.";

/**
 * The confirmation a caution-tier service needs (null for safe/blocked). With `txjson` (post-payment build only) the MPT
 * issuance manifest is exact; without it the wording is the regime-level copy. No signable data leaves this function.
 */
export function confirmationFor(productId: string, params: Record<string, unknown>, tier: string, view: MptRegimeView | null, txjson?: Record<string, unknown>): Confirmation | null {
  if (tier !== "caution") return null;
  if (productId === "mptissue" && view) {
    if (txjson) {
      const manifest = describeMptIssuanceCreate(txjson, view);
      const copy = confirmCopy(view, manifest.permanence.lockedByThisTransaction);
      return { requiresConfirmation: true, heading: copy.heading, warning: copy.warning, irreversible: manifest.irreversible, confirmPrompt: copy.confirmPrompt, permanence: manifest.permanence, backingNotice: BACKING_HARD_LINE };
    }
    const copy = confirmCopy(view, []);
    return { requiresConfirmation: true, heading: copy.heading, warning: copy.warning, confirmPrompt: copy.confirmPrompt, backingNotice: BACKING_HARD_LINE };
  }
  const specific = cautionCopyFor(productId, params);
  if (specific) {
    return { requiresConfirmation: true, heading: specific.heading, warning: specific.warning, irreversible: specific.irreversible, confirmPrompt: specific.confirmPrompt };
  }
  return { requiresConfirmation: true, warning: GENERIC_CAUTION };
}

export interface ServicePreview {
  free: true;
  productId: string;
  label: string;
  category: string;
  safetyTier: string;
  whatItDoes: string;
  price: PriceInfo | null;
  requiredParams: { name: string; type: string; description: string; example: string }[];
  optionalParams: { name: string; type: string; description: string; example: string }[];
  irreversible: Confirmation | { requiresConfirmation: false; note: string } | { blocked: true; note: string };
  mptPermanence?: unknown;
  howToBuy: { tool: string; resource: string; steps: string[] };
  unsignedOnly: string;
  notIncluded: string;
}

/** FREE description of a service. Never contains txjson. */
export async function describeService(origin: string, productId: string, params: Record<string, unknown> = {}): Promise<ServicePreview | null> {
  const def = CATALOG.get(productId);
  if (!def) return null;
  const view = await mptRegimeFor(productId); // null for every service except MPT issuance
  const conf = confirmationFor(productId, params, def.tier, view);
  const irreversible: ServicePreview["irreversible"] =
    def.tier === "blocked"
      ? { blocked: true, note: "XRPLHub does not build this: it can permanently lock account access. Contact support@xrplhub.io for a guided manual process." }
      : conf ?? {
          requiresConfirmation: false,
          note: "Not marked irreversible by XRPLHub. Like every XRPL transaction it is final once validated on the ledger, so check every field before signing.",
        };
  const shape = (p: ServiceDef["params"][number]) => ({ name: p.name, type: p.type, description: p.desc, example: p.example });
  return {
    free: true,
    productId,
    label: def.label,
    category: def.category,
    safetyTier: def.tier,
    whatItDoes: def.gives,
    price: def.tier === "blocked" ? null : priceInfo(productId),
    requiredParams: def.params.filter((p) => p.required).map(shape),
    optionalParams: def.params.filter((p) => !p.required).map(shape),
    irreversible,
    ...(view ? { mptPermanence: permanenceNotice(view) } : {}),
    howToBuy: {
      tool: "build_xrpl_transaction",
      resource: `${origin}${TX_RESOURCE_PATH}?productId=${productId}&account=<your r-address>&<params>${def.tier === "caution" ? "&confirmCaution=true" : ""}`,
      steps: [
        "Call build_xrpl_transaction with product_id, wallet_address and params: it returns the exact x402 payment resource URL (no transaction).",
        "GET that URL with an x402 client and pay in USDC on Base or RLUSD on XRPL. You are only charged if the transaction builds successfully.",
        def.tier === "caution" ? "This is caution-tier: the wallet owner must first read `irreversible`; then add confirmCaution=true (build_xrpl_transaction confirm_caution: true)." : "The paid response contains the unsigned txjson (and every step, in order, for multi-step services).",
        "Verify the returned transaction's Account equals your wallet, then sign it with your OWN wallet and submit it. XRPLHub never signs and never holds keys.",
      ],
    },
    unsignedOnly: "XRPLHub builds and describes transactions only. It never signs, never submits and never holds keys.",
    notIncluded: "The transaction itself (txjson) is intentionally NOT in this preview. It is delivered only after payment.",
  };
}
