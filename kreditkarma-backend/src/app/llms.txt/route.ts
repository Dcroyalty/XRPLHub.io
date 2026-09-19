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
- GET ${origin}/api/mpt/anchor — free: the latest on-ledger Merkle-root anchor of the registry (BIS WP 1374 pattern) + the canonicalisation scheme, so anyone can check the registry rows we publish against the root we anchored on-ledger (proves published rows match the anchored root at a known time, not immutability — the index is mutable and re-anchored)
- GET ${origin}/api/mpt/<48-hex MPTokenIssuanceID> — free, live: issuance facts + issuer powers + issuer score/grade + "mutability" (what the issuer can still change, incl. ImmutableFlags locks) + "confidential" (XLS-96: per-holder data reported as unavailable, never zero)
- GET ${origin}/api/mpt/permanence — free, live: which MPT permanence regime applies right now (DynamicMPT amendment state read from the ledger) and the wording that follows
- GET ${origin}/api/x402/usdc/mpt/<48-hex id> — $0.01 USDC on Base (x402): full issuer risk — account age, xrp-ledger.toml-verified domain, credentials held, Bithomp cross-check

## OFAC SDN screening attestation

Compare one XRPL address against a vintage-pinned snapshot of the US Treasury
OFAC SDN list (exact address-string match only) and get a factual receipt that
is Merkle-anchored on-ledger daily. The receipt attests to PROCESS, not ground
truth: it records that the address was compared against a named list snapshot
(identified by its OFAC publish date and the SHA-256 of the exact file) at a
stated time, and what the comparison found. A "no match" means the address did
not appear on that list version — it is NOT a statement that the address is
clean, safe, or unsanctioned. It is not legal or compliance advice, makes no
compliance decision, and does not discharge your own screening obligations.
Scope: OFAC SDN only (no EU/UK/UN, no Consolidated list, no name/alias/fuzzy
matching, no 1-hop graph analysis). Full terms: ${origin}/legal/screening

- GET ${origin}/api/screen/ofac?address=r... — API key (a free key works), metered. Returns queryId, the list {name, vintage, sha256}, result {listed, matches[]}, a one-sentence factual statement, the canonical leaf, and the disclaimer.
- GET ${origin}/api/x402/screen/ofac?address=r... — $0.01 USDC on Base (x402), no key, no signup. Same receipt.
- GET ${origin}/api/attest/verify?queryId=<uuid> — free: the receipt + Merkle inclusion proof + anchor tx hash + ledger close time + list hash. Verify without trusting XRPLHub. Add &include=snapshot for the full canonical list archive.
- GET ${origin}/api/attest/anchor — free: the frozen ofac-screen-v1 canonicalisation spec, the sanction-screen-v1 engine rules + version-bump policy, the current SDN snapshot, and the latest on-ledger anchor.
- engineVersion "sanction-screen-v1" is immutable per receipt — it changes only if the match algorithm changes (normalisation, match rule, extracted idTypes, source lists, snapshot selection). A newer SDN snapshot is a new vintage, not a version bump.

## XLS-66 cross-broker lending exposure (debt aggregation)

A borrower's total XLS-66 lending exposure across ALL loan brokers in one call.
The XRP Ledger has no aggregate borrower-debt object — a loan broker sees only
its own loans while carrying first-loss capital. This aggregates every Loan
object in the borrower's owner directory: total outstanding by asset, loan
count, distinct broker count, defaults / impairments / overdue, and XRPLHub's
XRPLScore.

Why this matters: XLS-66 keeps CURRENT exposure only. A defaulted loan zeroes
its own amounts (the lsfLoanDefault flag is the credit event, not the balance),
and either the borrower or the broker can delete a paid/defaulted loan to
reclaim the borrower's reserve — a borrower can erase the evidence of their own
default. So EVERY exposure query here persists an immutable, Merkle-anchored
snapshot that commits to the exact list of loans observed. Our attested
snapshots are the credit history the ledger doesn't keep. The disposition
field distinguishes "no-loans-ever" (we have never observed one — NOT proof of
none) from "history-only" (loans seen before, none on the ledger now).

XLS-66 is not yet enabled on mainnet (open for validator voting). These
endpoints return 503 with the live XRPLScore until the LendingProtocol
amendment activates, then serve automatically — gated on the on-ledger
Amendments object, no redeploy. Not underwriting or credit advice.

- GET ${origin}/api/lending/exposure?borrower=r... — API key (a free key works): the aggregate + observation summary. Persists a snapshot every call.
- GET ${origin}/api/lending/history?borrower=r... — API key: every loan ever observed for this borrower, first/last observed, last-known status, ever-defaulted/impaired flags, and the ledger window in which any vanished loan disappeared. Carries a sweepCoverage block: when this borrower was last swept, which pass, and any gaps in the observation window (honest about what we did and didn't see).
- A daily cron sweep re-observes EVERY borrower we've ever seen so the attested history has no gaps where nobody happened to run a paid query. Borrowers with active or impaired loans are swept first (their evidence is the most likely to be deleted). A sweep observation is byte-identical in the attested record to a paid one.
- GET ${origin}/api/x402/lending/exposure?borrower=r... — $0.01 USDC on Base (x402), no key: adds every loan decoded, per-broker first-loss context (DebtTotal / CoverAvailable), vanished-loan detail, and the attestation receipt.
- GET ${origin}/api/x402/lending/underwrite?borrower=r... — $0.05 USDC on Base (x402), no key, no free tier: the full underwriting-inputs bundle for a LoanBroker — cross-broker exposure + XRPLScore + OFAC SDN screening (with its own receipt) + observation history/gaps + ONE attestation over the whole bundle. FACTS ONLY: no recommended principal, rate, approve/decline, or probability of default. The broker decides. Amendment-gated (503 with the live XRPLScore + OFAC result until XLS-66 enables).
- GET ${origin}/api/attest/verify?queryId=<uuid> — free: the exposure snapshot + Merkle inclusion proof + on-ledger anchor tx. The leaf commits to visibleLoanIds, so a loan later deleted is still provably attested to have existed.

## For AI agents

MCP server (Streamable HTTP, JSON-RPC 2.0, no auth):
- Endpoint: ${origin}/api/mcp
- Claude Code: claude mcp add xrplhub --url ${origin}/api/mcp
- Tools:
  - check_xrpl_score — free 300-850 wallet score + 8-signal breakdown + tips. Param: wallet_address.
  - list_xrpl_services — the 35 build_xrpl_transaction actions, each with its params + examples. No params.
  - build_xrpl_transaction — ready-to-sign txjson for one of 35 XRPL actions. Params: product_id, wallet_address, params. Free. NOTE: mptissue (MPT issuance) has a full form — name, ticker, supply cap, decimals, 6 capability flags (canTransfer/canTrade/canEscrow/canLock/requireAuth/canClawback — clawback = you can take the token back from any holder), an optional transfer fee, and a backing declaration (backingType, backingStatement, verifiedBy, redeemable). Free preview at POST /api/execute/preview shows the decoded tx + what is permanent vs changeable RIGHT NOW (read live from the DynamicMPT amendment state; hedged if unreadable) + the flag guide + the backing hard line (XRPLHub publishes the declaration, never verifies it).
  - issue_score_credential — paid (1 XRP or 1 RLUSD) signed, verifiable score certificate, 90 days. Params: wallet_address, currency, uuid (2nd call).
  - submit_grant_application — apply for a $25-$100 community micro-grant (a person reviews every application). Params: wallet_address, category, amount, description.
  - donate_to_community_fund — donate XRP or RLUSD to the grant treasury. Params: amount, currency, donor_wallet, message.
  - get_account_credentials — every XLS-70 credential an account holds, live. Param: wallet_address. Free.
  - get_issuer_credentials — everything an issuer has issued (types, subject count, acceptance rate), from the census. Param: issuer_address. Free.
  - check_domain_eligibility — does an account hold a credential satisfying a PermissionedDomain, live. Params: wallet_address, domain_id. Free.
  - check_mpt_risk — issuer powers (clawback/freeze/auth/transferable) + issuer XRPLScore for one MPT issuance, live. Param: issuance_id. Free basic; $0.01 USDC (x402) for full issuer risk.
  - search_mpts — find MPT issuances in the registry index by issuer / MPTokenIssuanceID or prefix / token name. Param: q. Free.
  - get_issuer_mpts — every MPT one issuer has out + the issuer's XRPLScore, from the index. Param: issuer_address. Free.
  - verify_mpt_registry — the latest on-ledger Merkle-root anchor of the registry + tx hash + ledger index + the canonicalisation scheme to reproduce the root. No params. Free.
  - check_service_health — DB / Xaman / both x402 facilitators / anchor config, up or down. Poll before paying. No params. Free.
  - screen_address_ofac — compare one XRPL address against a vintage-pinned OFAC SDN snapshot (exact match only); returns a Merkle-anchored receipt. Attests to PROCESS, not ground truth — a "no match" is NOT "this address is clean". Param: address. Free via MCP.
  - verify_attestation — given a screening OR lending-exposure queryId, return the inclusion proof + on-ledger anchor tx + source hash so it can be verified without trusting XRPLHub. Param: query_id. Free.
  - get_lending_exposure — a borrower's total XLS-66 exposure across ALL loan brokers (outstanding by asset, defaults, impairments) + XRPLScore + observation history. The ledger keeps current exposure only and a borrower can delete their own default record — every call persists a Merkle-anchored snapshot. Param: borrower. Free via MCP. 503 (with XRPLScore) until XLS-66 activates.
  - get_lending_history — every loan XRPLHub has ever observed for a borrower: first/last seen, last-known status, ever-defaulted/impaired, and the ledger window a vanished loan disappeared in. Param: borrower. Free.

Health: GET ${origin}/api/health  (503 when a money-path component is down; ?deep=1 for live facilitator probes)

x402 pay-per-call (RLUSD, t54 facilitator, no signup):
- Discovery: ${origin}/.well-known/x402  (carries per-resource inputSchema + outputSchema, the errorCodes map, and the settlement/idempotency guarantees)
- OpenAPI 3.1: ${origin}/openapi.json
- GET ${origin}/api/x402/score?wallet=r... — 300-850 score + 8 signals
- GET ${origin}/api/x402/report?wallet=r... — score + risk flags + recommendations + on-chain snapshot
- GET ${origin}/api/x402/tx?productId=<id>&account=r... — one prebuilt XRPL transaction (35 actions)
- The 402 challenge embeds the full schema. Settlement fires ONLY after the paid
  work succeeds — a handler failure returns error:"handler_failed" and does NOT
  charge you (retry with the same PAYMENT-SIGNATURE). Send an Idempotency-Key
  header (or rely on the invoiceId) — a retry replays the original response.
- RETIRED (410, use the x402 route above): /api/x402-tx, /api/v1/wallet-report,
  /api/v1/pay-per-score.

x402 pay-per-call (USDC on Base, CDP facilitator, no signup):
- POST ${origin}/api/x402/usdc/score — 300-850 score, $0.01
- GET ${origin}/api/x402/usdc/mpt/<48-hex id> — full MPT issuer risk, $0.01
- GET ${origin}/api/x402/screen/ofac?address=r... — OFAC SDN screening attestation, $0.01 (process not ground truth; see the screening section above)
- GET ${origin}/api/x402/lending/exposure?borrower=r... — XLS-66 cross-broker lending exposure, full detail + attestation, $0.01 (503 until XLS-66 activates; see the lending section above)
- GET ${origin}/api/x402/lending/underwrite?borrower=r... — full underwriting-inputs bundle, $0.05, facts only, no recommendation (503 until XLS-66 activates)

## B2B API (prepaid key, 30-day term)

Buy a key at ${origin}/pricing — pay once in XRP, RLUSD, or USDC-on-Base (x402),
no signup. Then: GET ${origin}/api/v1/score?wallet=r... with header
"Authorization: Bearer xrs_live_...". Returns the same number as the site.
The key works for 30 days from purchase (no card on file, no auto-renew) — buy
again to continue. Responses carry an X-Key-Expires header, and in the last 72h
an X-Key-Expires-Soon header plus a renew object in the body. An expired key
returns HTTP 402 (error "key_expired", with expiredAt and renew URLs) — not
401 — so an agent can re-buy without a human.

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
- Screening spec + terms: ${origin}/api/attest/anchor · ${origin}/legal/screening
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
