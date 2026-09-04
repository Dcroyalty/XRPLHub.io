// src/app/api/credentials/verify/route.ts
// DEVNET-ONLY, read-only, public. Reads a Credential ledger object and reports
// its status against the validated ledger.
//
// GET /api/credentials/verify?issuer=r...&subject=r...&type=XRPLSCORE_750PLUS
//   (type may be the ascii label or its hex encoding)

import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/xrplscore";
import { readCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const issuer = (url.searchParams.get("issuer") ?? "").trim();
  const subject = (url.searchParams.get("subject") ?? "").trim();
  const type = (url.searchParams.get("type") ?? "").trim();

  if (!isValidXrplAddress(issuer) || !isValidXrplAddress(subject) || !type) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide issuer, subject (both r-addresses) and type." },
      { status: 400 }
    );
  }

  try {
    const status = await readCredential({ issuer, subject, type });
    return NextResponse.json(
      { network: "devnet", ...status },
      { status: status.found ? 200 : 404, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "verify failed";
    return NextResponse.json({ error: "verify_failed", message }, { status: 500 });
  }
}
