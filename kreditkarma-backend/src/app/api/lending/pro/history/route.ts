// src/app/api/lending/pro/history/route.ts — Lending Pro: the full grade history of one vault or broker.
// GET ?type=vault|broker&id=<64 hex>&days=1..365 (default 90), Authorization: Bearer <uxus Lending Pro key>.
// Off until XRPL lending is enabled on mainnet.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { lendingLive } from "@/lib/lendingTracker";
import { lendingProAuth } from "@/lib/lendingPro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await lendingLive())) return NextResponse.json({ error: "lending_not_live", message: "XRPL lending isn't enabled on mainnet yet. Track it at https://www.xrplhub.io/lending." }, { status: 503 });
  const auth = await lendingProAuth(req);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized", message: auth.message }, { status: auth.status });
  const q = new URL(req.url).searchParams;
  const type = q.get("type");
  const id = (q.get("id") ?? "").toUpperCase();
  const days = Math.min(365, Math.max(1, Number(q.get("days") ?? 90) || 90));
  if ((type !== "vault" && type !== "broker") || !/^[0-9A-F]{64}$/.test(id)) {
    return NextResponse.json({ error: "bad_request", message: "type must be vault or broker, and id a 64-hex ledger ID." }, { status: 400 });
  }
  const rows = await prisma.lendingGrade.findMany({
    where: { network: "mainnet", subjectType: type, subjectId: id, takenAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { takenAt: "asc" },
    select: { grade: true, score: true, takenAt: true, metrics: true, methodVersion: true },
  });
  return NextResponse.json(
    {
      type, id, days, count: rows.length,
      history: rows.map((r) => ({ at: r.takenAt.toISOString(), grade: r.grade, score: r.score < 0 ? null : r.score, methodVersion: r.methodVersion, ...JSON.parse(r.metrics) })),
      disclaimer: "Risk grades from public XRP Ledger data. Not a credit rating, not investment advice.",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
