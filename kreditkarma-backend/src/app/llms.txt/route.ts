// src/app/llms.txt/route.ts
// https://llmstxt.org — a concise, LLM-friendly map of XRPLHub for agents and
// AI crawlers. Plain text, stable URL: https://www.xrplhub.io/llms.txt

import { PLAN_ORDER, PLANS } from "@/lib/plans";
import { SERVICE_CATALOG } from "@/app/api/execute/serviceCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  const plans = PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    const price = p.priceRlusd > 0 ? `$${p.priceRlusd}/mo` : "free";
    return `- ${p.name} (${price}): ${p.monthlyQuota.toLocaleString()} scored calls/mo, ${p.rateLimitPerMin} req/min`;
  }).join("\n");

  const services = SERVICE_CATALOG.map((s) => {
    const req = s.params.filter((x) => x.required).map((x) => x.name);
    return `- ${s.id} — ${s.label}${req.length ? ` (params: ${req.join(", ")})` : ""}`;
  }).join("\n");

  const body = `# XRPLHub.io

> On-chain creditworthiness for the XRP Ledger. XRPLHub gives any XRPL wallet a
> 300-850 credit-style score (XRPLScore) from 8 public-ledger signals, sells
> ready-to-sign prebuilt XRPL transactions for 35 actions, issues signed
> verifiable score credentials, and runs an on-chain community micro-grant fund.
> The wallet score is free and unauthenticated. Paid actions settle in XRP or
> RLUSD with no account and no signup.

## XRPLScore (free)

The score is a 300-850 number, absolute scale (like FICO, not a percentile), from
8 signals: account age, lifetime transaction activity, financial health
(spendable XRP + reserve buffer), token engagement, DEX activity, AMM
participation, security configuration, NFT activity. Same number everywhere:
the public site, the free endpoint, the paid API, and the MCP server.

- Free score, any wallet: GET ${origin}/api/score/{r-address}
- Methodology: XRPLHub XRPLScore v1.1, 8-signal native on-chain behavioral scoring

## For AI agents

MCP server (Streamable HTTP, JSON-RPC 2.0, no auth):
- Endpoint: ${origin}/api/mcp
- Claude Code: claude mcp add xrplhub --url ${origin}/api/mcp
- Tools:
  - check_xrpl_score — free 300-850 wallet score + 8-signal breakdown + tips. Param: wallet_address.
  - list_xrpl_services — the 35 build_xrpl_transaction actions, each with its params + examples. No params.
  - build_xrpl_transaction — ready-to-sign txjson for one of 35 XRPL actions. Params: product_id, wallet_address, params. Free.
  - issue_score_credential — paid (1 XRP or 1 RLUSD) signed, verifiable score certificate, 90 days. Params: wallet_address, currency, uuid (2nd call).
  - submit_grant_application — apply for a 1-100 RLUSD community micro-grant. Params: wallet_address, category, amount, description.
  - donate_to_community_fund — donate XRP or RLUSD to the grant treasury. Params: amount, currency, donor_wallet, message.

x402 pay-per-call (RLUSD, t54 facilitator, no signup):
- Discovery: ${origin}/.well-known/x402
- OpenAPI 3.1: ${origin}/openapi.json
- GET ${origin}/api/x402/score?wallet=r... — 300-850 score + 8 signals
- GET ${origin}/api/x402/report?wallet=r... — score + risk flags + recommendations + on-chain snapshot
- GET ${origin}/api/x402/tx?productId=<id>&account=r... — one prebuilt XRPL transaction (35 actions)

## B2B API (subscription)

Buy a key at ${origin}/pricing — pay in XRP or RLUSD, connect Xaman and sign (no
address typing), no signup. Then: GET ${origin}/api/v1/score?wallet=r... with
header "Authorization: Bearer xrs_live_...". Returns the same number as the site.

${plans}

## The 35 prebuilt XRPL transaction actions

build_xrpl_transaction / /api/x402/tx return an unsigned txjson; the wallet owner
signs it in their own wallet. This never signs for anyone.

${services}

## Treasury

rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF (labelled "XRPLHub" on-ledger) receives
service payments and funds community grants. Every donation and payout is
publicly verifiable: https://xrpscan.com/account/rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF

## Links

- Site: ${origin}
- Pricing: ${origin}/pricing
- OpenAPI: ${origin}/openapi.json
- x402 discovery: ${origin}/.well-known/x402
- MCP: ${origin}/api/mcp
- Source: https://github.com/Dcroyalty/XRPLHub.io
- Contact: support@xrplhub.io
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
