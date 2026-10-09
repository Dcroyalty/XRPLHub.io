@AGENTS.md

# XRPLHub.io

XRPLHub.io is a consumer + B2B platform built on the XRP Ledger. It gives XRPL
wallets a credit-style reputation score, sells on-chain transaction services,
runs a human-reviewed grants program (applications are paused while the treasury is unfunded),
and exposes a paid B2B API. There is no AI/LLM anywhere in the shipped code — never claim there is.

## Where the code lives

The live production app is a single Next.js project in **`kreditkarma-backend/`**
(the repo root is just this file + `AGENTS.md`). Do all app work there.

## Stack

- **Next.js + TypeScript**, deployed on **Vercel**. This is a modified Next.js —
  see `AGENTS.md` and read `node_modules/next/dist/docs/` before writing code.
- **Neon** Postgres via **Prisma**.
- **Xaman (XUMM)** for wallet connect and signing; Crossmark and GemWallet can also pay and sign
  (same XRPL account you connected).
- Treasury wallet: **`rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF`** — receives service
  payments and funds grants.

## Products

- **XRPLScore** — a 300–850 credit-style score for an XRPL wallet.
- **NO generic transaction catalog** (removed 2026-10-07: we keep only products nobody else offers). `/api/tx`,
  `/api/x402/tx`, `/api/x402-tx` answer 410 (`src/lib/retiredTx.ts`); MCP has no build/preview/list tools; old
  `/services/*` pages redirect (checks → /spend, the rest → /). The ONLY transactions we build are inside our products:
  Spend Controls checks (`src/lib/checks.ts`), `mptissue` (feeds the io.xrplhub.mpt.v1.declared credential; MPT card on the
  homepage) and `permdomain` (XRPLScore-gated domains, returned by `/api/domains/build`), both free, via `/api/execute`,
  plus the admin-only `adminhealthcheck` (proves the paid path; `scripts/test-paid-path.mjs`). `scripts/check-service-parity.mjs`
  (KEPT_TX) fails the build if any other transaction, a service count or a "catalog" claim creeps back.
- **Still PAID** (prices in `src/lib/servicePrices.ts` / `src/lib/paycall.ts`, ledger-verified, single-use): score
  reports + score API, screening + receipts, monitoring, MPT data + issuer risk, credentials, lending/underwriting data,
  API plans, the admin health check, the agent payment pre-check (`/api/x402/precheck`, $0.03, both x402 rails,
  `src/lib/paymentPrecheck.ts`). Spend Controls is FREE (2026-10-06): no plan fee, same reasoning as transactions.
- **Spend Controls** (`src/lib/spendControls.ts`) — budgets (RLUSD) and SUBSCRIPTIONS (one payee, RLUSD or XRP). NEVER
  create a future period's check: a check is cashable the moment it exists. The daily MPT cron pushes this period's
  unsigned subscription check to the payer's Xaman app (`xamanUserToken`, never returned by an API). Checks, not
  escrow, even for XRP (escrow locks funds and can't be cancelled before CancelAfter).
  **AUTOPAY** (`src/lib/autopay.ts` core, `src/lib/spendAutopay.ts` glue, 2026-10-09): the payer pre-signs one Payment per
  FUTURE period on its own Ticket with a far-future LastLedgerSequence WE set (Xaman keeps it: probe 427afc24). Blobs are
  encrypted (`SPEND_AUTOPAY_KEY`), never returned, sent one per period by the 07:00 cron, never early, never retried after
  a tec. Cancel = stop + payer burns the remaining tickets. Starts the period AFTER the current one, so it never overlaps a
  check. Testnet E2E: `node scripts/test-autopay-testnet.ts`. The **xApp** (`/xapp/spend`)
  shows ONLY Spend Controls and signs with `xumm-xapp-sdk` `openSignRequest` — never add the catalog, DEX or anything
  Xaman does itself to it.
- **Focus (competitive map, 2026-10-06):** lead with XRPLScore + monitoring + lending readiness, Spend Controls, MPT
  issuer-power risk. Don't rebuild what Xaman or any wallet already does.
- **Community grants** — a person reviews every application; nothing is automated. The
  application form is gated by `GRANT_APPLICATIONS_OPEN` in `src/lib/grantsStatus.ts`
  (currently `false`: approved grants are waiting to be paid). Donations stay open.
- **B2B API** — the scoring/report API sold to businesses, **billed in RLUSD**
  (see `src/lib/rlusd.ts`, x402 payment flow in `src/lib/x402.ts`).

- **Continuous monitoring** — `/api/monitor/*`: watched wallets, HMAC-signed webhooks, sparse attested
  observations (canon `monitor-observation-v1`). Layered on top of underwriting, never a replacement; no default
  probability, no default score-drop threshold, consumer-use (FCRA/ECOA) acknowledgement required. See
  `kreditkarma-backend/docs/MONITORING.md`. A score in an observation must be fresh (never `scoreCache`).

## Running unattended

`kreditkarma-backend/docs/AUTONOMY.md` is the source of truth for what runs on its own, exact renewal dates
(XRPNS names do NOT auto-renew), the watchdog (`src/lib/watchdog.ts`, run by both daily crons), and what to
check first after a long absence. All amendment gates read the ledger at request time — never add a
build-time activation flag.

## Deploy gotchas

1. **Vercel build cache must be UNCHECKED** when deploying. Stale cache produces
   broken builds (Prisma client / env drift). Always redeploy with cache off.
2. **PowerShell `Select-String` needs `-LiteralPath`** on bracketed paths.
   Next.js route dirs like `src/app/verify/[certId]/` contain `[]`, which
   PowerShell treats as glob wildcards — `Select-String path/[certId]/file`
   silently matches nothing. Use `Select-String -LiteralPath ...`.
