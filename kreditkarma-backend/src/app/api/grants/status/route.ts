// src/app/api/grants/status/route.ts — applicants check their grant status by wallet address, and can PROPOSE payout
// details (a destination tag and/or a different wallet) while the application is pending or approved.
//   GET  ?wallet=r...                                   → their applications: status, amount, date, payout state
//   POST { wallet, id, destinationTag?, payoutWallet? } → stored as a proposal; the owner accepts it on /admin
// A wallet address is public, so this shows nothing private: no email, name or what they wrote.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/address";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { payoutReadiness, payoutTarget } from "@/lib/grantsPool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { PENDING: "Pending", REVIEWING: "Pending", APPROVED: "Approved", PAID: "Paid", REJECTED: "Denied", FAILED: "Approved" };
const EDITABLE = ["PENDING", "REVIEWING", "APPROVED"];
// What the applicant sees when an application is denied, keyed by rejectionReason (owner's wording).
const DENIED_NOTE: Record<string, string> = {
  "wallet-cannot-receive": "Denied: the wallet on file can't receive grants. You're welcome to apply again with your own wallet.",
};

export async function GET(req: Request) {
  const rl = rateLimit(req, "grants-status", 30, 10 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  const wallet = (new URL(req.url).searchParams.get("wallet") ?? "").trim();
  if (!isValidXrplAddress(wallet)) return NextResponse.json({ error: "Enter a valid XRP Ledger address (starts with r)." }, { status: 400 });
  const rows = await prisma.grantRequest.findMany({
    where: { OR: [{ walletAddress: wallet }, { payoutAddress: wallet }], round: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const applications = await Promise.all(rows.map(async (g) => {
    const amount = g.approvedAmount ?? g.amountRequested;
    const t = payoutTarget(g);
    const ready = EDITABLE.includes(g.status)
      ? await payoutReadiness(t.address, t.tag, amount).catch(() => ({ ready: false, reason: "couldn't check the ledger right now" }))
      : null;
    return {
      id: g.id,
      status: LABEL[g.status] ?? g.status,
      amountUsd: amount,
      currency: "RLUSD",
      appliedAt: g.createdAt.toISOString(),
      paidAt: g.paidAt?.toISOString() ?? null,
      payout: { address: t.address, destinationTag: t.tag, ready: ready?.ready ?? null, note: ready?.reason ?? null },
      proposed: g.proposedAt ? { address: g.proposedPayoutAddress, destinationTag: g.proposedPayoutTag, at: g.proposedAt.toISOString() } : null,
      canEditPayout: EDITABLE.includes(g.status),
      deniedNote: g.status === "REJECTED" ? DENIED_NOTE[g.rejectionReason ?? ""] ?? "Denied." : null,
    };
  }));
  return NextResponse.json({ applications }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = rateLimit(req, "grants-status-edit", 10, 60 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as { wallet?: unknown; id?: unknown; destinationTag?: unknown; payoutWallet?: unknown };
  const wallet = String(b.wallet ?? "").trim();
  const id = String(b.id ?? "");
  const tag = b.destinationTag == null || b.destinationTag === "" ? null : Number(b.destinationTag);
  const payoutWallet = b.payoutWallet == null || b.payoutWallet === "" ? null : String(b.payoutWallet).trim();
  if (tag != null && (!Number.isInteger(tag) || tag < 0 || tag > 4294967295)) return NextResponse.json({ error: "A destination tag is a whole number (up to 10 digits)." }, { status: 400 });
  if (payoutWallet && !isValidXrplAddress(payoutWallet)) return NextResponse.json({ error: "The new wallet isn't a valid XRP Ledger address." }, { status: 400 });
  if (tag == null && !payoutWallet) return NextResponse.json({ error: "Add a destination tag, a different wallet, or both." }, { status: 400 });
  const g = await prisma.grantRequest.findFirst({ where: { id, walletAddress: wallet } });
  if (!g) return NextResponse.json({ error: "No application with that wallet." }, { status: 404 });
  if (!EDITABLE.includes(g.status)) return NextResponse.json({ error: "Payout details can only be changed while an application is pending or approved." }, { status: 409 });
  await prisma.grantRequest.update({
    where: { id },
    data: { proposedPayoutAddress: payoutWallet ?? g.payoutAddress ?? g.walletAddress, proposedPayoutTag: tag, proposedAt: new Date() },
  });
  return NextResponse.json({ ok: true, message: "Thanks. We'll confirm these payout details before paying." }, { headers: { "Cache-Control": "no-store" } });
}
