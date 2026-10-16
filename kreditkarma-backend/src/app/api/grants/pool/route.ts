// src/app/api/grants/pool/route.ts — the grants pool's live state, read from the XRP Ledger (public).
import { NextResponse } from "next/server";
import { readPool } from "@/lib/grantsPool";
import { GRANTS_POOL, FIRST_MILESTONE_XRP, FIRST_MILESTONE_GRANTS, LONG_TERM_GOAL_XRP } from "@/lib/grantsCopy";

export const runtime = "nodejs";
export const revalidate = 60;

export async function GET() {
  const p = await readPool();
  return NextResponse.json(
    { account: GRANTS_POOL, ...p, firstMilestone: { xrp: FIRST_MILESTONE_XRP, grants: FIRST_MILESTONE_GRANTS }, longTermGoalXrp: LONG_TERM_GOAL_XRP },
    { headers: { "Cache-Control": "public, s-maxage=60" } },
  );
}
