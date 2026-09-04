// src/app/api/credentials/verify/route.ts
// GET /api/credentials/verify?subject=r...[&issuer=r...][&type=...]
// Reads an XLS-70 XRPLScore credential from the validated MAINNET ledger.
// Machine-readable wrapper around `ledger_entry`. No auth — public verification.

import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/xrplscore";
import {
  readCredential,
  credentialType,
  EXPECTED_ISSUER,
  CRED_NAMESPACE,
  type ScoreTier,
} from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS: ScoreTier[] = ["min750", "min700", "min650", "min600"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const subject = (url.searchParams.get("subject") ?? "").trim();
  const issuer = (url.searchParams.get("issuer") ?? EXPECTED_ISSUER).trim();
  const type = (url.searchParams.get("type") ?? "").trim();

  if (!isValidXrplAddress(subject)) {
    return NextResponse.json({ error: "bad_request", message: "Provide a valid ?subject=r... address." }, { status: 400 });
  }
  if (!isValidXrplAddress(issuer)) {
    return NextResponse.json({ error: "bad_request", message: "Invalid ?issuer address." }, { status: 400 });
  }

  try {
    // Explicit type -> check just that one. Otherwise scan our four tiers.
    const types = type ? [type] : TIERS.map((t) => credentialType(t));
    for (const t of types) {
      const r = await readCredential({ issuer, subject, type: t });
      if (r.found) {
        return NextResponse.json({
          namespace: CRED_NAMESPACE,
          ...r,
          validForGating: r.found && r.accepted && !r.expired,
        });
      }
    }
    return NextResponse.json({
      namespace: CRED_NAMESPACE,
      found: false,
      accepted: false,
      expired: false,
      issuer,
      subject,
      validForGating: false,
      reason: type
        ? "No such credential on the validated ledger."
        : `No XRPLScore credential from ${issuer} on the validated ledger for this subject.`,
    });
  } catch (e) {
    console.error("[credentials/verify]", e);
    return NextResponse.json({ error: "read_failed", message: e instanceof Error ? e.message : "unknown" }, { status: 502 });
  }
}
