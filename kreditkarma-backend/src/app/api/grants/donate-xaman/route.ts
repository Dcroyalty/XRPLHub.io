// src/app/api/grants/donate-xaman/route.ts — a Xaman payment request straight to the grants pool.
// POST { amount, currency: "XRP" | "RLUSD" } → { uuid, qr_png, deep_link }. The donor signs in their own Xaman;
// XRPLHub never touches the money. RLUSD is refused until the pool has an RLUSD trust line on the ledger.
import { NextResponse } from "next/server";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { GRANTS_POOL, readPool } from "@/lib/grantsPool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

export async function POST(req: Request) {
  const rl = rateLimit(req, "grants-donate-xaman", 10, 60_000);
  if (!rl.ok) return rateLimited(rl);
  if (!xummConfigured()) return NextResponse.json({ error: "Xaman isn't available right now. Send to the address shown instead." }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { amount?: unknown; currency?: unknown };
  const currency = b.currency === "RLUSD" ? "RLUSD" : "XRP";
  const n = Number(b.amount);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });
  if (currency === "RLUSD" && !(await readPool()).rlusd.enabled) {
    return NextResponse.json({ error: "The grants pool doesn't accept RLUSD yet (no RLUSD trust line). Please donate XRP." }, { status: 409 });
  }
  const value = currency === "XRP" ? String(Math.round(n * 1_000_000)) : { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: String(n) };
  try {
    const p = await createPayload({
      txjson: { TransactionType: "Payment", Destination: GRANTS_POOL, Amount: value, Memos: [{ Memo: { MemoType: hex("xrplhub/purpose"), MemoData: hex("grants-donation") } }] },
      identifier: `grants_donation_${Date.now()}`,
      instruction: `Donation to the XRPLHub grants pool\n${n} ${currency}\nNot tax-deductible. Published on the XRP Ledger.`,
      expireMinutes: 15,
    });
    return NextResponse.json({ uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, destination: GRANTS_POOL, amount: String(n), currency });
  } catch (e) {
    if (e instanceof XummRateLimitError) return NextResponse.json({ error: "Xaman is busy — try again in a moment." }, { status: 429 });
    return NextResponse.json({ error: "Couldn't create the Xaman request. Send to the address shown instead." }, { status: 502 });
  }
}
