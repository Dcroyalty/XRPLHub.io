// src/app/api/yield/signup/route.ts — free "email me when a risk grade changes" list for the XRP Yield Desk.
//
// Stores the address (lower-cased, unique) with the exact consent sentence shown, and optionally one option's
// slug (alerts for just that option). Nothing is sent yet: XRPLHub has no email sender (RESEND_API_KEY unset);
// changes are kept in YieldGrade so emails can start from the first change after the sender is set up.
// The answer is the same whether or not the address was already on the list.
// Unsubscribe: GET /api/yield/signup?unsubscribe=<token>.
import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/freeKey";
import { YIELD_CONSENT } from "@/lib/yieldDesk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export async function POST(req: Request) {
  const rl = rateLimit(req, "yield-signup", 5, 60 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  let body: { email?: unknown; website?: unknown; slug?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Send JSON: {\"email\": \"you@example.com\"}." }, { status: 400 });
  }
  const done = NextResponse.json({ ok: true, message: "You're on the list. We'll email you when a grade changes." }, { headers: { "Cache-Control": "no-store" } });
  if (typeof body.website === "string" && body.website.trim()) return done; // honeypot
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return NextResponse.json({ ok: false, message: "That doesn't look like an email address." }, { status: 400 });
  let slug: string | null = null;
  if (typeof body.slug === "string" && body.slug) {
    if (!/^[a-z0-9-]{3,90}$/.test(body.slug) || !(await prisma.yieldOption.findUnique({ where: { slug: body.slug }, select: { slug: true } }))) {
      return NextResponse.json({ ok: false, message: "Unknown option." }, { status: 400 });
    }
    slug = body.slug;
  }
  const ipHash = createHash("sha256").update(clientIp(req)).digest("hex");
  await prisma.yieldSignup.upsert({
    where: { email },
    create: { email, slug, consentText: YIELD_CONSENT, unsubscribeToken: randomBytes(24).toString("hex"), ipHash },
    // Signing up again turns alerts back on; signing up from the main page widens alerts to every option.
    update: { unsubscribedAt: null, consentText: YIELD_CONSENT, ...(slug ? {} : { slug: null }) },
  });
  return done;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("unsubscribe") ?? "";
  if (!/^[0-9a-f]{48}$/.test(token)) return NextResponse.json({ ok: false, message: "Missing or malformed unsubscribe link." }, { status: 400 });
  const r = await prisma.yieldSignup.updateMany({ where: { unsubscribeToken: token, unsubscribedAt: null }, data: { unsubscribedAt: new Date() } });
  return new NextResponse(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Unsubscribed — XRPLHub</title><body style="font-family:system-ui;max-width:520px;margin:48px auto;padding:0 16px;line-height:1.5"><h1 style="font-size:22px">${r.count ? "You're unsubscribed." : "Already unsubscribed."}</h1><p>You won't get Yield Desk grade alerts. <a href="/yield">Back to the Yield Desk</a></p>`,
    { headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}
