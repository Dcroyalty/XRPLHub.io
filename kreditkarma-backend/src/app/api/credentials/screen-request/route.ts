// src/app/api/credentials/screen-request/route.ts
// "We issue, they accept" — for io.xrplhub.screen.v2.nomatch, not io.xrplhub.score.v1.*. See src/lib/screenCredential.ts.
//
// POST /api/credentials/screen-request { "subject": "r…" }
//   Screens the XRP Ledger address FRESH, right now, against every sanctions list. If it appears on any of them,
//   nothing is queued (200, not_eligible) — a screening receipt is still written either way (screening always writes
//   one; see the queryId in the response). If it does not appear, a credential request is QUEUED (202) for an
//   operator to issue from the offline key later, which re-screens again at that moment and refuses if the address
//   is listed by then. Free. Opt-in only — this is never issued unsolicited.
//
// GET /api/credentials/screen-request?subject=r…
//   Where the request stands, and — once the credential exists on-ledger but is not yet accepted — the unsigned
//   CredentialAccept transaction the subject signs with their own wallet.
//
// Unsigned only: we never sign for a subject and never hold their keys. This credential attests to PROCESS: a "no
// match" is not a statement that the address is clean, safe, or unsanctioned. See src/lib/screen.ts SCREEN_DISCLAIMER_SHORT.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/address";
import { EXPECTED_ISSUER } from "@/lib/credentials";
import { probeCredentials } from "@/lib/credentialLookup";
import { SCREEN_NOMATCH_TYPE, SCREEN_NOMATCH_TYPE_HEX, SCREEN_CRED_VALIDITY_DAYS, SCREEN_CRED_STATEMENT_NOTE, ScreenCredListedError, requestScreenCredential } from "@/lib/screenCredential";
import { SCREEN_DISCLAIMER_SHORT, ListUnavailableError } from "@/lib/screen";
import { VERIFY_BASE } from "@/lib/screenView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PER_IP_PER_DAY = 15;
const MAX_QUEUED = 500;

function ipHashOf(req: Request): string {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`${ip}|${new Date().toISOString().slice(0, 10)}`).digest("hex").slice(0, 32);
}

async function heldFromUs(subject: string) {
  const { credentials } = await probeCredentials(subject, [{ issuer: EXPECTED_ISSUER, credentialType: SCREEN_NOMATCH_TYPE }]);
  return credentials.map((c) => ({ credentialType: c.credentialTypeDecoded, accepted: c.accepted, expired: c.expired, expiresAt: c.expirationISO }));
}

function acceptTx(subject: string) {
  return { TransactionType: "CredentialAccept", Account: subject, Issuer: EXPECTED_ISSUER, CredentialType: SCREEN_NOMATCH_TYPE_HEX };
}

const NEXT_ACCEPT = "Sign the CredentialAccept above with the SAME wallet, then it can be used to gate a Permissioned Domain (see GET /api/domains/eligible).";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { subject?: unknown };
  const subject = String(body.subject ?? "").trim();
  if (!isValidXrplAddress(subject)) {
    return NextResponse.json({ error: "bad_request", message: 'Send { "subject": "r…" } — a valid XRP Ledger address. Screening covers EVM/Bitcoin/Tron too, but a Credential can only be issued to an XRPL account.' }, { status: 400 });
  }
  if (subject === EXPECTED_ISSUER) return NextResponse.json({ error: "bad_request", message: "The issuer account cannot hold its own credential." }, { status: 400 });

  const held = (await heldFromUs(subject).catch(() => [])).filter((h) => !h.expired);
  if (held.length) {
    const best = held[held.length - 1];
    return NextResponse.json({
      status: best.accepted ? "already_held" : "issued_awaiting_acceptance",
      subject,
      held,
      ...(best.accepted ? {} : { acceptTransaction: acceptTx(subject), next: NEXT_ACCEPT }),
      message: best.accepted ? "This wallet already holds an accepted, unexpired screening credential." : "A credential for this wallet is on the ledger but not accepted yet — sign the CredentialAccept.",
    });
  }

  const ipHash = ipHashOf(req);
  const [recent, queued] = await Promise.all([
    prisma.credentialRequest.count({ where: { ipHash, kind: "screen-nomatch", requestedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.credentialRequest.count({ where: { kind: "screen-nomatch", status: "queued" } }),
  ]);
  if (recent >= PER_IP_PER_DAY) return NextResponse.json({ error: "rate_limited", message: "Too many requests from this source today. Try again tomorrow." }, { status: 429, headers: { "Retry-After": "86400" } });
  if (queued >= MAX_QUEUED) return NextResponse.json({ error: "queue_full", message: "The credential queue is full right now; requests reopen as it is processed." }, { status: 503, headers: { "Retry-After": "86400" } });

  try {
    const r = await requestScreenCredential(prisma, subject);
    if (!r.reused) await prisma.credentialRequest.update({ where: { id: r.requestId }, data: { ipHash } }).catch(() => {});
    return NextResponse.json(
      {
        status: "queued",
        requestId: r.requestId,
        reusedExistingRequest: r.reused,
        subject,
        credentialType: SCREEN_NOMATCH_TYPE,
        validityDays: SCREEN_CRED_VALIDITY_DAYS,
        screeningReceipt: { queryId: r.outcome.queryId, statement: r.outcome.statement, verify: `${VERIFY_BASE}${r.outcome.queryId}` },
        message: `Queued. This address did not appear on any list just now (queryId ${r.outcome.queryId}). A person issues queued credentials from an offline key and re-screens at that moment; if it is listed by then, nothing is issued.`,
        whatHappensNext: [
          "We issue: a CredentialCreate from our issuer wallet puts the credential on the ledger as PENDING (a pending credential satisfies no domain).",
          "You accept: GET /api/credentials/screen-request?subject=<your wallet> then returns the unsigned CredentialAccept; sign it with the same wallet.",
          `It expires ${SCREEN_CRED_VALIDITY_DAYS} days after issuance — sanctions lists change; re-request then if you want to stay covered.`,
        ],
        disclosure: SCREEN_CRED_STATEMENT_NOTE,
        disclaimer: SCREEN_DISCLAIMER_SHORT,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof ScreenCredListedError) {
      return NextResponse.json(
        {
          status: "not_eligible",
          subject,
          message: e.message,
          screeningReceipt: { queryId: e.outcome.queryId, statement: e.outcome.statement, verify: `${VERIFY_BASE}${e.outcome.queryId}` },
          note: "Nothing was queued and nothing was put on the ledger. The screening receipt above was still recorded and anchored, like every screen.",
        },
        { status: 200 }
      );
    }
    if (e instanceof ListUnavailableError) return NextResponse.json({ error: "not_ready", message: e.message }, { status: 503, headers: { "Retry-After": "3600" } });
    return NextResponse.json({ error: "request_failed", message: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const subject = (new URL(req.url).searchParams.get("subject") ?? "").trim();
  if (!isValidXrplAddress(subject)) return NextResponse.json({ error: "bad_request", message: "Provide ?subject=r… (a valid XRPL address)." }, { status: 400 });

  const [latest, held] = await Promise.all([
    prisma.credentialRequest.findFirst({ where: { subject, kind: "screen-nomatch" }, orderBy: { requestedAt: "desc" } }),
    heldFromUs(subject).catch(() => null),
  ]);
  const live = (held ?? []).filter((h) => !h.expired);
  const best = live.length ? live[live.length - 1] : null;

  if (best && !best.accepted) {
    return NextResponse.json({ status: "issued_awaiting_acceptance", subject, credentialType: best.credentialType, expiresAt: best.expiresAt, acceptTransaction: acceptTx(subject), signWith: subject, next: NEXT_ACCEPT, unsignedOnly: "XRPLHub never signs for you. Check that Account equals your wallet and Issuer equals " + EXPECTED_ISSUER + "." });
  }
  if (best && best.accepted) {
    return NextResponse.json({ status: "held", subject, credentialType: best.credentialType, expiresAt: best.expiresAt, next: "Check a domain: GET /api/domains/eligible?address=<wallet>&domain=<DomainID>" });
  }
  if (!latest) return NextResponse.json({ status: "none", subject, message: "No request on file. POST /api/credentials/screen-request { subject } to ask for one.", ledgerRead: held === null ? "unavailable" : "ok" });
  return NextResponse.json({
    status: latest.status,
    subject,
    credentialType: latest.credentialType,
    subjectRef: latest.subjectRef,
    requestedAt: latest.requestedAt.toISOString(),
    issuedAt: latest.issuedAt ? latest.issuedAt.toISOString() : null,
    issuedTxHash: latest.issuedTxHash,
    note: latest.note,
    message: latest.status === "queued" ? "Queued for issuance by a person; nothing for you to sign yet." : latest.status === "issued" ? "Issued, but the credential is not visible on the validated ledger yet (or has expired). Re-check shortly." : "This request was not issued. You can request again.",
  });
}
