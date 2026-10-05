# XRPLHub.io

**On-chain creditworthiness for the XRP Ledger.** XRPLHub gives any XRPL wallet a
300–850 credit-style score (**XRPLScore**) computed from 8 public-ledger signals,
sells ready-to-sign prebuilt XRPL transactions for 35 actions, issues signed
score certificates (XRPLHub's own attestation), and runs a community micro-grant fund
(human-reviewed; applications currently paused).

- **Live app:** https://www.xrplhub.io
- **Unsigned only, no custody:** XRPLHub builds the exact transaction and scores wallets; it never signs or holds keys. Agents sign with their own wallet (see Ripple's [XRPL AI Starter Kit](https://ripple.com/insights/xrpl-ai-starter-kit/) Wallet and Payment skills).
- **The wallet score is free and unauthenticated.** Paid actions settle in **XRP or RLUSD** — no account, no signup.
- Next.js + TypeScript on Vercel · Neon Postgres (Prisma) · Xaman (XUMM) for signing.

The production app is the Next.js project in [`kreditkarma-backend/`](./kreditkarma-backend).

---

## XRPLScore

A 300–850 number on an **absolute scale** (like FICO — not a percentile that
drifts with the population), from 8 signals:

| Signal | What it measures |
|---|---|
| Account age | Age from the wallet's genuine first transaction |
| Transaction activity | Lifetime on-chain activity (log curve, no cap) |
| Financial health | Spendable XRP + buffer above the real reserve line |
| Token engagement | Trust lines to issued assets |
| DEX activity | Order history on the native DEX |
| AMM participation | Liquidity-pool activity |
| Security config | Multisig, regular key, domain, escrow |
| NFT activity | NFT portfolio + trading |

One engine computes the number for the public site, the free endpoint, the paid API,
the x402 endpoints and the MCP server. Free and site lookups may be served from a
15-minute cache; every response says whether it was (`fromCache`, `cacheAgeSeconds`).

```bash
# Free, no key, any wallet:
curl https://www.xrplhub.io/api/score/rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De
```

---

## For AI agents

### MCP server

Streamable HTTP, JSON-RPC 2.0, no auth.

```
https://www.xrplhub.io/api/mcp
```

```bash
claude mcp add xrplhub --url https://www.xrplhub.io/api/mcp
```

21 tools. Every one that returns a transaction returns an **unsigned txjson** — the wallet owner signs it in their
own wallet; XRPLHub never signs for anyone.

**Score & services**

| Tool | What you get | Cost |
|---|---|---|
| `check_xrpl_score` | 300–850 score, grade, percentile, 8-signal breakdown, tips. Param: `wallet_address`. | free |
| `list_xrpl_services` | All 35 `build_xrpl_transaction` actions, each with params + examples. Call this first. No params. | free |
| `preview_xrpl_transaction` | Describe one action before buying it: what it does, what's irreversible, the price, every field it needs. No signable txjson. Params: `product_id`, `params` (optional). | free |
| `build_xrpl_transaction` | Buy the unsigned, ready-to-sign txjson for one of 35 actions — the storefront price, paid via x402 (USDC on Base or RLUSD on XRPL). Params: `product_id`, `wallet_address`, `params`, `confirm_caution` (caution-tier only). | storefront price |
| `issue_score_credential` | Score certificate signed by XRPLHub (score computed fresh at issuance), with a URL where XRPLHub confirms it — XRPLHub's own attestation, not independently verifiable. 90 days. Params: `wallet_address`, `currency`, `uuid`. | 1 XRP / 1 RLUSD |
| `check_service_health` | Is the money path working right now — database, Xaman, both x402 facilitators, the anchor config, alerting — before you pay. No params. | free |

**Credentials (XLS-70) & Permissioned Domains**

| Tool | What you get | Cost |
|---|---|---|
| `get_account_credentials` | Every credential an account holds — issuer, type, accepted?, expired?, expiry. Live, never stale. Params: `wallet_address`, `issuer` (optional, direct lookup), `credential_type` (optional). | free |
| `get_issuer_credentials` | Everything one issuer has issued: types, subject count, acceptance rate, from a network-wide census (`coverage` says complete/partial). Param: `issuer_address`. | free |
| `check_domain_eligibility` | Does an account hold a credential satisfying a PermissionedDomain (XLS-80d)? Any one accepted, unexpired, matching credential is enough. Params: `wallet_address`, `domain_id`. | free |

**Multi-Purpose Tokens (XLS-33)**

| Tool | What you get | Cost |
|---|---|---|
| `check_mpt_risk` | One issuance's risk view before touching it: issuer powers (clawback, freeze, require-auth, transferable) + the issuer's XRPLScore. Param: `issuance_id` (48-hex). | free |
| `search_mpts` | Search the MPT registry index by issuer, issuance id (or hex prefix), or name/ticker. Param: `q`. | free |
| `get_issuer_mpts` | Everything one issuer has issued as MPTs, with issuer powers per issuance and the issuer's XRPLScore. Param: `issuer_address`. | free |
| `verify_mpt_registry` | The latest on-ledger Merkle anchor of the MPT registry (BIS WP 1374 pattern) — root, tx hash, ledger index, coverage, and the exact scheme to reproduce it. No params. | free |

**Sanctions screening & attestation**

| Tool | What you get | Cost |
|---|---|---|
| `screen_address_ofac` | Compare one XRPL address against a vintage-pinned OFAC SDN snapshot (exact match only); a Merkle-anchored receipt. Attests to **process, not ground truth** — "no match" is not "clean." OFAC SDN only (no EU/UK/UN, no fuzzy matching) — see `GET /api/screen` for the multi-list version. Param: `address`. | free |
| `verify_attestation` | Given a `queryId` from `screen_address_ofac` or `get_lending_exposure`, the full Merkle inclusion proof + on-ledger anchor tx + source hash, so it can be checked without trusting XRPLHub. Param: `query_id`. | free |

**Continuous monitoring**

| Tool | What you get | Cost |
|---|---|---|
| `get_monitoring_info` | What the monitoring service watches (score drops, sanctions hits, loan events), how it's delivered (HMAC webhooks, daily), the required consumer-use acknowledgement text, and the endpoints. Subscribing itself needs an API key over HTTP, not this tool. No params. | free |

**XLS-66 lending (returns `amendment-not-active` until XLS-66 is live on mainnet)**

| Tool | What you get | Cost |
|---|---|---|
| `get_lending_exposure` | A borrower's total exposure across every loan broker in one call — the ledger has no aggregate object for this. Param: `borrower`. | free |
| `get_lending_history` | Every loan ever observed for a borrower, including ones since deleted from the ledger (a deleted default still shows, flagged). Param: `borrower`. | free |
| `get_underwriting_inputs` | The full underwriting bundle a broker needs — exposure + score + OFAC screening + history, facts only, no recommendation. Param: `borrower`. | $0.05 USDC on Base (x402, no free tier) |

**Community grants**

| Tool | What you get | Cost |
|---|---|---|
| `submit_grant_application` | Apply for a community micro-grant. **Currently paused** — returns an error until applications reopen. Params: `wallet_address`, `category`, `amount`, `description`. | free |
| `donate_to_community_fund` | Donate XRP or RLUSD to the grant treasury; returns a ready-to-sign Payment if you pass `donor_wallet`. Params: `amount`, `currency`, `donor_wallet`, `message`. | free |

### x402 (pay-per-call, RLUSD, no signup)

- Discovery: https://www.xrplhub.io/.well-known/x402
- OpenAPI 3.1: https://www.xrplhub.io/openapi.json
- `GET /api/x402/score?wallet=r...` — 300–850 score + 8 signals
- `GET /api/x402/report?wallet=r...` — score + risk flags + recommendations + on-chain snapshot
- `GET /api/x402/tx?productId=<id>&account=r...` — one prebuilt XRPL transaction (35 actions)

### llms.txt

https://www.xrplhub.io/llms.txt

---

## B2B API (subscription)

Buy a key at https://www.xrplhub.io/pricing — pay in **XRP or RLUSD**, connect
Xaman and sign (no address typing), no signup.

```bash
curl -H "Authorization: Bearer xrs_live_..." \
  "https://www.xrplhub.io/api/v1/score?wallet=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"
```

| Plan | Price | Included | Rate limit |
|---|---|---|---|
| Free | $0 | 200 scored calls/mo | 10 req/min |
| Starter | $29/mo | 10,000 | 60 req/min |
| Growth | $149/mo | 100,000 | 300 req/min |
| Scale | $499/mo | 1,000,000 | 1,000 req/min |

Quotas are hard: past the monthly quota a key gets HTTP 429 until the next month (or an upgrade). There is no overage billing.

---

## Community grants

Donate XRP or RLUSD to the treasury. When applications are open, anyone can apply
for a $25–$100 micro-grant (rent, utilities, groceries, medical, transport,
childcare); a person reviews every application — nothing is decided or paid
automatically — and approved funds go straight to the applicant's wallet. Every
donation and payout is on-ledger. **Applications are currently paused** until the
treasury is funded (`GRANT_APPLICATIONS_OPEN` in `src/lib/grantsStatus.ts`).

Treasury: `rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF` ·
[view on XRPScan](https://xrpscan.com/account/rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF)

---

## Development

```bash
cd kreditkarma-backend
npm install
cp .env.example .env   # fill in the values
npx prisma generate
npm run dev
```

See [`kreditkarma-backend/.env.example`](./kreditkarma-backend/.env.example) for
every environment variable the app reads.

---

## Links

- Site: https://www.xrplhub.io
- Pricing: https://www.xrplhub.io/pricing
- OpenAPI: https://www.xrplhub.io/openapi.json
- x402 discovery: https://www.xrplhub.io/.well-known/x402
- MCP: https://www.xrplhub.io/api/mcp
- Contact: support@xrplhub.io
