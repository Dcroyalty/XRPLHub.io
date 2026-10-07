// src/lib/retiredTx.ts
// The generic transaction catalog was REMOVED on 2026-10-07 (owner decision: XRPLHub keeps only products nobody else
// offers). /api/tx, /api/x402/tx and /api/x402-tx answer 410 Gone with where to go instead, so an agent or old
// integration gets a clear answer rather than a bare 404.
import { NextResponse } from "next/server";

const BODY = {
  error: "retired",
  message:
    "XRPLHub no longer builds generic XRPL transactions (retired 2026-10-07). Build them with your wallet or the XRPL " +
    "libraries directly. XRPLHub still builds the transactions inside its own products: Spend Controls checks " +
    "(https://www.xrplhub.io/spend), XRPLScore-gated Permissioned Domains (GET /api/domains/build), and MPT issuance " +
    "with a recorded backing declaration (the MPT card at https://www.xrplhub.io/#mpt).",
  instead: {
    spendControls: "https://www.xrplhub.io/spend",
    paymentPrecheck: "https://www.xrplhub.io/api/x402/precheck",
    scoreGatedDomain: "https://www.xrplhub.io/api/domains/build",
  },
};

export const retiredTxResponse = () => NextResponse.json(BODY, { status: 410, headers: { "Cache-Control": "public, max-age=3600" } });
