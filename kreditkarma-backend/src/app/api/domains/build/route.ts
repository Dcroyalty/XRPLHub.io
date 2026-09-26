// src/app/api/domains/build/route.ts
// GET|POST /api/domains/build — the front door for an institution that wants a Permissioned Domain (XLS-80) gated on XRPLScore
// credentials (issuer rmWjCGe…, io.xrplhub.score.v1.<tier>).
//
//   account    the institution's domain-owner account (the signer)               required
//   minTier    lowest tier to admit: min600 | min650 | min700 | min750           required
//   alsoAccept other credentials to accept: [{issuer, credentialType}] (POST) or "rIssuer:type,rIssuer:type"   optional
//   domainId   64-hex DomainID of a domain you own, to UPDATE it; omit to create   optional
//
// FREE: validates the choice and returns the PLAN — exactly which (issuer, CredentialType) pairs the domain will accept, what it
// costs to create, what members must do — and the paid resource that delivers the transaction. The signable PermissionedDomainSet
// itself is the storefront service `permdomain` and is sold, never given away: it is delivered by /api/x402/tx at the storefront
// price (USDC on Base or RLUSD on XRPL, one price for every rail) or by the storefront checkout. Unsigned only: XRPLHub builds the
// transaction, the institution signs it with its own wallet; we never sign, submit or hold keys.

import { NextResponse } from "next/server";
import { planScoreDomain, DOMAIN_KIT_NOTES, MEMBER_STEPS, SCORE_TIERS, TIER_FLOOR, tiersFrom } from "@/lib/domainKit";
import { paymentResourceUrl, priceInfo, type Primitive } from "@/lib/txPurchase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const ORIGIN = "https://www.xrplhub.io";

function respond(input: { account?: unknown; minTier?: unknown; alsoAccept?: unknown; domainId?: unknown }) {
  const account = String(input.account ?? "").trim();
  if (!account && !input.minTier) {
    // Discovery: no input yet — say what the choices are.
    return NextResponse.json({
      endpoint: "GET|POST /api/domains/build",
      params: { account: "domain-owner XRPL address (required)", minTier: "min600 | min650 | min700 | min750 (required)", alsoAccept: "optional: other accepted credentials (10 in total)", domainId: "optional: update an existing domain you own" },
      tiers: SCORE_TIERS.map((t) => ({ tier: t, meaning: `XRPLScore was at least ${TIER_FLOOR[t]} at issuance`, domainAccepts: tiersFrom(t) })),
      guide: `${ORIGIN}/api/domains/guide`,
      notes: DOMAIN_KIT_NOTES,
    });
  }
  const plan = planScoreDomain({ owner: account, minTier: input.minTier, alsoAccept: input.alsoAccept, domainId: input.domainId });
  if (!plan.ok) return NextResponse.json({ error: "bad_request", message: plan.error, ...(plan.needs ? { needs: plan.needs } : {}) }, { status: 400 });

  const params: Record<string, Primitive> = { minTier: plan.minTier };
  if (input.alsoAccept !== undefined && input.alsoAccept !== "") {
    params.alsoAccept = typeof input.alsoAccept === "string" ? input.alsoAccept : plan.accepted.filter((a) => a.issuer !== DOMAIN_KIT_NOTES.issuer).map((a) => `${a.issuer}:${a.credentialType}`).join(",");
  }
  if (plan.updatesDomainId) params.domainId = plan.updatesDomainId;

  return NextResponse.json(
    {
      free: true,
      unsignedOnly: "XRPLHub builds the transaction; you sign it with your own wallet. XRPLHub never signs, submits or holds keys.",
      plan: {
        action: plan.updatesDomainId ? "update an existing Permissioned Domain (PermissionedDomainSet with DomainID)" : "create a new Permissioned Domain (PermissionedDomainSet)",
        owner: plan.owner,
        admits: `wallets holding an accepted, unexpired XRPLScore credential of tier ${plan.minTier} or higher (XRPLScore ≥ ${plan.scoreFloor} at issuance)`,
        acceptedCredentials: plan.accepted.map((a) => ({ issuer: a.issuer, credentialType: a.credentialType, credentialTypeHex: a.credentialTypeHex })),
        acceptedCount: plan.accepted.length,
        maxAccepted: 10,
        why: DOMAIN_KIT_NOTES.highestTierOnly,
        cost: DOMAIN_KIT_NOTES.reserve,
      },
      readiness: {
        membersToday: "A domain gated on our credentials has as many members as there are wallets that have REQUESTED and ACCEPTED one. Our only credential issued to date is unaccepted, so a domain created today starts with zero members. Point your members at the request flow below.",
        memberSteps: MEMBER_STEPS,
        requestFlow: `${ORIGIN}/api/credentials/request`,
        eligibilityCheck: `${ORIGIN}/api/domains/eligible?address=<wallet>&domain=<DomainID>`,
        afterCreating: "Read the new domain's DomainID from the validated transaction's metadata (the created PermissionedDomain node's LedgerIndex), then use it in the eligibility check above.",
      },
      transaction: null,
      getTheTransaction: {
        service: "permdomain",
        price: priceInfo("permdomain"),
        paidResource: paymentResourceUrl(ORIGIN, "permdomain", plan.owner, params),
        how: "GET the paidResource with an x402 client (USDC on Base or RLUSD on XRPL): you are charged only if the transaction builds. The response holds the unsigned PermissionedDomainSet. Or buy it in the storefront at xrplhub.io. Check that its Account equals your owner account, then sign with your own wallet.",
      },
      guide: `${ORIGIN}/api/domains/guide`,
      notes: DOMAIN_KIT_NOTES,
      disclaimer: DOMAIN_KIT_NOTES.notAdvice,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  return respond({ account: u.get("account") ?? u.get("owner"), minTier: u.get("minTier"), alsoAccept: u.get("alsoAccept"), domainId: u.get("domainId") });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return respond({ account: b.account ?? b.owner, minTier: b.minTier, alsoAccept: b.alsoAccept, domainId: b.domainId });
}
