// src/app/api/domains/eligible/route.ts
// GET /api/domains/eligible?address=r...&domain=<DomainID hex> — does this
// account hold a credential that satisfies this permissioned domain? Free,
// no signup.
//
// Live, same as /api/credentials/account and for the same reason: this is a
// yes/no gating question people act on immediately (before a real
// transaction into a permissioned venue). domain= is the raw DomainID — the
// PermissionedDomain object's own 256-bit ledger index, same kind of opaque
// identifier as an NFTokenID or escrow ID (SHA-512Half of a space key + the
// domain's Owner + creating Sequence, per XLS-80d) — looked up directly via
// ledger_entry's generic `index` field.
import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/engine";
import { checkDomainEligibility } from "@/lib/credentialLookup";
import { scoreLink, credentialsAccountLink } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOMAIN_ID_RE = /^[0-9A-Fa-f]{64}$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim() ?? "";
  const domain = url.searchParams.get("domain")?.trim().toUpperCase() ?? "";

  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address (&address=r...)." },
      { status: 400 }
    );
  }
  if (!DOMAIN_ID_RE.test(domain)) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: "Provide a valid DomainID (&domain=<64 hex chars>) — the PermissionedDomain object's ledger index.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await checkDomainEligibility(address, domain);
    return NextResponse.json({
      address: result.address,
      domain: result.domain.domainId,
      domainFound: result.domain.found,
      domainOwner: result.domain.owner ?? null,
      eligible: result.eligible,
      reason: result.reason,
      satisfiedBy: result.satisfiedBy
        ? {
            issuer: result.satisfiedBy.issuer,
            credentialType: result.satisfiedBy.credentialTypeDecoded,
            credentialTypeHex: result.satisfiedBy.credentialType,
            expirationISO: result.satisfiedBy.expirationISO,
          }
        : null,
      acceptedCredentials: result.domain.acceptedCredentials ?? [],
      heldCredentials: result.heldCredentials.map((c) => ({
        issuer: c.issuer,
        credentialType: c.credentialTypeDecoded,
        credentialTypeHex: c.credentialType,
        accepted: c.accepted,
        expired: c.expired,
      })),
      // Eligibility is a yes/no; the follow-up is always "so is this account
      // trustworthy" and "what else does it hold".
      related: [scoreLink(address), credentialsAccountLink(address)],
    });
  } catch (err) {
    console.error("[domains/eligible]", err);
    return NextResponse.json(
      { error: "lookup_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 }
    );
  }
}
