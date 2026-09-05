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

## Credential + Permissioned Domain explorer (free)

Public reads over XRPL Credential (XLS-70) and PermissionedDomain (XLS-80d)
objects — pure ledger data, no licensing, no KYC issued by us. Account/domain
lookups are live against a validated mainnet ledger; issuer stats are served
from a network-wide census that is rebuilt on a schedule (response says
coverage: "complete" or "partial" so a mid-walk answer is never mistaken for
a finished count).

- GET ${origin}/api/credentials/account?address=r... — every credential this account holds (issuer, type, accepted, expired, expiry), live. Default walks the owner directory (bounded ~20s; may return coverage:"partial" for an exchange-scale account). Add &issuer=r... (and &type=<name|hex> unless it is XRPLHub's issuer) for a direct ledger lookup that is always fast and complete.
- GET ${origin}/api/credentials/issuer?address=r... — everything an issuer has issued: types, subject count, acceptance rate, from the census
- GET ${origin}/api/domains/eligible?address=r...&domain=<64-hex DomainID> — does this account hold a credential satisfying this permissioned domain, live

## Multi-Purpose Token (MPT, XLS-33) registry + issuer risk (free)

Both the listing XRPScan/Bithomp have and the risk view they don't: what the
issuer can do to a holder (clawback, freeze, require-auth, non-transferable)
alongside the issuer's own XRPLScore. Per-issuance reads are live from the
validated ledger; an issuance not found returns "unknown", never "does not
exist". Search / issuer listings are served from a registry index that is the
reconciled Bithomp union plus our own ledger_data walk — every indexed
response carries coverage ("complete" | "partial") and lastCompletedPassAt,
and "partial" must be read as a floor, not the whole population.

- GET ${origin}/api/mpt/search?q=<issuer r... | MPTokenIssuanceID or hex prefix | token name> — free, indexed
- GET ${origin}/api/mpt/issuer?address=r... — free, indexed: every MPT this issuer has out + the issuer's XRPLScore
- GET ${origin}/api/mpt/anchor — free: the latest on-ledger Merkle-root anchor of the registry (BIS WP 1374 pattern) + the canonicalisation scheme, so anyone can prove the registry hasn't been altered
- GET ${origin}/api/mpt/<48-hex MPTokenIssuanceID> — free, live: issuance facts + issuer powers + issuer score/grade
- GET ${origin}/api/x402/usdc/mpt/<48-hex id> — $0.01 USDC on Base (x402): full issuer risk — account age, xrp-ledger.toml-verified domain, credentials held, Bithomp cross-check

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
  - get_account_credentials — every XLS-70 credential an account holds, live. Param: wallet_address. Free.
  - get_issuer_credentials — everything an issuer has issued (types, subject count, acceptance rate), from the census. Param: issuer_address. Free.
  - check_domain_eligibility — does an account hold a credential satisfying a PermissionedDomain, live. Params: wallet_address, domain_id. Free.
  - check_mpt_risk — issuer powers (clawback/freeze/auth/transferable) + issuer XRPLScore for one MPT issuance, live. Param: issuance_id. Free basic; $0.01 USDC (x402) for full issuer risk.
  - search_mpts — find MPT issuances in the registry index by issuer / MPTokenIssuanceID or prefix / token name. Param: q. Free.
  - get_issuer_mpts — every MPT one issuer has out + the issuer's XRPLScore, from the index. Param: issuer_address. Free.
  - verify_mpt_registry — the latest on-ledger Merkle-root anchor of the registry + tx hash + ledger index + the canonicalisation scheme to reproduce the root. No params. Free.

x402 pay-per-call (RLUSD, t54 facilitator, no signup):
- Discovery: ${origin}/.well-known/x402
- OpenAPI 3.1: ${origin}/openapi.json
- GET ${origin}/api/x402/score?wallet=r... — 300-850 score + 8 signals
- GET ${origin}/api/x402/report?wallet=r... — score + risk flags + recommendations + on-chain snapshot
- GET ${origin}/api/x402/tx?productId=<id>&account=r... — one prebuilt XRPL transaction (35 actions)

x402 pay-per-call (USDC on Base, CDP facilitator, no signup):
- POST ${origin}/api/x402/usdc/score — 300-850 score, $0.01
- GET ${origin}/api/x402/usdc/mpt/<48-hex id> — full MPT issuer risk, $0.01

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
