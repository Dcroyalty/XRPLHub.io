// src/app/api/yield/options/route.ts — the Yield Desk as JSON (public; the same data the /yield pages show).
//   GET /api/yield/options            every listed option, best grade first
//   GET /api/yield/options?asset=XRP  only XRP (or RLUSD)
//   GET /api/yield/options?slug=...   one option (listed or not), with its grade history
// uxus.finance's paid yield_grade API reads this. Cached at the edge for 5 minutes.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { listYield, lastRefresh, parseStored } from "@/lib/yieldDesk";
import { DISCLAIMER, METHOD_VERSION } from "@/lib/yieldGrade";

export const runtime = "nodejs";
export const revalidate = 300;

const headers = { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600", "Access-Control-Allow-Origin": "*" };

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const base = { methodVersion: METHOD_VERSION, method: "https://www.xrplhub.io/yield/method", disclaimer: DISCLAIMER };
  if (slug) {
    if (!/^[a-z0-9-]{3,90}$/.test(slug)) return NextResponse.json({ error: "bad_slug" }, { status: 400, headers });
    const row = await prisma.yieldOption.findUnique({ where: { slug } });
    if (!row) return NextResponse.json({ error: "not_found", message: "No such option. List them at /api/yield/options." }, { status: 404, headers });
    const history = await prisma.yieldGrade.findMany({ where: { slug }, orderBy: { takenAt: "asc" }, take: 100, select: { grade: true, score: true, takenAt: true } });
    return NextResponse.json({ ...base, option: { ...parseStored(row.data), listed: row.listed, page: `https://www.xrplhub.io/yield/${slug}` }, gradeHistory: history }, { headers });
  }
  const a = url.searchParams.get("asset");
  const asset = a === "XRP" || a === "RLUSD" ? a : undefined;
  const [rows, refreshed] = await Promise.all([listYield(prisma, asset), lastRefresh(prisma)]);
  return NextResponse.json({ ...base, refreshedAt: refreshed?.toISOString() ?? null, count: rows.length, options: rows.map(({ o }) => ({ ...o, page: `https://www.xrplhub.io/yield/${o.slug}` })) }, { headers });
}
