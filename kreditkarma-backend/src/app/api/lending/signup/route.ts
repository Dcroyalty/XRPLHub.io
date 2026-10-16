// src/app/api/lending/signup/route.ts — "Email me when XRPL lending goes live."
//
// Stores the address (lower-cased, unique) with the exact consent sentence shown on the page. Nothing is sent
// yet: XRPLHub has no email sender configured (RESEND_API_KEY unset). The answer is the same whether or not
// the address was already on the list, so the form can't be used to test who signed up.
// Unsubscribe: GET /api/lending/signup?unsubscribe=<token> (the token goes in every email we eventually send).
import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/freeKey";
import { LENDING_CONSENT } from "@/lib/lendingTracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export async function POST(req: Request) {
  const rl = rateLimit(req, "lending-signup", 5, 60 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  let body: { email?: unknown; website?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Send JSON: {\"email\": \"you@example.com\"}." }, { status: 400 });
  }
  // Honeypot: a hidden field people never fill in. Bots get the normal answer and nothing is stored.
  if (typeof body.website === "string" && body.website.trim()) return NextResponse.json({ ok: true, message: "You're on the list." });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) {
    return NextResponse.json({ ok: false, message: "That doesn't look like an email address." }, { status: 400 });
  }
  const ipHash = createHash("sha256").update(clientIp(req)).digest("hex");
  await prisma.lendingSignup.upsert({
    where: { email },
    create: { email, consentText: LENDING_CONSENT, unsubscribeToken: randomBytes(24).toString("hex"), ipHash },
    // Signing up again after unsubscribing turns the email back on.
    update: { unsubscribedAt: null, consentText: LENDING_CONSENT },
  });
  return NextResponse.json({ ok: true, message: "You're on the list. We'll email you once, when lending goes live." }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("unsubscribe") ?? "";
  if (!/^[0-9a-f]{48}$/.test(token)) return NextResponse.json({ ok: false, message: "Missing or malformed unsubscribe link." }, { status: 400 });
  const r = await prisma.lendingSignup.updateMany({ where: { unsubscribeToken: token, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
  return new NextResponse(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Unsubscribed — XRPLHub</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px;line-height:1.5"><h1 style="font-size:22px">${r.count ? "You're unsubscribed." : "Already unsubscribed."}</h1><p>You won't get the XRPL lending launch email. <a href="/lending">Back to the lending tracker</a></p>`,
    { headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
