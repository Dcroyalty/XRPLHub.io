// src/app/api/yield/visit/route.ts — counts /yield page visits per day and path (YieldPageView). Nothing personal
// is stored: no IP, no cookie, no user agent. Rate-limited per IP in memory so one client can't inflate counts.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = /^\/yield(\/[a-z0-9-]{1,90})?$/;

export async function POST(req: Request) {
  if (!rateLimit(req, "yield-visit", 60, 60 * 60_000).ok) return new NextResponse(null, { status: 204 });
  let path = "";
  try {
    path = String(((await req.json()) as { path?: unknown }).path ?? "");
  } catch { /* ignore */ }
  if (!PATH.test(path)) return new NextResponse(null, { status: 204 });
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  await prisma.yieldPageView.upsert({ where: { day_path: { day, path } }, create: { day, path, count: 1 }, update: { count: { increment: 1 } } }).catch(() => {});
  return new NextResponse(null, { status: 204 });
}
