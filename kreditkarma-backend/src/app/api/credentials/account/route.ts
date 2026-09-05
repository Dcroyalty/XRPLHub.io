// src/app/api/credentials/account/route.ts
// GET /api/credentials/account?address=r... — every credential this account
// holds (as Subject), live from mainnet. Free, no signup.
//
// Deliberately LIVE, not indexed: this is the endpoint someone hits before
// trusting a counterparty. A stale "yes" for a since-revoked/expired
// credential is the one failure mode that actually hurts someone here, and
// account_objects for a single address is one cheap call — there's no
// performance reason to accept that risk. See src/lib/credentialLookup.ts.
import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/engine";
import { listCredentialsHeldBy } from "@/lib/credentialLookup";
import { scoreLink, verifyPageLink } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim() ?? "";
  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address (&address=r...)." },
      { status: 400 }
    );
  }

  try {
    const credentials = await listCredentialsHeldBy(address);
    // Relevant follow-ups: how does this account score, and — if it holds an
    // XRPLScore credential — where does it verify.
    const related = [scoreLink(address)];
    if (credentials.some((c) => c.credentialTypeDecoded.startsWith("io.xrplhub.score"))) {
      related.push(verifyPageLink(address));
    }
    return NextResponse.json({
      address,
      source: "live",
      count: credentials.length,
      credentials: credentials.map((c) => ({
        issuer: c.issuer,
        credentialType: c.credentialTypeDecoded,
        credentialTypeHex: c.credentialType,
        accepted: c.accepted,
        expired: c.expired,
        expirationISO: c.expirationISO,
        uri: c.uriDecoded,
      })),
      related,
    });
  } catch (err) {
    console.error("[credentials/account]", err);
    return NextResponse.json(
      { error: "lookup_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 }
    );
  }
}
