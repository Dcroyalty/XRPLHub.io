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
- **34 paid XRPL transaction services** — on-chain actions (trustlines, escrows, AMM, NFT,
  etc.) we BUILD the exact transaction for; the customer signs it. `BUILDABLE_SERVICE_IDS`
  in `src/app/api/execute/serviceCatalog.ts` is the ONE source of that count (a build-time
  check, `scripts/check-service-parity.mjs`, fails if the page, catalog, prices or builders
  disagree). Prices live ONLY in `src/lib/servicePrices.ts` (USD = RLUSD; XRP is derived
  from the live rate). Every payment is verified on the ledger against that table and is
  single-use in the database (`src/lib/paymentGate.ts`) — never trust a client amount.
  Buyers sign twice: the payment, then the service transaction.
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
