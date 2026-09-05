// src/app/api/mpt/[issuanceId]/route.ts
// GET /api/mpt/:issuanceId — the risk view of one Multi-Purpose Token
// issuance. Free, no signup. Live reads (validated ledger + live issuer
// XRPLScore), no index.
//
// :issuanceId is the 48-hex-character MPTokenIssuanceID (XLS-33: a 192-bit
// value = the creating tx Sequence + the issuer AccountID; ledger_entry
// resolves it directly via its `mpt_issuance` shorthand).
//
// What you get that XRPScan / Bithomp don't surface: issuer powers over a
// holder (clawback, freeze, require-auth, non-transferable) alongside the
// issuer's own XRPLScore, account age, verified domain, and credentials —
// the risk read, not the listing.
import { NextRequest, NextResponse } from "next/server";
import { getMptRisk, MPT_ISSUANCE_ID_RE } from "@/lib/mpt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { issuanceId: string } }) {
  const issuanceId = (params.issuanceId ?? "").trim();
  if (!MPT_ISSUANCE_ID_RE.test(issuanceId)) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: "Provide a valid MPTokenIssuanceID — 48 hexadecimal characters (the 192-bit XLS-33 issuance id).",
      },
      { status: 400 }
    );
  }

  try {
    const risk = await getMptRisk(issuanceId);
    return NextResponse.json(risk, {
      headers: { "Cache-Control": "public, max-age=30" },
    });
  } catch (err) {
    console.error("[mpt]", err);
    return NextResponse.json(
      { error: "lookup_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 }
    );
  }
}
