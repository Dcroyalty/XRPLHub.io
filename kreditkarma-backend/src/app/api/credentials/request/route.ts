// src/app/api/credentials/request/route.ts
// "We issue, they accept."
//
// POST /api/credentials/request { "subject": "r…" }
//   A wallet asks for its XRPLScore credential. We score it FRESH (never the display cache); if it clears the 600 floor we QUEUE a
//   request for the tier its score earns. Nothing is put on the ledger here — an operator issues queued requests from the offline
//   issuer key (scripts/issue-queued-credentials.cjs), which re-scores again at issuance and refuses if the tier changed.
//   Free. Below the floor, or an account not activated on mainnet: no request, no ledger object, no reserve.
//
// GET  /api/credentials/request?subject=r…
//   Where the request stands, and — once the credential exists on-ledger but is not yet accepted — the UNSIGNED CredentialAccept
//   transaction the subject signs with their own wallet. (Free: it is part of the credential flow, not a sold service.)
//
// Unsigned only: we never sign for a subject and never hold their keys. A credential that is not accepted satisfies no domain.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/address";
import { EXPECTED_ISSUER, ScoreNotEligibleError, UNSOLICITED_DISCLOSURE, ELIGIBILITY_FLOOR, credentialType, planScoreCredential, type ScoreTier } from "@/lib/credentials";
import { SCORE_TIERS } from "@/lib/domainKit";
import { probeCredentials } from "@/lib/credentialLookup";
import { XrplUnavailableError } from "@/lib/xrplscore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PER_IP_PER_DAY = 15; // new requests per source per rolling 24h
const MAX_QUEUED = 500; // total open queue; beyond it we stop accepting until an operator drains it

const typeHex = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();

function ipHashOf(req: Request): string {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`${ip}|${new Date().toISOString().slice(0, 10)}`).digest("hex").slice(0, 32);
}

/** The credential(s) this subject holds from our issuer, live from the validated ledger. */
async function heldFromUs(subject: string) {
  const { credentials, nowRipple } = await probeCredentials(subject, SCORE_TIERS.map((t) => ({ issuer: EXPECTED_ISSUER, credentialType: credentialType(t as ScoreTier) })));
  return credentials.map((c) => ({ tier: c.credentialTypeDecoded.split(".").pop(), credentialType: c.credentialTypeDecoded, accepted: c.accepted, expired: c.expired, expiresAt: c.expirationISO, _typeHex: c.credentialType, _nowRipple: nowRipple }));
}

function acceptTx(subject: string, typeHexValue: string) {
  return { TransactionType: "CredentialAccept", Account: subject, Issuer: EXPECTED_ISSUER, CredentialType: typeHexValue };
}

const NEXT = {
  accept: "Sign the CredentialAccept above with the SAME wallet (Xaman, Crossmark or GemWallet, or any XRPL signer), then check GET /api/domains/eligible?address=<wallet>&domain=<DomainID>.",
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { subject?: unknown };
  const subject = String(body.subject ?? "").trim();
  if (!isValidXrplAddress(subject)) return NextResponse.json({ error: "bad_request", message: 'Send { "subject": "r…" } — a valid XRPL address.' }, { status: 400 });
  if (subject === EXPECTED_ISSUER) return NextResponse.json({ error: "bad_request", message: "The issuer account cannot hold its own credential." }, { status: 400 });

  // Already have one?
  try {
    const held = (await heldFromUs(subject)).filter((h) => !h.expired);
    if (held.length) {
      const best = held[held.length - 1];
      return NextResponse.json({
        status: best.accepted ? "already_held" : "issued_awaiting_acceptance",
        subject,
        held: held.map(({ _typeHex, _nowRipple, ...h }) => h),
        ...(best.accepted ? {} : { acceptTransaction: acceptTx(subject, best._typeHex), next: NEXT.accept }),
        message: best.accepted ? "This wallet already holds an accepted, unexpired XRPLScore credential." : "A credential for this wallet is on the ledger but not accepted yet — sign the CredentialAccept.",
      });
    }
  } catch {
    // ledger read failed: fall through — the operator's issuance step re-checks before creating anything
  }

  const open = await prisma.credentialRequest.findFirst({ where: { subject, status: "queued" }, orderBy: { requestedAt: "desc" } });
  if (open) {
    return NextResponse.json({ status: "queued", requestId: open.id, subject, tier: open.tier, credentialType: open.credentialType, requestedAt: open.requestedAt.toISOString(), message: "Your request is already queued. Check back with GET /api/credentials/request?subject=…" });
  }

  const ipHash = ipHashOf(req);
  const [recent, queued] = await Promise.all([
    prisma.credentialRequest.count({ where: { ipHash, requestedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.credentialRequest.count({ where: { status: "queued" } }),
  ]);
  if (recent >= PER_IP_PER_DAY) return NextResponse.json({ error: "rate_limited", message: "Too many requests from this source today. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "86400" } });
  if (queued >= MAX_QUEUED) return NextResponse.json({ error: "queue_full", message: "The credential queue is full right now; requests reopen as it is processed." }, { status: 503, headers: { "Retry-After": "86400" } });

  // Fresh score — the tier must be true now. (planScoreCredential scores live; it never reads the 15-minute display cache.)
  try {
    const plan = await planScoreCredential(subject);
    const row = await prisma.credentialRequest.create({
      data: { subject, tier: plan.tier, credentialType: plan.credentialType, scoreAtRequest: plan.score, ipHash },
    });
    return NextResponse.json(
      {
        status: "queued",
        requestId: row.id,
        subject,
        score: plan.score,
        tier: plan.tier,
        credentialType: plan.credentialType,
        validityDays: 90,
        message: `Queued. Your wallet scored ${plan.score} just now, which earns ${plan.credentialType}. A person issues queued credentials from an offline key and re-checks your score at that moment; if it no longer earns this tier nothing is issued.`,
        whatHappensNext: [
          "We issue: a CredentialCreate from our issuer wallet puts the credential on the ledger as PENDING (a pending credential satisfies no domain).",
          "You accept: GET /api/credentials/request?subject=<your wallet> then returns the unsigned CredentialAccept; sign it with the same wallet. Accepting moves the 0.2 XRP owner reserve from us to you.",
          "It expires 90 days after issuance; re-request then if you still qualify.",
        ],
        disclosure: UNSOLICITED_DISCLOSURE.replace("The subject did not request it, has not accepted it", "This credential was requested by the subject and is not effective until they accept it"),
      },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof ScoreNotEligibleError) {
      return NextResponse.json({ status: "not_eligible", subject, score: e.score, floor: ELIGIBILITY_FLOOR, message: e.message, note: "Nothing was queued and nothing was put on the ledger." }, { status: 200 });
    }
    if (e instanceof XrplUnavailableError) return NextResponse.json({ error: "ledger_unavailable", message: "Could not read the XRP Ledger just now; nothing was queued. Try again shortly." }, { status: 503, headers: { "Retry-After": "60" } });
    return NextResponse.json({ error: "request_failed", message: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const subject = (new URL(req.url).searchParams.get("subject") ?? "").trim();
  if (!isValidXrplAddress(subject)) return NextResponse.json({ error: "bad_request", message: "Provide ?subject=r… (a valid XRPL address)." }, { status: 400 });

  const [latest, held] = await Promise.all([
    prisma.credentialRequest.findFirst({ where: { subject }, orderBy: { requestedAt: "desc" } }),
    heldFromUs(subject).catch(() => null),
  ]);
  const live = held?.filter((h) => !h.expired) ?? [];
  const best = live.length ? live[live.length - 1] : null;

  if (best && !best.accepted) {
    return NextResponse.json({
      status: "issued_awaiting_acceptance",
      subject,
      credentialType: best.credentialType,
      expiresAt: best.expiresAt,
      acceptTransaction: acceptTx(subject, best._typeHex),
      signWith: subject,
      next: NEXT.accept,
      unsignedOnly: "XRPLHub never signs for you. Check that Account equals your wallet and Issuer equals " + EXPECTED_ISSUER + ".",
    });
  }
  if (best && best.accepted) {
    return NextResponse.json({ status: "held", subject, credentialType: best.credentialType, expiresAt: best.expiresAt, next: "Check a domain: GET /api/domains/eligible?address=<wallet>&domain=<DomainID>" });
  }
  if (!latest) return NextResponse.json({ status: "none", subject, message: "No request on file. POST /api/credentials/request { subject } to ask for one.", ledgerRead: held === null ? "unavailable" : "ok" });
  return NextResponse.json({
    status: latest.status,
    subject,
    tier: latest.tier,
    credentialType: latest.credentialType,
    requestedAt: latest.requestedAt.toISOString(),
    issuedAt: latest.issuedAt ? latest.issuedAt.toISOString() : null,
    issuedTxHash: latest.issuedTxHash,
    note: latest.note,
    message:
      latest.status === "queued"
        ? "Queued for issuance by a person; nothing for you to sign yet."
        : latest.status === "issued"
          ? "Issued, but the credential is not visible on the validated ledger yet (or has expired). Re-check shortly."
          : "This request was not issued. You can request again.",
  });
}
