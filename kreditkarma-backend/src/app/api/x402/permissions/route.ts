// src/app/api/x402/permissions/route.ts
// GET /api/x402/permissions?address=r... — the WALLET PERMISSIONS CHECK for agents and businesses (src/lib/walletPermissions.ts):
// who can move money out of an XRPL wallet — signing power (master key, regular key, signer list), permission
// delegations given and received, and money others can pull (checks, payment channels, escrows, open offers, tickets).
// $0.02 per call on EITHER x402 rail: USDC on Base (X-PAYMENT, CDP) or RLUSD on XRPL (PAYMENT-SIGNATURE, t54).
// People use the free, rate-limited GET /api/permissions/:address behind the /permissions page.
//
// A malformed address is refused BEFORE the payment challenge. A bare request still gets the 402 for discovery crawlers.

import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_PERMISSIONS_USDC, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_PERMISSIONS_RLUSD } from "@/lib/paycall";
import { isValidXrplAddress } from "@/lib/address";
import { PERMISSIONS_INPUT_SCHEMA, PERMISSIONS_OUTPUT_SCHEMA, checkWalletPermissions } from "@/lib/walletPermissions";
import { mainnetRpc } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const PERMISSIONS_DESCRIPTION =
  "Wallet permissions check: who can move money out of an XRPL wallet — master key, regular key, signer list, " +
  "permission delegations (given and received), and money others can pull (checks, payment channels, escrows, open " +
  "offers, tickets) — each with a plain-English sentence and the raw ledger facts. Read live from the ledger. GET ?address=r...";

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!isValidXrplAddress(address)) return NextResponse.json({ error: "bad_request", message: "address must be a valid XRPL address (r...)" }, { status: 400 });
  try {
    return NextResponse.json(await checkWalletPermissions(mainnetRpc, address));
  } catch (e) {
    return NextResponse.json({ error: "ledger_unavailable", message: e instanceof Error ? e.message : "failed", retryable: true }, { status: 503, headers: { "Retry-After": "15" } });
  }
};

const paidGET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_PERMISSIONS_USDC}`,
    network: BASE_NETWORK,
    config: { description: PERMISSIONS_DESCRIPTION, mimeType: "application/json", discoverable: true, outputSchema: PERMISSIONS_OUTPUT_SCHEMA },
  },
  cdpFacilitator
);

const refuse = async (req: NextRequest): Promise<Response | null> => {
  const a = req.nextUrl.searchParams.get("address");
  if (!a) return null; // bare probe: let discovery see the 402
  return isValidXrplAddress(a) ? null : NextResponse.json({ error: "bad_request", message: "address must be a valid XRPL address (r...). Nothing was checked or charged." }, { status: 400 });
};

export const GET = dualX402({
  resource: "/api/x402/permissions",
  plan: "x402:permissions",
  amountRlusd: PRICE_PER_PERMISSIONS_RLUSD,
  amountUsdc: PRICE_PER_PERMISSIONS_USDC,
  name: "Wallet permissions check",
  description: PERMISSIONS_DESCRIPTION,
  schemas: { input: PERMISSIONS_INPUT_SCHEMA, output: PERMISSIONS_OUTPUT_SCHEMA },
  base: paidGET,
  core: handler,
  refuse,
  deliverOnlyIfSettled: true,
});
