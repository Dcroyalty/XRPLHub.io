// src/app/api/cron/index-mpts/route.ts
// Scheduled refresh of the MPTokenIssuance registry (src/lib/mptIndexer.ts).
// One call = one bounded chunk: a slice of the Bithomp per-issuer refresh
// (round-robined, stalest first) plus however far the ledger_data walk gets
// in the remaining budget. Registered in vercel.json under `crons`.
//
// Auth: Vercel's cron dispatcher sends `Authorization: Bearer $CRON_SECRET`
// automatically once CRON_SECRET is set. No secret set => this route 401s and
// does nothing (fails closed). The admin token also works for a manual kick.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runMptIndexerPass } from "@/lib/mptIndexer";
import { isAdmin } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAdmin(req) && !isCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const progress = await runMptIndexerPass(prisma, { budgetMs: 50_000 });
    return NextResponse.json(progress);
  } catch (err) {
    console.error("[cron/index-mpts]", err);
    return NextResponse.json(
      { error: "indexer_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
