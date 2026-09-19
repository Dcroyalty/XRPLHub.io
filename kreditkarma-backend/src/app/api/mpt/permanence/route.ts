// src/app/api/mpt/permanence/route.ts
// GET /api/mpt/permanence — which permanence regime applies to MPT issuance RIGHT
// NOW, read live from the XRPL Amendments object (DynamicMPT, XLS-94), plus the
// wording and form fields that follow from it. Free, no signup.
//
// The issuance form calls this instead of hard-coding "Permanent": help text is
// regime-dependent, and the lock fields (ImmutableFlags) only appear once
// DynamicMPT is confirmed active. If the state can't be read, `regime` is
// "unknown" and everything is the hedged wording — never "permanent".
import { NextResponse } from "next/server";
import {
  ALWAYS_PERMANENT,
  amendmentEvidence,
  changeableLines,
  formHelp,
  getMptRegimeView,
  lockFormFields,
  lockGuide,
  regimeHeadline,
} from "@/lib/mptPermanence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const view = await getMptRegimeView();
  return NextResponse.json(
    {
      ...amendmentEvidence(view),
      headline: regimeHeadline(view),
      alwaysPermanent: ALWAYS_PERMANENT,
      changeable: changeableLines(view, { transferFeeSet: false }),
      lockGuide: lockGuide(view),
      formHelp: formHelp(view),
      lockFields: lockFormFields(view), // empty unless DynamicMPT is active
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}
