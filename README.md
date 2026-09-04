# XRPLHub.io

**On-chain creditworthiness for the XRP Ledger.** XRPLHub gives any XRPL wallet a
300–850 credit-style score (**XRPLScore**) computed from 8 public-ledger signals,
sells ready-to-sign prebuilt XRPL transactions for 35 actions, issues signed
verifiable score credentials, and runs an on-chain community micro-grant fund.

- **Live app:** https://www.xrplhub.io
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

The same number is returned everywhere: the public site, the free endpoint, the
paid API, the x402 endpoints, and the MCP server.

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

| Tool | What you get | Cost |
|---|---|---|
| `check_xrpl_score` | 300–850 score, grade, percentile, 8-signal breakdown, tips. Param: `wallet_address`. | free |
| `list_xrpl_services` | All 35 `build_xrpl_transaction` actions, each with params + examples. No params. | free |
| `build_xrpl_transaction` | Ready-to-sign txjson for one of 35 XRPL actions. Params: `product_id`, `wallet_address`, `params`. | free |
| `issue_score_credential` | Signed, tamper-evident score certificate + public verify URL, 90 days. Params: `wallet_address`, `currency`, `uuid`. | 1 XRP / 1 RLUSD |
| `submit_grant_application` | Apply for a 1–100 RLUSD community micro-grant. Params: `wallet_address`, `category`, `amount`, `description`. | free |
| `donate_to_community_fund` | Donate XRP or RLUSD to the grant treasury. Params: `amount`, `currency`, `donor_wallet`, `message`. | free |

The transaction tools return an **unsigned txjson** — the wallet owner signs it in
their own wallet. XRPLHub never signs for anyone.

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
| Free | $0 | 500 scored calls/mo | 15 req/min |
| Starter | $29/mo | 10,000 | 60 req/min |
| Growth | $149/mo | 100,000 (overage billed) | 300 req/min |
| Scale | $499/mo | 1,000,000 (overage billed) | 1,000 req/min |

---

## Community grants

Donate XRP or RLUSD to the treasury; anyone can apply for a 1–100 RLUSD
micro-grant (rent, utilities, groceries, medical, transport, childcare). AI
triages each application, a human approves, and approved funds go straight to the
applicant's wallet. Every donation and payout is on-ledger.

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
