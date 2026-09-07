// src/app/api/execute/preview/route.ts
// POST /api/execute/preview  { productId, account, params }
//
// FREE. Builds the exact service transaction and returns it DECODED, with — for
// an MPT issuance — the full manifest of what is permanent, the plain-English
// flag guide, the backing declaration echoed back, and the hard line that we
// publish the declaration but never verify it. No payment, no wallet, nothing
// submitted. Pay via the normal flow (/api/create-payment -> /api/execute) to
// actually build and sign.

import { NextResponse } from "next/server";
import { buildServiceTx } from "../txBuilder";
import { describeMptIssuanceCreate } from "@/lib/mptMeta";
import { MPT_FLAGS } from "@/lib/mptFlags";
import { BACKING_HARD_LINE, BACKING_TYPES, REDEEMABLE_VALUES, DEFAULT_BACKING } from "@/lib/mptBacking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    productId?: string;
    account?: string;
    params?: Record<string, unknown>;
  };
  const productId = String(body.productId ?? "").trim();
  const account = String(body.account ?? "").trim();
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  if (!ADDR_RE.test(account)) {
    return NextResponse.json({ error: "account must be a valid XRPL address (the issuer / signer)" }, { status: 400 });
  }

  const built = buildServiceTx(productId, account, (body.params ?? {}) as Record<string, string | number | boolean | undefined>);
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
    txjson: built.txjson, // the decoded, unsigned transaction — review this before signing
    priced: "Free preview. Pay to build and sign — see /api/create-payment then /api/execute.",
  };

  if (productId === "mptissue") {
    const manifest = describeMptIssuanceCreate(built.txjson as Record<string, unknown>);
    return NextResponse.json({
      ...base,
      permanent: true,
      manifest,
      flagGuide: MPT_FLAGS.map((f) => ({
        flag: f.txFlag,
        label: f.label,
        category: f.category,
        plain: f.plain,
        permanence: f.permanence,
      })),
      backing: {
        types: BACKING_TYPES,
        redeemableValues: REDEEMABLE_VALUES,
        default: DEFAULT_BACKING,
        declared: manifest.backingDeclaration,
        hardLine: BACKING_HARD_LINE,
      },
      disclaimer:
        "Every field above is permanent once you sign — MPTokenIssuanceCreate is the only chance to set the flags, " +
        "supply, scale, fee, and metadata. " +
        BACKING_HARD_LINE,
    });
  }

  return NextResponse.json(base);
}
