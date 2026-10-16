// src/app/api/pro/xaman/route.ts — XRPLHub Pro for 49 RLUSD (30 days), paid with Xaman.
// POST { claimHash } → a Xaman payment request to the XRPLHub treasury. claimHash is sha256 of a secret made in the
// buyer's browser; it goes in the payment's memo so only that browser can claim the key afterwards
// (uxus.finance/api/billing/xrpl-redeem checks the ledger and the secret). RLUSD only: the price is 49 RLUSD.
import { NextResponse } from "next/server";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { TREASURY, RLUSD_HEX, RLUSD_ISSUER } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();
const PRO_RLUSD = "49";

export async function POST(req: Request) {
  const rl = rateLimit(req, "pro-xaman", 10, 60_000);
  if (!rl.ok) return rateLimited(rl);
  if (!xummConfigured()) return NextResponse.json({ error: "Xaman isn't available right now. Use card instead." }, { status: 503 });
  const b = (await req.json().catch(() => ({}))) as { claimHash?: unknown };
  const claimHash = String(b.claimHash ?? "");
  if (!/^[0-9a-f]{64}$/.test(claimHash)) return NextResponse.json({ error: "Missing claim code." }, { status: 400 });
  try {
    const p = await createPayload({
      txjson: {
        TransactionType: "Payment",
        Destination: TREASURY,
        Amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: PRO_RLUSD },
        Memos: [
          { Memo: { MemoType: hex("xrplhub/product"), MemoData: hex("xrplhubpro") } },
          { Memo: { MemoType: hex("xrplhub/claim"), MemoData: hex(claimHash) } },
        ],
      },
      identifier: `xrplhubpro_${Date.now()}`,
      instruction: `XRPLHub Pro — 30 days\n${PRO_RLUSD} RLUSD`,
      expireMinutes: 15,
    });
    return NextResponse.json({ uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, destination: TREASURY, amount: PRO_RLUSD, currency: "RLUSD" });
  } catch (e) {
    if (e instanceof XummRateLimitError) return NextResponse.json({ error: "Xaman is busy — try again in a moment." }, { status: 429 });
    return NextResponse.json({ error: "Couldn't create the Xaman request. Try card instead." }, { status: 502 });
  }
}
