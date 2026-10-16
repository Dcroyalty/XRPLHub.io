// src/app/api/grants/updates/route.ts — the optional "email me updates" opt-in shown AFTER someone applies.
// POST { id } with the application id returned by /api/grants/submit. Stores the exact consent sentence.
// Separate from the application on purpose: applying never signs anyone up for anything.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { GRANT_UPDATES_CONSENT } from "@/lib/grantsPool";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rl = rateLimit(req, "grants-updates", 10, 60 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as { id?: unknown; optIn?: unknown };
  const id = String(b.id ?? "");
  if (!/^c[a-z0-9]{20,30}$/.test(id)) return NextResponse.json({ error: "Unknown application." }, { status: 400 });
  const optIn = b.optIn !== false;
  const r = await prisma.grantRequest.updateMany({ where: { id, round: "pool-2026" }, data: { updatesOptIn: optIn, updatesConsent: optIn ? GRANT_UPDATES_CONSENT : null } });
  if (!r.count) return NextResponse.json({ error: "Unknown application." }, { status: 404 });
  return NextResponse.json({ ok: true, optIn }, { headers: { "Cache-Control": "no-store" } });
}
