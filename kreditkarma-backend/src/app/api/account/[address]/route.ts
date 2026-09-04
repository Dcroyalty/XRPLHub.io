// src/app/api/account/[address]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getAccountInfo, getAccountTrustLines } from "@/lib/xrpl-client";
import { getRlusdConfig } from "@/lib/treasury";
import { isRlusdCurrency } from "@/lib/rlusd";
import { isValidClassicAddress } from "xrpl";

export async function GET(
  req: NextRequest,
  { params }: { params: { address: string } }
) {
  const { address } = params;

  if (!isValidClassicAddress(address)) {
    return NextResponse.json({ error: "Invalid XRPL address" }, { status: 400 });
  }

  try {
    const [accountData, trustLines] = await Promise.all([
      getAccountInfo(address),
      getAccountTrustLines(address),
    ]);

    const { issuer } = getRlusdConfig();
    const rlusdLine = trustLines.find(
      (t) => isRlusdCurrency(t.currency) && t.account === issuer
    );

    const balanceXRP = Number(accountData.Balance) / 1_000_000;

    return NextResponse.json({
      address,
      balance: {
        xrp: balanceXRP,
        rlusd: rlusdLine ? parseFloat(rlusdLine.balance) : 0,
        hasRlusdTrustLine: !!rlusdLine,
      },
      account: {
        sequence: accountData.Sequence,
        ownerCount: accountData.OwnerCount,
        flags: accountData.Flags,
      },
      trustLines: trustLines.slice(0, 20), // limit response size
    });
  } catch (err: any) {
    if (err?.data?.error === "actNotFound") {
      return NextResponse.json(
        { error: "Account not found on XRPL", code: "ACCOUNT_NOT_FOUND" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: "Failed to fetch account info", details: err?.message },
      { status: 500 }
    );
  }
}
