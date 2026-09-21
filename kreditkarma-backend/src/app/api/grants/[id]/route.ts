// src/app/api/grants/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const grant = await db.grantRequest.findUnique({
    where: { id },
    include: { ledgerScore: { select: { score: true, tier: true } } },
  });

  if (!grant) {
    return NextResponse.json({ error: "Grant not found" }, { status: 404 });
  }

  // Public status view: only what the applicant needs. Internal review columns are never returned.
  return NextResponse.json({
    id: grant.id,
    status: grant.status,
    category: grant.category,
    amountRequested: grant.amountRequested,
    approvedAmount: grant.approvedAmount,
    currency: grant.currency,
    urgency: grant.urgency,
    txHash: grant.txHash,
    paidAt: grant.paidAt,
    paidAmount: grant.paidAmount,
    scoreSnapshot: grant.scoreSnapshot,
    rejectionReason: grant.rejectionReason,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  });
}
