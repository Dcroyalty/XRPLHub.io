@AGENTS.md

# XRPLHub.io

XRPLHub.io is a consumer + B2B platform built on the XRP Ledger. It gives XRPL
wallets a credit-style reputation score, sells on-chain transaction services,
runs an AI-reviewed grants program, and exposes a paid B2B API.

## Where the code lives

The live production app is a single Next.js project in **`kreditkarma-backend/`**
(the repo root is just this file + `AGENTS.md`). Do all app work there.

## Stack

- **Next.js + TypeScript**, deployed on **Vercel**. This is a modified Next.js —
  see `AGENTS.md` and read `node_modules/next/dist/docs/` before writing code.
- **Neon** Postgres via **Prisma**.
- **Xaman (XUMM)** for XRPL transaction signing / wallet auth.
- Treasury wallet: **`rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF`** — receives service
  payments and funds grants.

## Products

- **XRPLScore** — a 300–850 credit-style score for an XRPL wallet.
- **35 paid XRPL transaction services** — on-chain actions (trustlines, escrows,
  AMM, NFT, etc.) executed for a fee, signed via Xaman.
- **AI-reviewed grants** — applicants submit proposals; an LLM review step scores
  them before treasury payout.
- **B2B API** — the scoring/report API sold to businesses, **billed in RLUSD**
  (see `src/lib/rlusd.ts`, x402 payment flow in `src/lib/x402.ts`).

## Deploy gotchas

1. **Vercel build cache must be UNCHECKED** when deploying. Stale cache produces
   broken builds (Prisma client / env drift). Always redeploy with cache off.
2. **PowerShell `Select-String` needs `-LiteralPath`** on bracketed paths.
   Next.js route dirs like `src/app/verify/[certId]/` contain `[]`, which
   PowerShell treats as glob wildcards — `Select-String path/[certId]/file`
   silently matches nothing. Use `Select-String -LiteralPath ...`.
