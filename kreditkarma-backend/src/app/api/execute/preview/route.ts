// src/app/api/execute/preview/route.ts
// POST /api/execute/preview  { productId, account, params }
//
// FREE, and it NEVER returns signable txjson. It validates the request by really building the transaction, then returns a
// DESCRIPTION: what the transaction is, its price, what is irreversible, and — for an MPT issuance — the full manifest of
// what is permanent, the plain-English flag guide, the backing declaration echoed back, and the hard line that we publish
// the declaration but never verify it. The exact transaction object (txjson) is delivered only after payment: the
// storefront flow (/api/create-payment -> /api/execute) or x402 (/api/x402/tx, USDC on Base or RLUSD on XRPL).
// (Until 2026-09-25 this route returned the txjson for free, which made every paid path optional.)

import { NextResponse } from "next/server";
import { buildServiceTx } from "../txBuilder";
import { priceUsd } from "@/lib/pricing";
import { cautionCopyFor } from "@/lib/serviceCaution";
import { describeMptIssuanceCreate } from "@/lib/mptMeta";
import { MPT_FLAGS, flagPermanence, lockFlagName } from "@/lib/mptFlags";
import {
  LOCK_ITEMS,
  buildContextFromView,
  confirmCopy,
  formHelp,
  lockGuide,
  mptRegimeFor,
} from "@/lib/mptPermanence";
import { BACKING_HARD_LINE, BACKING_TYPES, REDEEMABLE_VALUES, DEFAULT_BACKING } from "@/lib/mptBacking";
import { isValidXrplAddress } from "@/lib/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    productId?: string;
    account?: string;
    params?: Record<string, unknown>;
  };
  const productId = String(body.productId ?? "").trim();
  const account = String(body.account ?? "").trim();
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  if (!isValidXrplAddress(account)) {
    return NextResponse.json({ error: "account must be a valid XRPL address (the issuer / signer)" }, { status: 400 });
  }

  // MPT issuance: read the LIVE amendment state once; the copy and the builder both
  // use it, so what we say and what we build can't disagree. Unknown => hedged copy,
  // and no ImmutableFlags.
  const view = await mptRegimeFor(productId);
  const built = await buildServiceTx(
    productId,
    account,
    (body.params ?? {}) as Record<string, string | number | boolean | undefined>,
    view ? buildContextFromView(view) : undefined
  );
  if (!built.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: built.error,
        needsParams: built.needsParams ?? undefined,
        tier: built.tier ?? undefined,
      },
      { status: built.tier === "blocked" ? 403 : built.needsParams?.length ? 422 : 400 }
    );
  }

  const base = {
    ok: true,
    productId,
    label: built.label,
    tier: built.tier,
    // The request BUILT successfully (so the params are valid); the transaction object itself is withheld until payment.
    // Multi-transaction services: how many steps and what each is, in signing order. The transactions are paid-only.
    totalSteps: built.steps?.length ?? 1,
    steps: (built.steps ?? []).map((s) => ({ id: s.id, label: s.label, transactionType: String(s.txjson.TransactionType) })),
    priceUsd: priceUsd(productId),
    // Services with specific, serious consequences show them here — free, before you pay.
    confirmation: cautionCopyFor(productId, (body.params ?? {}) as Record<string, unknown>),
    signableTransaction: "withheld — delivered only after payment",
    howToBuy: {
      x402: `/api/x402/tx?productId=${productId}&account=${account} (pay USDC on Base or RLUSD on XRPL; add confirmCaution=true for caution-tier services)`,
      storefront: "/api/create-payment then /api/execute",
      mcp: "build_xrpl_transaction (returns the x402 resource)",
    },
    priced: "Free description. The signable transaction is delivered only after payment. The price is set by the server, not the client.",
  };

  if (productId === "mptissue" && view) {
    const manifest = describeMptIssuanceCreate(built.txjson as Record<string, unknown>, view);
    const copy = confirmCopy(view, manifest.permanence.lockedByThisTransaction);
    return NextResponse.json({
      ...base,
      // Replaces the old blanket `permanent: true`: what is permanent depends on the live
      // DynamicMPT amendment state, which this block reports and dates.
      permanence: manifest.permanence,
      manifest,
      flagGuide: MPT_FLAGS.map((f) => {
        const p = flagPermanence(f, view.regime);
        return {
          flag: f.txFlag,
          label: f.label,
          category: f.category,
          plain: f.plain,
          permanence: `If on: ${p.ifOn} If off: ${p.ifOff}`,
          permanenceIfOn: p.ifOn,
          permanenceIfOff: p.ifOff,
          lockBit: lockFlagName(f),
        };
      }),
      // Locks (ImmutableFlags) — offered only while DynamicMPT is confirmed active.
      locks: {
        available: view.regime === "post-activation",
        guide: lockGuide(view),
        options: view.regime === "post-activation" ? LOCK_ITEMS.map((i) => ({ param: i.param, tif: i.tif, bit: i.bit, label: i.label })) : [],
        lockAllParam: "lockAll",
      },
      formHelp: formHelp(view),
      backing: {
        types: BACKING_TYPES,
        redeemableValues: REDEEMABLE_VALUES,
        default: DEFAULT_BACKING,
        declared: manifest.backingDeclaration,
        hardLine: BACKING_HARD_LINE,
      },
      // copy.warning is regime-specific and already opens with "MPTokenIssuanceCreate is the ONLY
      // chance…" — don't also prepend an intro or the regime headline, which repeat the same claims.
      // The dated ledger read stays available in `permanence.amendment`.
      disclaimer: copy.warning + " " + BACKING_HARD_LINE,
    });
  }

  return NextResponse.json(base);
}
