// src/app/api/credentials/issue/route.ts
// DEVNET-ONLY. Admin-gated. Issues XRPLScore as a native XLS-70 Credential.
//
// The XRPL endpoint is locked to Devnet inside src/lib/credentials.ts (hardcoded
// const + network_id guard). This route accepts NO endpoint/network parameter,
// so there is nothing to misconfigure toward mainnet.

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/adminAuth";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/xrplscore";
import { issueScoreCredential } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_ORIGIN = "https://www.xrplhub.io";

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { wallet?: string };
  const wallet = (body.wallet ?? "").trim();
  if (!isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address in { wallet }." },
      { status: 400 }
    );
  }

  // Prefer an existing paid signed-credential page for this wallet; otherwise
  // the URI falls back to the always-resolving live score endpoint.
  let verificationUri = `${PUBLIC_ORIGIN}/api/score/${wallet}`;
  try {
    const cred = await prisma.scoreCredential.findFirst({
      where: { walletAddress: wallet, status: "ISSUED", revoked: false },
      orderBy: { issuedAt: "desc" },
    });
    if (cred) verificationUri = `${PUBLIC_ORIGIN}/verify/${cred.certId}`;
  } catch {
    /* DB optional for the PoC */
  }

  try {
    const result = await issueScoreCredential(wallet, { verificationUri });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "issue failed";
    // A network-guard rejection ("REFUSING: ...") lands here as a 500 — by design.
    return NextResponse.json({ error: "issue_failed", message }, { status: 500 });
  }
}
