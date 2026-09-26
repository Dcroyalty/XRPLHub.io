# AUTONOMY — what runs unattended, what needs a human, and when

Written 2026-09-20 (audit of commit `a10d4ba` plus the monitoring/watchdog work). Facts below were read from the
live ledger, the registries, Vercel, Neon and the code on that date; anything inferred is marked **(inferred)**.

## 1. Posture

The site is a Next.js app on Vercel (Node 24.x) with a Neon Postgres database. Everything customer-facing is
request-driven. Two Vercel crons do the periodic work. **Nothing needs a deploy to keep working.** What can
silently stop is anything that depends on an outside party's clock or wallet: a domain, an XNS name, an API key,
a public node, a funded wallet. The watchdog (`src/lib/watchdog.ts`) turns those into messages on the error
webhook; this file says what it watches and what you must still do by hand.

## 2. What runs on its own

| When (UTC) | Route | Does |
|---|---|---|
| 06:00 daily | `/api/cron/index-credentials` | sanctions-list refresh (OFAC SDN, EU FSF, UK Sanctions List — each independent, each integrity-gated) → **continuous-monitoring pass** (checks, observations, webhook delivery) → XLS-66 borrower sweep (no-op until activation) → daily Merkle anchors (OFAC screening, lending, underwrite, monitoring) → heartbeat → cross-check of the other cron |
| 07:00 daily | `/api/cron/index-mpts` | MPT registry refresh + anchor → health probe (alerts on anything red) → **watchdog (full)** → heartbeat → weekly "alive" message |

Both need `CRON_SECRET` (set in Vercel production). Vercel does not retry a cron invocation; each run resumes where
the last one stopped (every long job is deadline-aware and resumable).

## 3. Amendment gates — all read the ledger at request time

There is **no build-time or deploy-time activation switch anywhere** (searched `src/` for activation flags: none;
every gate route is `force-dynamic`). One shared gate, `src/lib/amendments.ts`, reads the singleton `Amendments`
ledger object (index `7DB0788C…6EF4`, validated ledger) through the rotated node pool. "Active" is remembered
forever (an enabled amendment cannot be disabled); "inactive" is re-read after 10 minutes; if the ledger cannot be
read the answer is `unknown` and lending **fails closed** while MPT copy fails toward the hedged wording.

| Gate | Read in | Consumers (live the moment the amendment is enabled) |
|---|---|---|
| **LendingProtocol (XLS-66)** | `lendingProtocolActive()` in `src/lib/lendingLedger.ts` → `getAmendmentStatus("LendingProtocol")` | `/api/lending/exposure`, `/api/x402/lending/exposure`, `/api/x402/lending/underwrite`, MCP `get_lending_exposure` / `get_underwriting_inputs`, the daily borrower sweep (`lendingSweep.ts`, cron 06:00), and the monitoring engine's loan events (`monitorEngine.ts`, evaluated each pass) |
| **DynamicMPT (XLS-94)** and **ConfidentialTransfer (XLS-96)** | `getAmendmentStatuses([...])` in `src/lib/mptPermanence.ts` | `/api/mpt/permanence`, `/api/mpt/search`, `/api/mpt/issuer` — the permanence / confidential-holder copy flips by itself |
| SingleAssetVault (XLS-65) | not consumed by product code (vault profiles are not built) | the watchdog only announces its activation |

When LendingProtocol or SingleAssetVault first reads `active`, the watchdog posts one message ("XLS-66 is now ACTIVE …")
to the error webhook. If the amendment reader itself cannot read the ledger for a run, the watchdog warns
(`amendment-reader`) — otherwise activation could pass unnoticed.

Already-live features (Credentials/XLS-70, PermissionedDomains, MPTokensV1) are used with no gate.

## 4. Things that expire, run out or get revoked

| Item | State on 2026-09-20 | Renews how | Detected by |
|---|---|---|---|
| **xrplhub.io** | expires **2027-05-23** (1-year term, registry RDAP) | Porkbun auto-renew (needs a valid card) | watchdog `domain-expiry` (warn 45d, red 14d) |
| **xrplhub.com** | expires **2027-08-26** | Porkbun auto-renew | same |
| **kreditkarma.us** | expires **2027-05-04** (now only redirects to www) | Porkbun auto-renew | same |
| **XRPNS names** (`xrplhub.xrp`, `kreditkarma.xrp`, `ledgerscore.xrp`) | expire **2027-05-25 / 2027-05-11 / 2027-05-21** | **NOT automatic** — renew at app.xrpns.com/renewal | watchdog `xns-expiry` (warn 60d, red 14d) |
| TLS certificates (Let's Encrypt via Vercel) | `www.xrplhub.io` valid to 2026-10-22; `xrplhub.com` 2026-11-24; `www.kreditkarma.us` 2026-12-11 | Vercel renews ~30 days before expiry | watchdog `tls-cert` (red < 10 days) |
| Mainnet XLS-70 credential (`io.xrplhub.score.v1.min750`) | expires **2026-12-03** | **Manual** — the issuer seed is deliberately off Vercel; `scripts/issue-credential.cjs` on your machine. Letting it lapse only makes `/api/credentials/verify` say "expired" | watchdog `credential-expiry` (warn 45d, red 14d) |
| Anchor wallet `r9dQS1…XuJXb` | ~1.0 XRP spendable; an anchor costs ~0.00001 XRP (≤4 a day) — decades of headroom | top up if the base reserve is ever raised | watchdog `anchor-wallet` (warn < 0.5, red < 0.25) |
| Neon database (project `kreditkarma`) | 10.8 MB of the 512 MB free-tier branch limit; **6-hour point-in-time history only**; maintenance window Sundays 05:00–06:00 UTC | upgrade plan if it fills | watchdog `db-size` (warn 70%, red 90%) |
| `UsageRecord` table | one row per metered API call, never pruned — the first table to grow under real load (≈1M calls/month ≈ 1 GB/year) | prune or upgrade | `db-size` |
| Sanctions feeds (OFAC SDN, EU FSF, UK Sanctions List) | each list re-confirmed daily; a new snapshot only when its content changes (EU/UK change rarely). A refused (gated) snapshot alerts and the previous one stays in force. Screening FAILS CLOSED (503) if any list has no snapshot. | none; the EU download uses a public token URL and the UK file location has moved once (OFSI closed 2026-01-28) — a publisher format change shows up as a refused snapshot + alert | watchdog `ofac-sdn` (covers all three; freshness = last confirmed; warn 4d, red 8d) |
| Screening retention promise (`retain-10y-no-prune/v1`) | receipts, leaves, anchors and every list snapshot's canonical archive are never pruned by any process (only the derived per-address lookup rows of a snapshot >6 h superseded are dropped; the archive stays). Growth ≈ 75 KB/day compressed for OFAC vintages + receipts. | **Owner decision:** a 10-year promise is not backed by a 512 MB free-tier database with 6-hour history. Move to a paid plan and/or archive `GET /api/attest/export` off-platform before relying on it. | watchdog `db-size` |
| Public XRPL nodes (8 hard-coded hosts) | all healthy today; several are hobbyist hosts | edit `XRPL_NODES` in `src/lib/xrplNodes.ts` | watchdog `xrpl-nodes` (warn ≤ 5 healthy, red ≤ 2) |
| Bithomp API key (free tier 10 req/min, 2K/day) | accepted | replace if revoked | watchdog `bithomp-key` (red on 401/403) — without it the MPT registry silently stops refreshing holder counts |
| XRP/USD price sources (CoinGecko + Coinbase, keyless) | both up | none | watchdog `xrp-price` (warn if BOTH fail: XRP checkout is refused) |
| Xaman (XUMM) API key/secret | present, no expiry | rotate only if revoked | `createPayload` alerts loudly on rejection; health probe |
| Coinbase CDP key (x402 USDC on Base) | present; **usage limits / billing of the CDP facilitator not verified** | check the CDP portal | health deep probe (reachability only, not key validity) |
| t54 x402 facilitator (XRPL x402) | external service | none | health deep probe |
| `ERROR_WEBHOOK_URL` (Discord/Slack) | set | recreate if the webhook is deleted | **the weekly heartbeat message stops** (see §6) |
| Vercel plan | **(inferred)** Hobby: 2 crons/day, 60 s functions | — | not detectable from inside; see §7 |

## 5. What breaks first, in order (if nobody touches anything)

Dated items first; undated risks after.

1. **2026-10-22** — TLS certs renew themselves. No action.
2. **2026-12-03** — the one mainnet credential expires (verify says "expired"). Cosmetic; re-issue is manual and optional.
3. **~6 months (Mar 2027)** — *nothing is scheduled to expire.* The realistic first failures are undated: an OFAC feed change (red within 8 days), a public node going away (warn as the healthy count drops), a revoked key, or Vercel/Neon changing plan terms.
4. **2027-05-04** — kreditkarma.us (redirect only). Auto-renew; if it lapses the old brand's links stop redirecting.
5. **2027-05-11 / 05-21 / 05-25** — **the first thing that needs a human.** The three XRPNS names expire and do not auto-renew. The homepage shows `xrplhub.xrp` as the pay-to name; funds and the treasury address are unaffected, but the name would stop resolving. **Extend them now** (app.xrpns.com/renewal; the extension feature exists) and this item disappears for the term you buy.
6. **2027-05-23 / 2027-08-26** — xrplhub.io / xrplhub.com renew (~8 and ~11 months out). If the card on file has expired the watchdog turns red 14 days before.
7. **~12 months (Sep 2027)** — any registration you did not extend repeats annually. Neon/Vercel free-tier terms are the main external unknown.
8. **~24 months (Sep 2028)** — **Node 24 reaches end-of-life 2028-04-30**; Vercel retires EOL runtimes some time after that. Existing deployments keep running until the platform retires the runtime, but the first forced upgrade (or a security advisory in `next` / `prisma` that nothing auto-updates) lands in this window. Domains and any 1-year XNS renewals come due again in May–Aug 2028.

## 6. Loud failure — how you find out

`notifyError` posts to `ERROR_WEBHOOK_URL`. The watchdog adds, on the daily crons:
- **cron heartbeats** — each cron writes a heartbeat at the *end* of a successful run and checks the other's (red if > 36 h stale). A run that times out at 60 s writes none, so it shows up.
- red/warn findings, de-duplicated (red re-alerts every 3 days, warn every 7), one message on recovery.
- a **weekly "Alive. All checks green" message** — its *absence* is the signal that both crons, the database, or the webhook itself died.
- `notifyInfo` for non-errors (recoveries, "XLS-66 is now ACTIVE").

Nothing inside the app can report the death of the whole platform. **Optional but recommended:** create a free
healthchecks.io check (period 1 day, grace 2 days) and set `HEALTHCHECK_PING_URL` in Vercel — each cron pings it on
completion, and that service emails you if both stop.

Crons: if a run throws, it returns 500 and `notifyError` fires immediately; if it keeps failing you get that alert
daily *and* the other cron reports the stale heartbeat after 36 h; if `CRON_SECRET` is unset both 401 (health probe: red).
Every job in a run is wrapped so one failure cannot stop the rest (`.catch → notifyError`).

## 7. What still needs a human — and the honest gaps

Once, before leaving:
1. `POST /api/health` (admin token) — confirm a test alert really lands in the channel.
2. Set `HEALTHCHECK_PING_URL` (above).
3. **Extend the three XRPNS names** for several years.
4. Confirm the Porkbun card expiry is after the last domain renewal you care about.
5. Delete unused secrets from Vercel production: `ANTHROPIC_API_KEY`, `XAI_API_KEY` (no code path uses an LLM), `ADMIN_PASSWORD`, `ADMIN_SECRET`, `TREASURY_WALLET`, and the three `TREASURY_SIGNER_*_SEED` + `TREASURY_QUORUM` — the only code that reads the signer seeds is `scripts/` and the unused signing functions in `src/lib/treasury.ts`, and the on-ledger treasury has no signer list; a Vercel compromise would expose them.
6. Decide on email: `RESEND_API_KEY` is **not set**, so `/api/send-email` silently skips purchase/grant confirmations. Note the route is unauthenticated — if you ever set the key it becomes an open mail relay from `noreply@xrplhub.io`; add auth before enabling it.
7. Consider the Vercel plan: Hobby's terms are for non-commercial use and the site takes payments **(inferred plan)**; nothing inside can detect a suspension.
8. Consider a longer Neon history/backups: the free tier keeps only 6 hours.

Known silent-by-design: last-used timestamps, the score-cache upsert and counter flushes swallow errors (harmless). Grants are paused (`GRANT_APPLICATIONS_OPEN=false`), so the two approved-but-unpaid grants wait for a human.

## 8. If something looks wrong after a long absence — check in this order

1. Was the weekly heartbeat received recently? (No → webhook, both crons or the platform.)
2. `GET https://www.xrplhub.io/api/health?deep=1` — reds first.
3. Vercel → project → Deployments (latest READY?) and Logs for `/api/cron/*`; Cron Jobs tab (both scheduled?).
4. Neon console → project `kreditkarma`: suspended? size? quota?
5. Registrar (Porkbun) → domains; app.xrpns.com → names; `dig`/RDAP for expiry.
6. The watchdog's open findings (they repeat in the channel).
7. `node scripts/check-service-parity.mjs`, `npm audit`, and whether Vercel announced a Node runtime retirement.
8. Rotate anything revoked (Bithomp, XUMM, CDP), then redeploy with the Vercel build cache **off**.
