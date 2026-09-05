// src/app/api/credentials/account/route.ts
// GET /api/credentials/account?address=r... — every credential this account
// holds (as Subject), live from mainnet. Free, no signup.
//
// Deliberately LIVE, not indexed: this is the endpoint someone hits before
// trusting a counterparty. A stale "yes" for a since-revoked/expired
// credential is the one failure mode that actually hurts someone here.
//
// Two paths:
//  • default — walk the account's owner directory for credential objects.
//    Fast for a normal account; for an exchange-scale account (tens of
//    thousands of trust lines) the walk is capped at ~20s and the response
//    says `complete: false` rather than hang. Never presents a truncated
//    walk as the whole picture.
//  • &issuer=r...[&type=<name|hex>] — targeted direct ledger_entry lookups,
//    no owner-directory walk. Always fast and always complete. For XRPLHub's
//    own issuer, all four score tiers are probed automatically. Use this
//    whenever you know which issuer you care about.
import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/engine";
import {
  listCredentialsHeldByDetailed,
  probeCredentials,
  type LiveCredential,
} from "@/lib/credentialLookup";
import { EXPECTED_ISSUER, CRED_NAMESPACE } from "@/lib/credentials";
import { scoreLink, verifyPageLink } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const XRPLHUB_TIERS = ["min750", "min700", "min650", "min600"].map((t) => `${CRED_NAMESPACE}.${t}`);

function shape(c: LiveCredential) {
  return {
    issuer: c.issuer,
    credentialType: c.credentialTypeDecoded,
    credentialTypeHex: c.credentialType,
    accepted: c.accepted,
    expired: c.expired,
    expirationISO: c.expirationISO,
    uri: c.uriDecoded,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim() ?? "";
  const issuer = url.searchParams.get("issuer")?.trim() ?? "";
  const type = url.searchParams.get("type")?.trim() ?? "";

  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address (&address=r...)." },
      { status: 400 }
    );
  }
  if (issuer && !isValidXrplAddress(issuer)) {
    return NextResponse.json(
      { error: "bad_request", message: "&issuer= must be a valid XRPL address." },
      { status: 400 }
    );
  }

  try {
    let credentials: LiveCredential[];
    let complete = true;
    let mode: "owner-walk" | "targeted";

    if (issuer) {
      mode = "targeted";
      const types = type
        ? [type]
        : issuer === EXPECTED_ISSUER
        ? XRPLHUB_TIERS
        : null;
      if (!types) {
        return NextResponse.json(
          {
            error: "bad_request",
            message:
              "For an issuer other than XRPLHub's, also pass &type=<credential type> (name or hex) so the lookup can be a direct ledger_entry check. Without &issuer= the endpoint walks the full owner directory.",
          },
          { status: 400 }
        );
      }
      const res = await probeCredentials(address, types.map((t) => ({ issuer, credentialType: t })));
      credentials = res.credentials;
    } else {
      mode = "owner-walk";
      const res = await listCredentialsHeldByDetailed(address);
      credentials = res.credentials;
      complete = res.complete;
    }

    const related = [scoreLink(address)];
    if (credentials.some((c) => c.credentialTypeDecoded.startsWith("io.xrplhub.score"))) {
      related.push(verifyPageLink(address));
    }

    return NextResponse.json({
      address,
      source: "live",
      lookup: mode,
      coverage: complete ? "complete" : "partial",
      complete,
      ...(complete
        ? {}
        : {
            warning:
              "This account's owner directory is too large to scan fully within the request budget. " +
              "The credentials listed are real but the list may be incomplete. For a definitive check, " +
              "re-query with &issuer=<the issuer you care about> (and &type= if it isn't XRPLHub's issuer) " +
              "— that path is a direct ledger lookup with no walk.",
          }),
      count: credentials.length,
      credentials: credentials.map(shape),
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
