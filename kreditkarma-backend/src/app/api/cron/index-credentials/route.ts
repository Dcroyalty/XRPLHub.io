// src/app/api/cron/index-credentials/route.ts
// Scheduled trigger for the Credential census (src/lib/credentialIndexer.ts).
// One call = one bounded chunk of a walk, not a full pass — see that file for
// why. Registered in vercel.json under `crons`; Vercel Hobby only allows a
// once-daily schedule and each invocation is capped by maxDuration below, so
// getting to the FIRST complete pass quickly means hand-running
// scripts/census-credentials.cjs rather than waiting on the daily cron.
//
// Auth: Vercel's own cron dispatcher sends `Authorization: Bearer $CRON_SECRET`
// automatically once CRON_SECRET is set in the project's env — set it in
// Vercel or this route 401s and does nothing. The admin token also works, for
// manually kicking a pass forward without waiting on the schedule.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runIndexerPass } from "@/lib/credentialIndexer";
import { isAdmin } from "@/lib/adminAuth";
import { notifyError } from "@/lib/notify";
import { refreshSdnSnapshot } from "@/lib/ofac";
import { maybeAnchorScreeningReceipts } from "@/lib/screenAnchor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — no secret configured means no cron auth path
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAdmin(req) && !isCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    // Credential census gets the bulk of the budget; the OFAC steps below are a
    // cheap no-op on the ~360 days/yr the SDN Publish_Date is unchanged at cron
    // time, and one AccountSet (~10 drops) when there are receipts to anchor.
    const progress = await runIndexerPass(prisma, { budgetMs: 30_000 });

    const sdn = await refreshSdnSnapshot(prisma).catch((e) => ({
      action: "blocked-error" as const,
      listName: "OFAC-SDN",
      detail: e instanceof Error ? e.message : "refresh threw",
    }));

    const screeningAnchor = await maybeAnchorScreeningReceipts(prisma).catch((e) => {
      void notifyError("cron/index-credentials screening-anchor", e);
      return { attempted: false, submitted: false, reason: "anchor threw", leafCount: 0 };
    });

    return NextResponse.json({ ...progress, sdn, screeningAnchor });
  } catch (err) {
    await notifyError("cron/index-credentials", err);
    console.error("[cron/index-credentials]", err);
    return NextResponse.json(
      { error: "indexer_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
