// src/lib/x402WalletGet.ts
// A paid `GET ?wallet=r...` resource on BOTH x402 rails at one price (src/lib/x402Dual.ts): RLUSD on the XRP Ledger
// (x402 v2, t54, PAYMENT-SIGNATURE) or USDC on Base (x402 v1, CDP, X-PAYMENT). Used by /api/x402/score and
// /api/x402/report, which were XRPL-only until 2026-10-05.
//
// Unchanged for an existing XRPL-rail client: the same RLUSD price, the same { data, x402 } envelope, settle only after
// the handler succeeds, idempotent replay. The XRPL v2 challenge rides in the PAYMENT-REQUIRED header (where v2 clients
// and xrpl-ai.org read it); the 402 body is the Base v1 challenge.

import { NextResponse, type NextRequest } from "next/server";
import { withX402 } from "x402-next";
import { BASE_NETWORK, BASE_PAY_TO, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { isValidXrplAddress, AccountNotFoundError, XrplUnavailableError } from "@/lib/engine";
import type { X402ResourceSchema } from "@/lib/x402Schemas";

export interface WalletGetOpts {
  resource: string;
  plan: string;
  /** The same face value on both rails — dualX402 fails closed if they ever differ. */
  amountRlusd: number;
  amountUsdc: number;
  name: string;
  schema: X402ResourceSchema;
  compute: (wallet: string) => Promise<unknown>;
}

export function walletGetDual(o: WalletGetOpts) {
  const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
    const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim();
    if (!isValidXrplAddress(wallet)) {
      return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL wallet (?wallet=r...)." }, { status: 400 });
    }
    try {
      return NextResponse.json({ data: await o.compute(wallet) });
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        return NextResponse.json({ error: "account_not_found", message: "That wallet is not an activated account on XRPL mainnet." }, { status: 404 });
      }
      if (err instanceof XrplUnavailableError) {
        // Not computed, not charged (both rails settle only on success), retryable.
        return NextResponse.json({ error: "xrpl_unavailable", message: err.message, retryable: true }, { status: 503, headers: { "Retry-After": "15" } });
      }
      return NextResponse.json({ error: "handler_failed", message: err instanceof Error ? err.message : "failed" }, { status: 500 });
    }
  };

  const paidGET = withX402(
    handler,
    BASE_PAY_TO,
    {
      price: `$${o.amountUsdc}`,
      network: BASE_NETWORK,
      config: {
        description: o.schema.description,
        mimeType: "application/json",
        discoverable: true,
        inputSchema: { queryParams: { wallet: "XRPL r-address of the wallet (required)" } },
        outputSchema: o.schema.output as object,
      },
    },
    cdpFacilitator
  );

  // A MISTYPED wallet is refused BEFORE any challenge (nothing to pay against). A bare request still gets the 402.
  const refuse = (req: NextRequest): Response | null => {
    const supplied = (req.nextUrl.searchParams.get("wallet") ?? "").trim();
    if (supplied && !isValidXrplAddress(supplied)) {
      return NextResponse.json(
        { error: "bad_request", message: "Provide a valid XRPL wallet (?wallet=r...) — an r-address whose checksum verifies. Nothing was priced or charged." },
        { status: 400 }
      );
    }
    return null;
  };

  return dualX402({
    resource: o.resource,
    plan: o.plan,
    amountRlusd: o.amountRlusd,
    amountUsdc: o.amountUsdc,
    name: o.name,
    description: o.schema.description,
    schemas: { input: o.schema.input, output: o.schema.output, outputExample: o.schema.outputExample },
    base: paidGET,
    core: handler,
    // Base body is { data }; the XRPL rail's envelope is { data, x402 } — exactly what this route returned before.
    xrplData: (body) => (body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : body),
    refuse,
  });
}
