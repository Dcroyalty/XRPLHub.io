# AUTONOMY — what runs unattended, what needs a human, and when

Written 2026-09-20 (audit of commit `a10d4ba` plus the monitoring/watchdog work). Facts below were read from the
live ledger, the registries, Vercel, Neon and the code on that date; anything inferred is marked **(inferred)**.

## 0. Every date a human must act on — quick reference

One table, everything with a real date anywhere in this file. Full context for each row is in the numbered
section linked. Sorted soonest first.

| Date | Item | If missed | Action needed |
|---|---|---|---|
| 2026-10-22 | TLS certs renew | — | None — automatic. |
| 2026-12-03 | XRPLHub's own mainnet credential expires (§7#2) — **not a Bitstamp credential; there is no Bitstamp integration in this codebase**, this is the one on-ledger credential XRPLHub itself issued on mainnet | `/verify` shows "expired" for it — cosmetic only | None required; re-issue is manual and optional. |
| 2027-05-04 | kreditkarma.us redirect-only domain renews (§7#4) | Old-brand links stop redirecting | None — auto-renew, unless the card on file has lapsed. |
| 2027-05-11 / 05-21 / 05-25 | The three XRPNS names expire (§7#5) — **do NOT auto-renew** | `xrplhub.xrp` (the pay-to name shown on the homepage) stops resolving. Funds and the treasury address are unaffected — this is cosmetic/discovery only, not a funds risk | **Extend now** at app.xrpns.com/renewal — this is the first thing on this whole list that actually needs a human before it happens on its own. |
| 2027-05-23 | xrplhub.io renews (§7#6) | Domain lapses | None if the card on file is valid — watchdog turns red 14 days before if it's expired. |
| 2027-08-26 | xrplhub.com renews (§7#6) | Same as above | Same as above. |
| 2027-09-28 | The fine-grained `GITHUB_TOKEN` (screening-backup repo PAT, §6), scoped to `Dcroyalty/xrplhub-screening-backups`, created 2026-09-28 | Off-Neon screening-receipt backup stops (loudly — watchdog `screening-backup` goes warn→red, never silent) | Rotate it before this date: create a new fine-grained PAT (same scope, see §6/§9 steps), set it as `GITHUB_TOKEN` in Vercel, redeploy. |
| ~Sep 2027 | Any registration not otherwise extended repeats annually (§7#7) | — | Check Neon/Vercel free-tier terms haven't changed. |
| 2028-04-30 | Node 24 reaches end-of-life (§7#8) | Vercel eventually retires the runtime; security advisories in `next`/`prisma` stop being safe to ignore | Plan a Node upgrade before Vercel forces one. |
| May–Aug 2028 | Domains / any 1-year XNS renewals come due again (§7#8) | Same as their 2027 entries | Same as their 2027 entries. |

## 1. Posture

The site is a Next.js app on Vercel (Node 24.x) with a Neon Postgres database. Everything customer-facing is
request-driven. Two Vercel crons do the periodic work. **Nothing needs a deploy to keep working.** What can
silently stop is anything that depends on an outside party's clock or wallet: a domain, an XNS name, an API key,
a public node, a funded wallet. The watchdog (`src/lib/watchdog.ts`) turns those into healthchecks.io `/fail`
pings that email you (§8); this file says what it watches and what you must still do by hand.

## 2. What runs on its own

| When (UTC) | Route | Does |
|---|---|---|
| 06:00 daily | `/api/cron/index-credentials` | sanctions-list refresh (OFAC SDN, EU FSF, UK Sanctions List — each independent, each integrity-gated) → **continuous-monitoring pass** (checks, observations, webhook delivery) → XLS-66 borrower sweep (no-op until activation) → daily Merkle anchors (OFAC screening, lending, underwrite, monitoring) → heartbeat → cross-check of the other cron |
| 07:00 daily | `/api/cron/index-mpts` | MPT registry refresh + anchor → **Spend Controls Autopay** (sends each due pre-approved payment, never early; failures reported, never retried) → subscription check pushes → health probe (alerts on anything red) → **watchdog (full)** → heartbeat → weekly "alive" message |

**Autopay needs `SPEND_AUTOPAY_KEY`** (≥ 32 chars, Vercel production). Without it Autopay is off and fails closed. It encrypts
the stored pre-approved payments (sha256 of the key → AES-256-GCM). There is no backup and no second copy.
- CHANGED: every stored payment becomes unreadable. Each fails once, in its own period (never sent, never retried): RED line
  in the healthchecks.io ping, the payer is pushed a normal check, the payee's link shows it. Its ticket stays on the ledger
  (0.2 XRP held) until the payer releases it from the dashboard. Putting the ORIGINAL key back restores the rows not yet failed.
- REMOVED: the cron sends nothing, a RED line says how many due payments were not sent, and those periods stop counting
  as covered, so payers are pushed normal checks. Restoring the original key resumes sending (within each period's window).
Never rotate it while payments are scheduled.

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
| **PermissionDelegationV1_1 (XLS-75)** | `serviceAvailability()` in `src/lib/serviceAmendments.ts` (map `SERVICE_REQUIRED_AMENDMENT`) | storefront service `delegate`: the builder (so `/api/execute`, `/api/x402/tx` and the free preview), `/api/create-payment` (no payment can be created while inactive), `/api/x402/tx` `refuse()` (no 402 challenge while inactive), the free revoke `/api/delegate`, the Buy button (`/api/services/availability`). Majority since 2026-09-24 21:25 UTC → earliest activation **2026-10-08 21:25 UTC**. Nothing to do at activation. |
| SingleAssetVault (XLS-65) | not consumed by product code (vault profiles are not built) | the watchdog only announces its activation |
| **LendingProtocol + SingleAssetVault together** | `lendingLive()` in `src/lib/lendingTracker.ts` | XRPL Lending phase 2 (§23): the vault/broker/loan index and risk grades in the hourly job, `/lending/vaults`, `/lending/vault/[id]`, `/lending/broker/[id]`, the Lending Pro routes. Nothing to do at activation. |

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
| Mainnet XLS-70 credentials — 4 families now (score, mpt-declared, screen-nomatch, domain-verified) | the one issued credential (`io.xrplhub.score.v1.min750`) expires **2026-12-03**; see §5 for the other three families' request queues, which are hand-issued the same way | **Manual, by design** — see §5 | watchdog `credential-expiry` covers only the score credential today (warn 45d, red 14d) — **the other three families and the request queue itself have no watchdog coverage; see §5's gap note** |
| Anchor wallet `r9dQS1…XuJXb` | ~1.0 XRP spendable; an anchor costs ~0.00001 XRP (≤4 a day) — decades of headroom | top up if the base reserve is ever raised | watchdog `anchor-wallet` (warn < 0.5, red < 0.25) |
| Neon database (project `kreditkarma`) | 10.8 MB of the 512 MB free-tier branch limit; **6-hour point-in-time history only**; maintenance window Sundays 05:00–06:00 UTC | upgrade plan if it fills | watchdog `db-size` (warn 70%, red 90%) |
| `UsageRecord` table | one row per metered API call, never pruned — the first table to grow under real load (≈1M calls/month ≈ 1 GB/year) | prune or upgrade | `db-size` |
| Sanctions feeds (OFAC SDN, EU FSF, UK Sanctions List) | each list re-confirmed daily; a new snapshot only when its content changes (EU/UK change rarely). A refused (gated) snapshot alerts and the previous one stays in force. Screening FAILS CLOSED (503) if any list has no snapshot. | none; the EU download uses a public token URL and the UK file location has moved once (OFSI closed 2026-01-28) — a publisher format change shows up as a refused snapshot + alert | watchdog `ofac-sdn` (covers all three; freshness = last confirmed; warn 4d, red 8d) |
| Screening retention promise (`retain-10y-no-prune/v1`), **approved 2026-09-28** | receipts, leaves, anchors and every list snapshot's canonical archive are never pruned by any process (only the derived per-address lookup rows of a snapshot >6 h superseded are dropped; the archive stays). Growth ≈ 75 KB/day compressed for OFAC vintages + receipts. Now backed by a daily off-Neon copy (see §6) — but Neon itself is still 6-hour history, so the *live, queryable* copy has no long-term guarantee of its own. | **Owner decision still open:** the off-Neon backup makes the receipts survivable, not queryable at scale for 10 years. Consider a paid Neon plan for real point-in-time recovery. | watchdog `db-size`, `screening-backup` |
| Public XRPL nodes (8 hard-coded hosts) | all healthy today; several are hobbyist hosts | edit `XRPL_NODES` in `src/lib/xrplNodes.ts` | watchdog `xrpl-nodes` (warn ≤ 5 healthy, red ≤ 2) |
| Bithomp API key (free tier 10 req/min, 2K/day) | accepted | replace if revoked | watchdog `bithomp-key` (red on 401/403) — used ONLY for free MPT-registry issuance discovery (never paid responses, never holder counts — those come from Clio mpt_holders since 2026-10-06); without it new issuers are found only by the ledger walk |
| XRP/USD price sources (CoinGecko + Coinbase, keyless) | both up | none | watchdog `xrp-price` (warn if BOTH fail: XRP checkout is refused) |
| Xaman (XUMM) API key/secret | present, no expiry | rotate only if revoked | `createPayload` alerts loudly on rejection; health probe |
| Coinbase CDP key (x402 USDC on Base) | present; **usage limits / billing of the CDP facilitator not verified** | check the CDP portal | health: config-only (keys set) since 2026-10-06 — no request to CDP; a real failure shows up as failed paid calls, not a probe |
| t54 x402 facilitator (XRPL x402) | external service | none | health deep probe |
| `ERROR_WEBHOOK_URL` (Discord/Slack) | set, but read by no one | none — alerts go to healthchecks.io (§8) | nothing |
| `HEALTHCHECK_PING_URL` (healthchecks.io) | set | recreate the check if deleted | **no alert email of any kind** (§8) |
| Vercel plan | **(inferred)** Hobby: 2 crons/day, 60 s functions | — | not detectable from inside; see §9 |

## 5. Credential issuance & cleanup — automatic since 2026-09-29

**This reverses what this section said before.** Issuance and cleanup used to be hand-run by design,
specifically because `CREDENTIAL_ISSUER_SEED` was never on Vercel. The owner made the deliberate call to
change that — moving the seed onto Vercel so the cron can sign directly — with real guardrails attached
(below), not as a casual flip. Read this whole section before touching any of it.

**Verified live in production, 2026-09-29:** `CREDENTIAL_ISSUER_SEED` is set, `npx prisma db push` has
run, and `GET /api/cron/index-credentials` (admin token) returned `autoIssuance.ran: true` /
`credentialCleanup.ran: true` with no dormant-seed reason string — this is genuinely running, not just
capable of running. The queue was empty at verification time (`processed: []`), so the first real
automatic issuance/cleanup hasn't happened yet; check the next cron's response for actual activity.

**Known watchdog false-positive from before this system existed, reconcile or dismiss by hand:** the very
first `credential-anomaly` run (also 2026-09-29) scanned the issuer's full history back to genesis and
flagged exactly one `CredentialCreate` — tx `3C5D2EE4C905B82F...`, subject `rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`,
type `io.xrplhub.score.v1.min750`, dated 2026-09-04 (the mainnet XLS-70 launch day, commit `c265bdb`).
It has no row in `CredentialRequest`, `IndexedCredential`, or the older `ScoreCredential` table in any
form — almost certainly a manual launch-day smoke test issued directly via CLI, before this bookkeeping
existed, not misuse. The watchdog is correct to flag it (it has no way to know that); it will stay red on
every run until a human either backfills a `CredentialRequest` row with `issuedTxHash` set to that hash
(status `issued`) to teach the watchdog about it, or confirms it's fine and leaves it. Not fixed by this
commit — deliberately left for the owner to decide rather than editing production bookkeeping on an
inference.

**What runs automatically now, both in `cron/index-credentials` (06:00 UTC), both a genuine no-op if
`CREDENTIAL_ISSUER_SEED` is unset — same dormant-until-set posture the screening backup (§6) already
established:**
- `runAutoIssuance()` (`src/lib/credentialAutoIssue.ts`) — processes the `CredentialRequest` queue,
  oldest first, up to 5 per run. Every family re-verifies the underlying fact FRESH immediately before
  signing (re-scores, re-screens, or re-checks the domain link — never trusts what the request was
  queued under): `issueScoreCredential`, `issueMptDeclaredCredential`, `issueScreenCredential`,
  `issueDomainCredential`. A request that no longer qualifies is marked `failed` with the reason, not
  retried forever.
- `runExpiredCredentialCleanup()` (`src/lib/credentialCleanup.ts`) — deletes unaccepted credentials more
  than 7 days past expiry, up to 10 per run, reclaiming issuer reserve. Same policy the old
  `cleanup-unaccepted-credentials.mjs` used; accepted credentials are never touched (that reserve belongs
  to the subject).

**Guardrails:**
1. **Fresh re-verification at signing** — see above; this was already true of the hand-run scripts and
   nothing here weakens it.
2. **Daily issuance cap** — `CREDENTIAL_DAILY_CAP` (default **20**), counted live from the database
   (`CredentialRequest.status='issued'` since UTC midnight), not an in-memory counter, so it can't drift
   across deploys. A run that would exceed it stops and leaves the rest queued for tomorrow.
3. **Per-run cap** — 5 issuances / 10 deletions per cron pass, same bounded-step pattern every other
   piece of this cron already uses.
4. **Ledger-based anomaly watchdog** — `src/lib/credentialAnomalyWatch.ts`, wired into `runWatchdog` as
   `credential-anomaly`. Reads the issuer's own `account_tx` history (checkpointed, incremental) and
   flags any `CredentialCreate` from `EXPECTED_ISSUER` that doesn't match a `CredentialRequest` row this
   app marked `issued`. This is deliberately ledger-first: it trusts nothing about how a credential got
   onto the chain, so it catches misuse even if the seed itself were stolen and used from somewhere
   outside this codebase entirely — a stolen-key issuance still shows up as a `CredentialCreate` on the
   ledger, and it still won't match anything in the database.

**The hand-run scripts still exist and still work** (`scripts/issue-queued-credentials.cjs`,
`scripts/cleanup-unaccepted-credentials.mjs`) — useful for a backlog that needs attention faster than the
next cron pass, or if `CREDENTIAL_ISSUER_SEED` is ever pulled from Vercel again and this reverts to the
old hand-run posture with zero code changes needed.

**What still needs a human:** approving the underlying REQUEST in the first place is not automated and
was never meant to be for `score`/`mpt-declared` (both are "we issue because you already engaged us" --
no separate approval gate) or `screen-nomatch`/`domain-verified` (both self-serve, gated by the live
re-check itself, not a person). Nothing about this automation added a new approval step; it only
automated the SIGNING of requests that were already going to be issued.

## 6. The 10-year screening-receipt retention obligation — what it actually requires

Approved by the owner 2026-09-28. What "at least 10 years, never pruned" (`retain-10y-no-prune/v1`, stated in every
receipt and at `/legal/screening#retention`) commits to, concretely:

1. **Every screening receipt, its canonical leaf, and the data to rebuild its Merkle inclusion proof** stay retrievable
   for 10 years from the date it was screened.
2. **The on-ledger anchor record** (root, tx hash, ledger index) for the batch each receipt landed in.
3. **The canonical archive of every sanctions-list snapshot** a receipt refers to (so a decade from now, the exact
   file a receipt was compared against can still be re-obtained and re-hashed — not just cited by name).
4. **No process may prune, edit or delete any of the above.** `src/lib/sanctionLists.ts`'s `compactSuperseded()` only
   ever drops a superseded snapshot's *derived per-address lookup rows* (a search index) once it has been superseded
   for 6+ hours — the archive itself, and every receipt, is untouched by any code path in this repo.

**What backs the promise today:**
- **Neon Postgres** — the live, queryable copy. Fast, but only 6-hour point-in-time history on the current plan, and
  subject to whatever happens to the Neon account or plan over 10 years.
- **An independent, off-Neon copy** (`src/lib/screenBackup.ts`) — once a day, the 06:00 UTC cron writes every receipt
  screened the previous UTC day to `backups/screening-receipts/<date>.jsonl` in a **separate, PRIVATE** GitHub repo,
  `Dcroyalty/xrplhub-screening-backups` (NOT the public app repo), via the GitHub Contents API. Each line is a
  self-contained, independently-verifiable receipt (canonical leaf, leaf hash, statement, and — once anchored — the
  inclusion proof and anchor tx hash), not just a database dump; someone with that file could verify every receipt in
  it against the XRP Ledger. Deterministic and idempotent: re-running a day produces byte-identical content, so it's
  safe to re-run as often as you like.
- **Retention is not publication.** A receipt contains `subjectAddress` and `requestedBy` (a customer's own API key
  prefix) — that's every counterparty a customer screened, and when. Keeping it for 10 years is the promise;
  making it public is a privacy violation a VASP customer cannot accept. The anchored Merkle root is meant to be
  public (that's the point of anchoring); the leaf/receipt data behind it is not. **Incident, 2026-09-28:** the
  backup was first built pointing at the public `Dcroyalty/XRPLHub.io` repo and ran for 8 days before being caught,
  landing 28 receipts in public commit history. All 28 were internal — the owner's own test/verification traffic,
  including the `xrs_live_K1SAsz8...` key (labeled "screening-demo" in `ApiKey`, minted 2026-09-07 for exactly this
  purpose) and the platform's own monitoring of its own wallets. No third-party customer's receipts were exposed.
  Fixed same day regardless: migrated to the private repo above, purged from the public repo's git history via
  `git filter-branch` + force-push, `DEFAULT_REPO` in `screenBackup.ts` corrected. Caveat: a force-push rewrites
  the repo, but GitHub's/any CDN's blob cache is not guaranteed to drop old content instantly — the exposure window
  is real even though nothing exposed was a live customer's.
- **This requires `GITHUB_TOKEN`** — a **fine-grained** PAT scoped ONLY to `Dcroyalty/xrplhub-screening-backups`,
  Contents: Read and write, and nothing else. Never a classic repo-scope PAT (those reach every repo the account
  owns, including the public one — how the incident above happened). **Set in Vercel production as of 2026-09-28,
  expires 2027-09-28** (see §0's dates table — rotate it before then, or the backup silently stops until replaced,
  loudly flagged by watchdog `screening-backup` going `warn`/`red`, never silent). `node
  scripts/backup-screening-receipts.mjs --all` runs the same logic by hand from a machine that has that token set
  locally. It is deliberately a DIFFERENT token from whatever pushes to the public app repo — they must never be the
  same credential again.

**What is NOT yet true, and is the owner's decision:**
- A GitHub repo is a real second copy, but it is still one provider. A third, geographically/organizationally
  independent copy (e.g. a periodic export to cloud storage you control) would be stronger for a 10-year horizon —
  not built.
- The off-Neon copy is a flat file archive, not queryable — recovering "every receipt for address X" from it means
  scanning JSONL files, not running a query. Fine for disaster recovery, not a replacement for Neon's own durability.
- Neon's 6-hour point-in-time history has not been upgraded. A Neon-side data-loss event more than 6 hours old would
  still mean rebuilding the live database from the GitHub backup by hand — the backup exists, but nothing automates
  restoring FROM it.

## 7. What breaks first, in order (if nobody touches anything)

Dated items first; undated risks after.

1. **2026-10-22** — TLS certs renew themselves. No action.
2. **2026-12-03** — the one mainnet credential expires (verify says "expired"). Cosmetic; re-issue is manual and optional.
3. **~6 months (Mar 2027)** — *nothing is scheduled to expire.* The realistic first failures are undated: an OFAC feed change (red within 8 days), a public node going away (warn as the healthy count drops), a revoked key, or Vercel/Neon changing plan terms.
4. **2027-05-04** — kreditkarma.us (redirect only). Auto-renew; if it lapses the old brand's links stop redirecting.
5. **2027-05-11 / 05-21 / 05-25** — **the first thing that needs a human.** The three XRPNS names expire and do not auto-renew. The homepage shows `xrplhub.xrp` as the pay-to name; funds and the treasury address are unaffected, but the name would stop resolving. **Extend them now** (app.xrpns.com/renewal; the extension feature exists) and this item disappears for the term you buy.
6. **2027-05-23 / 2027-08-26** — xrplhub.io / xrplhub.com renew (~8 and ~11 months out). If the card on file has expired the watchdog turns red 14 days before.
7. **~12 months (Sep 2027)** — any registration you did not extend repeats annually. Neon/Vercel free-tier terms are the main external unknown.
8. **~24 months (Sep 2028)** — **Node 24 reaches end-of-life 2028-04-30**; Vercel retires EOL runtimes some time after that. Existing deployments keep running until the platform retires the runtime, but the first forced upgrade (or a security advisory in `next` / `prisma` that nothing auto-updates) lands in this window. Domains and any 1-year XNS renewals come due again in May–Aug 2028.

## 8. Loud failure — how you find out

**healthchecks.io is the only alert channel (changed 2026-09-30).** The operator has no Discord/Slack, so
`ERROR_WEBHOOK_URL` — although still set in Vercel — reaches no one; `notifyError`/`notifyInfo` are now effectively
log lines. What emails you:
- **Any open RED → `HEALTHCHECK_PING_URL/fail`** at the end of each cron (`pingHealthcheckForRun` in
  `src/lib/watchdog.ts`); healthchecks.io emails immediately, and the email carries the ping body: a plain-text list
  of every open RED (and the warnings). "Open RED" = any watchdog finding currently red — including ones only the
  *other* cron checks (the level is kept in the alert row's `marker`, so the 06:00 cron can't mask a RED the 07:00
  cron found) — plus index-mpts's money-path health reds, plus the watchdog itself throwing.
- **A cron crashing** (returns 500) → `/fail` from its catch block.
- **Missed pings** → healthchecks.io emails after the grace period: both crons stopped, Vercel, or the database is down.
- Otherwise each cron sends a success ping. **Warnings never email** — they ride along in the ping body (visible on
  the check's page in healthchecks.io) and in the cron JSON/logs.
- **cron heartbeats** — each cron writes a heartbeat at the *end* of a successful run and checks the other's (red if > 36 h stale). A run that times out at 60 s writes none, so it shows up.

Recommended check settings: period 1 day, grace 3 hours (both crons ping it, at 06:00 and 07:00).

Per-event failures that are NOT watchdog findings (a single x402 settlement failing, one monitor webhook failing)
go to `notifyError` only — logs, not email. Their lasting effects are what the watchdog checks (stale lists,
unanchored attestations, backlog), so those turn red and email.

## 9. What still needs a human — and the honest gaps

Once, before leaving:
1. ~~`POST /api/health` (admin token) — confirm a test alert really lands in the channel.~~ Superseded 2026-09-30: the webhook is not read; alerts are healthchecks.io `/fail` pings (§8).
2. ~~Set `HEALTHCHECK_PING_URL`~~ **Done 2026-09-29** — set in Vercel production, confirmed firing on every cron completion.
3. **Extend the three XRPNS names** for several years.
4. Confirm the Porkbun card expiry is after the last domain renewal you care about.
5. ~~Delete unused secrets from Vercel production~~ **Done 2026-09-29** — `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_SECRET`, `TREASURY_WALLET`, the three `TREASURY_SIGNER_*_SEED`, and `TREASURY_QUORUM` removed from Vercel production; confirmed absent from the env list and confirmed nothing broke (`/api/health?deep=1` clean, admin auth — which runs on the separate `ADMIN_API_TOKEN` — still works).
6. Decide on email: `RESEND_API_KEY` is **not set**, so `/api/send-email` silently skips purchase/grant confirmations. Note the route is unauthenticated — if you ever set the key it becomes an open mail relay from `noreply@xrplhub.io`; add auth before enabling it.
7. Consider the Vercel plan: Hobby's terms are for non-commercial use and the site takes payments **(inferred plan)**; nothing inside can detect a suspension.
8. Consider a longer Neon history/backups: the free tier keeps only 6 hours.
9. ~~Create a fine-grained GitHub PAT scoped ONLY to `Dcroyalty/xrplhub-screening-backups`~~ **Done 2026-09-28** —
   set as `GITHUB_TOKEN` in Vercel production, expires 2027-09-28 (§0). Confirmed running: the daily backup step
   now reports `ran: true` instead of skipping. Steps below kept for the 2027-09-28 rotation: github.com/settings/
   personal-access-tokens/new → Resource owner: Dcroyalty → Repository access: Only select repositories →
   `xrplhub-screening-backups` → Permissions → Repository → Contents: Read and write → leave every other permission
   at No access → Generate. Do NOT use a classic PAT here (§6 explains why).

Known silent-by-design: last-used timestamps, the score-cache upsert and counter flushes swallow errors (harmless). Grants are paused (`GRANT_APPLICATIONS_OPEN=false`), so the two approved-but-unpaid grants wait for a human.

## 10. If something looks wrong after a long absence — check in this order

1. healthchecks.io → the check: last ping time and body (it lists every open RED and warning).
2. `GET https://www.xrplhub.io/api/health?deep=1` — reds first.
3. Vercel → project → Deployments (latest READY?) and Logs for `/api/cron/*`; Cron Jobs tab (both scheduled?).
4. Neon console → project `kreditkarma`: suspended? size? quota?
5. Registrar (Porkbun) → domains; app.xrpns.com → names; `dig`/RDAP for expiry.
6. The watchdog's open findings (the cron JSON's `watchdog.open`, and the healthchecks.io ping body).
7. `node scripts/check-service-parity.mjs`, `npm audit`, and whether Vercel announced a Node runtime retirement.
8. Rotate anything revoked (Bithomp, XUMM, CDP), then redeploy with the Vercel build cache **off**.
9. `node scripts/issue-queued-credentials.cjs` (list-only) — anything queued for a while? Then
   `node scripts/cleanup-unaccepted-credentials.mjs` (list-only) — anything eligible? Neither has watchdog coverage
   (§5), so this is the only way to notice a backlog after time away.

## 11. Known upgrade landmines — read before touching dependencies

**`xrpl.js`: never upgrade past the 4.x line without running the seed-algorithm check first.** Pinned at
`4.6.0` (`package.json` says `^4.0.0`). 5.0.0 changed how `Wallet.fromSeed`/`fromSecret` pick a signing
algorithm when `opts.algorithm` is omitted: 4.x defaulted to ed25519 **unconditionally**, even for a classic
secp256k1-family seed; 5.0.0+ correctly infers it from the seed's own prefix (`sEd…` → ed25519, anything
else → secp256k1). Every `Wallet.fromSeed(seed)` call in this codebase (`anchorMemo.ts`, `credentials.ts`,
`mptAnchor.ts`, `treasury.ts`, and every signing `scripts/*`) omits the algorithm option. If any of those
seeds is not `sEd…`, upgrading silently derives a **different keypair** than the one that's been signing —
wrong-address/wrong-signature, not a crash, and nothing would flag it until a transaction fails or funds
go somewhere unexpected. Before ever upgrading, run this — it prints only the algorithm family, never the
seed itself:
```
node -e "const {decodeSeed}=require('ripple-keypairs');for(const k of ['ANCHOR_WALLET_SEED','CREDENTIAL_ISSUER_SEED','TREASURY_SIGNER_1_SEED','TREASURY_SIGNER_2_SEED','TREASURY_SIGNER_3_SEED']){const v=process.env[k];if(!v){console.log(k,'not set');continue;}try{console.log(k,decodeSeed(v).type);}catch(e){console.log(k,'decode failed:',e.message);}}"
```
Every line must print `ed25519` for the upgrade to be a no-op. Anything else (or a decode failure) means
stop and resolve it first.

**MPP and Batch can't both ship on the current dependency graph.** `xrpl-mpp-sdk` (Ripple's beta SDK for
Stripe/Tempo's Machine Payments Protocol, added in XRPL AI Starter Kit 1.1) pins its `xrpl` peer dependency
to `>=4.0.0 <5.0.0`. **Corrected 2026-10-05 (verified on Devnet, BatchV1_1 + fixBatchV1_2 live):** the 5.1.0+
requirement applies only to MULTI-ACCOUNT batches — BatchV1_1 changed the payload each `BatchSigner` signs, and
xrpl.js 5.0.0's old payload is rejected (`temBAD_SIGNATURE`). A SINGLE-ACCOUNT Batch (every inner transaction from
the signer, no `BatchSigners`) is built, validated, encoded and signed correctly by the pinned 4.6.0: two
CheckCreates in one tfAllOrNothing Batch returned tesSUCCESS, and an all-or-nothing batch with one bad inner applied
nothing. So MPP (needs <5) and single-account Batch can coexist on 4.6; never build a multi-account Batch on 4.x.
BatchV1_1 activates no earlier than 2026-10-09 14:46 UTC.

## 12. Admin-only paid-path health check (2026-09-29)

`adminhealthcheck` (`servicePrices.ts`'s `ADMIN_ONLY_SERVICE_IDS`) is a permanent, real, on-chain proof
that the paid path works end to end — payment verification, single-use claim, delivery — using the
credential issuer's own spendable XRP. It is genuinely gated (`isAdmin()`, not just unlisted) and
`check-service-parity.mjs` asserts it never appears on the homepage or in the public catalog, so it can
never silently become a 35th service. Run it any time: `node scripts/test-paid-path.mjs` (local only —
reads `CREDENTIAL_ISSUER_SEED` and `ADMIN_API_TOKEN` from your local `.env`, neither ever leaves this
machine except the admin token, which goes to xrplhub.io as designed). Costs the issuer ~1 XRP + fees
per run; keep it above the 2 XRP floor the same way §4's reserve check already watches.

## 13. Neon connection pooling — not yet set up, the likely first thing to break under real traffic

Checked 2026-09-29 (pre-launch, ahead of the owner's first YouTube tutorials). `DATABASE_URL` connects
**directly** to Neon Postgres — no `-pooler` endpoint, no `pgbouncer=true`, no explicit
`connection_limit`. Neon's project is on `free_v3`, autoscaling 0.25–2 CU, and **`suspend_timeout_seconds:
0`** — the compute suspends the instant it goes idle, so a request after any quiet period pays a cold
database wake-up on top of Vercel's own lambda cold start (observed live: 9s on a cold hit, 0.4s warm).

Every Vercel serverless invocation that goes cold creates its own `PrismaClient`, and each one opens its
own direct Postgres connection(s) — `xrplscore-db.ts`'s `globalThis` caching only reuses a client *within*
one warm instance, not across the many instances a real traffic spike spins up concurrently. This is the
textbook serverless-Postgres failure mode: a bursty spike (not sustained volume — a video linking here is
exactly this shape) can multiply concurrent connections faster than a request rate limit would suggest,
and Neon's free tier has a real connection ceiling. Hitting it doesn't degrade gracefully — it produces
outright database errors across every route that touches Postgres, which is effectively everything.

**Not fixed yet, needs a deliberate deploy (not done same-night as this note):** switch `DATABASE_URL` to
Neon's pooled connection string (`-pooler` host, or `pgbouncer=true`) — get it from the Neon console
(console.neon.tech → this project → Connection Details → toggle "Pooled connection"), set it in Vercel
production, redeploy. This is the standard fix for exactly this architecture and should be low-risk, but
changing the primary database connection string is not something to do unverified right before a traffic
spike is expected — schedule it with a quiet window to confirm nothing broke.

## 15. Storefront auto-detection (2026-09-29)

`src/lib/purchaseIntent.ts` -- a manually-sent storefront payment (no Xaman, no injected wallet, no hash
ever pasted) is now caught two ways: a client-side poll by destination tag while the tab is open (fast),
and a cron sweep (`sweepPurchaseIntents`, in `cron/index-credentials`) for the case where the customer
closes the tab and never comes back at all. `paymentGate.ts` itself was never touched -- this only
discovers a candidate tx hash and hands it to the exact same `verifyPayment`/`registerPayment` the
paste-a-hash path already used.

**Verified live in production, 2026-09-29:** `npx prisma db push` has run and `POST /api/create-payment`
now returns a real, non-null `intentId`/`destinationTag` (previously both came back `null`). Active, not
just deploy-safe.

## 16. Admin auth: Xaman sign-in (2026-09-29)

`/admin` no longer uses a pasted `ADMIN_API_TOKEN` in a password field. Sign in with a wallet in
`ADMIN_WALLETS` (env, comma-separated; defaults to the treasury alone) via Xaman SignIn -- same
challenge/signature mechanism as the free-key flow (`src/lib/freeKey.ts`), just gated by the allowlist
instead of minting a key. Issues a short-lived (1h) HMAC-signed session cookie, signed with
`ADMIN_API_TOKEN` itself (no new secret). `ADMIN_API_TOKEN` in a header keeps working exactly as before
for scripts and crons -- this was purely additive to `isAdmin()` (`src/lib/adminAuth.ts`).

## 17. MPP (Machine Payments Protocol) -- scaffolded, not built (2026-09-29)

`src/app/api/mpp/[resource]/route.ts` exists as an isolated route slot, gated behind `MPP_ENABLED` (unset
= off, the only state that currently exists). **This is a stub, not a working integration** -- given the
scope of everything else built the same night, a half-finished payment-acceptance path was judged worse
than none. What's still needed before it can do anything: the `xrpl-mpp-sdk` + `mppx` dependencies
(`xrpl-mpp-sdk` was still beta -- `0.1.0-beta.3` -- checked directly against npm on 2026-09-29, not from
memory), a durable replay store (their docs require Postgres or DynamoDB; in-memory is explicitly
dev-only), and an HMAC secret (`MPP_CHALLENGE_SECRET`, `openssl rand -base64 32`) for challenge signing.
Their peer dependency range (`xrpl >=4.0.0 <5.0.0`) matches this project's pinned 4.6.0 today, but is
**incompatible with the Batch transaction type** (needs `xrpl.js` 5.1.0+, sec 11) -- building MPP for real
forecloses Batch and vice versa on the current dependency graph. Don't start wiring the real SDK in
without re-confirming that tradeoff still holds.

## 18. Wallet Permissions Check (2026-10-09)

"Who can move money out of this wallet?" — `src/lib/walletPermissions.ts` (no local imports; Testnet test:
`node scripts/test-permissions-testnet.ts`, 19/19). Read-only: one `account_info` (with signer lists) + one page of
`account_objects` per check, through the normal node pool. Nothing runs on a schedule.

- People: `/permissions` → `GET /api/permissions/:address` (free, 12/min per IP). Agents: `GET /api/x402/permissions`
  ($0.02, both rails, `PRICE_PER_PERMISSIONS_*`; the parity guard fails the build if the two rails differ). MCP tool
  `check_wallet_permissions` returns the payment resource only (guarded).
- Free fixes: `POST /api/permissions/fix` — revoke a delegation (DelegateSet, empty Permissions) or cancel a check.
  Re-verified on the live ledger before building; XRPLHub never signs. **Xaman (2026-10-09): a DelegateSet GRANT can't
  be created at all (payload error 603, "Payload encoding error" — its codec lacks PermissionValue); the REVOKE (empty
  Permissions) encodes fine.** Reserve: one Delegate entry = one owner object = 0.2 XRP, returned on revoke (Testnet).
- Watchdog (full run, 07:00): `wallet-permissions` runs the real check on the credential issuer. A ledger read failure
  is a warning; a wrong report is RED (healthchecks.io email).
- Only one page (400 objects) is read; a bigger wallet gets `truncated: true` and a note. If PermissionDelegation's
  JSON shape changes, unknown permission names are still shown (named by type) — never dropped.

## 19. Batch Send (2026-10-09)

"Pay up to 8 people with one approval — everyone or no one." `src/lib/batchSend.ts` (no local imports). Money-moving
test runs on **Devnet**, not Testnet: Batch is enabled on mainnet and Devnet but Testnet answers `temDISABLED`
(`node scripts/test-batch-send-devnet.ts`, 18/18).

- People: `/send-many` → `POST /api/batch-send` (free, 20/min per IP). Agents: MCP `prepare_batch_send` (free). Both
  return an UNSIGNED single-account Batch (tfAllOrNothing), one Payment per recipient; XRPLHub never signs.
- Gated on `BatchV1_1` at request time (503 if inactive). Every payment is preflighted on the live ledger (destination
  exists or the first XRP payment is ≥ the base reserve, destination tag, Deposit Authorization, RLUSD line, sender
  balance + fee); a batch that would fail is refused with per-recipient reasons. Fee = (2 + n) × open-ledger fee.
- The batch uses the sender's next sequence numbers: any other transaction first makes it `tefPAST_SEQ` (nobody paid).
- **Xaman signs Batch correctly (2026-10-09):** the owner signed 6D3AE7DA… (2 × 0.01 XRP, treasury → rmWj… + r9dQ…),
  validated in ledger 107547781, both inner payments tesSUCCESS, every field exactly as built (Xaman added nothing).
  /send-many says "done" only when GET /api/batch-send?uuid= reads the batch AND each inner payment from the ledger.
- Watchdog (full run, 07:00): `batch-send` — RED if BatchV1_1 is not active; otherwise a read-only preflight between
  known accounts (nothing built or signed); a ledger read failure is a warning.

## 20. XRP Ledger halt (2026-10-11)

The XRP Ledger stopped validating for 64 minutes on 2025-02-04. Every node still answers during a halt — with the same
old ledger — so "do the nodes agree?" stays green; only the validated ledger's AGE reveals it
(`server_info.validated_ledger.age`, `HALT_AGE_SEC` = 120 in src/lib/xrplNodes.ts).

- **Detection:** `sweepNodeHealth()` → `halted` (every responding node stale), `staleHosts` (only some: OUR nodes).
  `ledgerStatus()` (cached 30 s) → ok | degraded | halted | unreachable; public at GET /api/ledger-status.
- **Watchdog `ledger-halt`** (both crons, 06:00 + 07:00 UTC) emails via healthchecks.io RED with a different message
  for "XRP LEDGER HALTED — the network, not XRPLHub", "OUR NODES, not the ledger" and "OUR SIDE: none answered".
  Only checked at cron times: a halt shorter than the gap between runs is never seen (nor needs action).
- **Server-side writes** (MPT/screening/lending/underwrite/monitoring anchors, credential issue/delete/cleanup) go through
  `submitValidated()` (src/lib/ledgerSubmit.ts): pause without submitting when the node's ledger is stale; Sequence from
  the VALIDATED ledger (a halt-stranded tx and its retry share it → at most one applies); bounded 20 s wait; done only
  when a validated ledger says so. Anchors record `paused` (no alarm) and retry; queued credentials stay queued; a
  tecDUPLICATE retry is recorded as issued only if the validated ledger holds that unexpired credential.
- **Autopay:** a halted/unreachable ledger → `paused` (nothing submitted, status unchanged, no notice). A node's tef/tem
  is never a failure on its own: tefNO_TICKET is believed only if the validated ledger lost the ticket, tefMAX_LEDGER only
  if the validated ledger is past the expiry; anything else retries until the window closes (then "missed").
  Window = the period + 3-day grace (weekly: 10 daily runs; monthly: 31–34); a halt only pushes LastLedgerSequence later.
- **Spend Controls cron:** while halted/unreachable, no Autopay sends and no payer sign-request pushes; RED line explains.
- **Customers** see "The XRP Ledger is paused right now. Nothing is lost — we'll send it as soon as it resumes." on the
  homepage, /spend (+ plan, share, cash), /send-many, /permissions and the xApp. Reads keep working during a halt.
- Tests: scripts/test-autopay-halt-testnet.ts (16/16), scripts/test-ledger-submit-testnet.ts (7/7),
  scripts/test-ledger-halt-watchdog.ts (4/4). The treasury send functions are unused (grants are paid by a person).

## 21. Spend Controls xApp in Xaman: identifier, pushes, token expiry, ending plans (2026-10-11)

- **xApp identifier:** `sandbox.64e45fc7aaca`, assigned by the Xaman Developer Console (there is no custom-identifier
  field). Test link: https://xumm.app/detect/xapp:sandbox.64e45fc7aaca. WebApp URL: https://www.xrplhub.io/xapp/spend.
  (The `xrplhub_spend_` prefix in the code is a *payload* identifier, not the xApp identifier. Leave it.)
- **"Push permission: No" in the console does NOT block our pushes.** Xaman: sign requests may be pushed by any app
  once the user has interacted with it; only *custom xApp push events* need that permission
  (https://docs.xaman.dev/concepts/limitations/push-permission). Spend Controls only pushes sign requests.
- **User token expiry:** "expires 30 days after the **last** successfully signed payload"
  (https://docs.xaman.dev/concepts/payloads-sign-requests/delivery/push). The push-permission page also says "every time
  the user interacts with the app again, the 30 day cycle will reset" and that xApps obtain a token "after xApp open". In an
  xApp that token is the JWT claim `usertoken_uuidv4` (Xumm-Universal-SDK src/index.ts: `user.token`), NOT the OTT
  `user` field. Tokens are "user & app bound": only the API credentials they were issued to can use them.
  Autopay payers sign nothing after setup, so their token is usually dead by the time a payment could fail.
  A monthly subscription signed on day 1 can also expire just before the next 31-day month starts. So:
  - the cron reports every push Xaman did not deliver as a RED line ("spend push NOT delivered"), naming the plan
    and saying whether it was an Autopay failure notice;
  - watchdog `spend-push-tokens` (warn) asks Xaman (`POST /platform/user-tokens`) which payers are unreachable;
  - the xApp plan list shows "Autopay didn't go through this period" in red, the dashboard says "Reminders are off"
    when the token is dead, and the payee's link shows the failure;
  - the Autopay terms tell customers that pushes only work within 30 days of their last approval.
  - NOT built (owner's decision): an optional email for failure notices, or a monthly "keep reminders on" sign-in
    request that would renew the token.
- **Ending a plan:** dashboard → "End this plan…" → "Yes, end it" (`POST /api/spend/plans/:id/end`). Status `ended`:
  no new checks, no pushes (token dropped), unsent Autopay payments cancelled, hidden from the xApp list
  (`/api/xapp/plans` lists `status: "active"` only), the payee's link says it ended. Open checks stay cancellable,
  tickets stay releasable. Can't be undone.
- **BUG fixed (2026-10-11):** `/api/xapp/session` stored the xApp OTT's `user` field as the push token. That field is
  Xaman's user ID, not a push token, so opening the xApp silently switched reminders off on every subscription of that
  account. It is no longer stored. A payer's push token comes back the next time they approve any Spend request. Live
  check after the fix: the Autopay test plan (cmv1b95kl0000k006c36ihr5a) shows "Reminders are off".
- **Push diagnostic (admin):** /admin → "xaman" tab. It shows Xaman's own record of any sign request (`meta.pushed`,
  `app_opened`, `expired`, which Xaman app made it, whether its token is active), and can send ONE test push (a SignIn,
  nothing to sign; tap Decline) using the token from a request the admin wallet signed. Route: `/api/admin/xaman-push`.
- **Saturday 10 Oct reminder was never delivered (owner's /admin check, 2026-10-11):** request a55209bf, CheckCreate,
  `meta.pushed = false`, never opened, expired. The Oct 9 pre-approval 5227b6e5 was signed but Xaman issued NO user token
  (`application.issued_user_token` null), and Xaman's docs name no condition for that. The token the plan held on Saturday
  could only have come from the Oct 9 TicketCreate. It was overwritten on Oct 11 (the OTT bug) and can't be inspected. All
  three treasury subscription plans now hold `2587…`, the OTT `user` ID written at the Oct 11 xApp open (inactive).
  Xaman key/secret unchanged since 2026-10-05, so this is not a deleted-app token.
- **Reminders are NOT promised until proven:** `SPEND_PUSH_VERIFIED` (unset = off). While off, every surface says
  "Reminders unavailable" (create page via /api/spend/config, dashboard, Autopay terms, the API's `how`, llms.txt). The cron
  still tries the push (it costs nothing) and reports non-delivery as RED. Turn it on only after a test push arrives on a phone
  (/admin → xaman: step 1 sign-in → "Check the sign-in" → "Send ONE test push…").
- **Push log (2026-10-11):** every push attempt (`createPayload` with a user token) logs Xaman's full create response
  (`[xaman push]` in Vercel logs, 1 h) and keeps the last 25 in the database:
  `select marker from "IndexerCheckpoint" where id = 'xaman-push-log'`. `scripts/show-push-request.ts` prints the exact
  body we POST (token masked): `user_token` is a top-level field, as in Xaman's Push docs.

## 22. Wallet Check xApp (2026-10-11)

- **The xApp is now Wallet Check:** `/xapp/check` (Xaman identifier `sandbox.64e45fc7aaca`). One purpose: check before you trust.
  "Your wallet" = Wallet Permissions Check for the account Xaman provides, with the free fixes (remove a permission, cancel
  a check), each explained in plain words and opened in Xaman only on a tap. "Check a wallet" = the free XRPLScore track
  record (`/api/score/:address`) for any address, picked from Xaman's own contacts / QR scanner (`selectDestination`) or
  pasted. No push, no sign-in, nothing stored.
- **Spend Controls is website-only.** `/xapp/spend` still works but nothing links to it (push reminders never reached a
  phone, §21).
- **Audit:** the Xaman checklist runs headless against production at 320/360/390/412 px in LIGHT, DARK, MOONLIGHT and
  ROYAL. It records every message sent to Xaman, proving nothing opens without a tap.

## 23. XRPL Lending — tracker (live) and vault grades (switched on by the ledger) (2026-10-16)

- **What runs:** `.github/workflows/lending-tracker.yml` (repo root) calls `GET /api/cron/lending-tracker` at :07 every
  hour (Vercel Hobby crons are daily-only). The route is public and stores at most one `LendingAmendmentSnapshot` per hour
  (`hourBucket` is unique), so a stray call only refreshes the page early. Each stored snapshot writes the
  `lending-tracker` heartbeat.
- **Data sources:** enabled status and majority dates from the ledger's Amendments object (`src/lib/amendments.ts`). Votes
  per validator from XRPScan's public validator registry (`api.xrpscan.com/api/v1/validatorregistry`), counted for the
  validators on `vl.ripple.com`. Votes needed = floor(n × 0.8) + 1 (rippled: more than 80%), 29 of 35 today. If XRPScan
  can't be read the snapshot is stored with `source = "ledger-only"` and no votes (watchdog warns).
- **Fallback refresh:** GitHub's scheduled runs can be delayed or dropped. When the daily watchdog (06:00 and 07:00 UTC
  crons) finds the newest snapshot older than 3 hours, it runs the tracker itself (same `runTracker`, 12 s cap) and
  reports WARN ("the hourly trigger missed") if that stores a snapshot, RED only if that refresh also fails.
- **Alerts:** watchdog finding `lending-tracker` goes RED when the newest snapshot is older than 3 hours AND the
  watchdog's own refresh fails → healthchecks.io
  `/fail` email. Most likely cause: GitHub paused the schedule (public repos, after 60 days without a commit) — Actions tab →
  "Lending tracker (hourly)" → Enable workflow. Optional: set `LENDING_HEALTHCHECK_PING_URL` to an hourly healthchecks.io
  check (period 1 h, grace 30 min) and every run pings it.
- **Signups:** `/api/lending/signup` stores emails in `LendingSignup` (unique, lower-cased, consent sentence, IP hash).
  NO email sender is configured (`RESEND_API_KEY` unset), so nothing is sent. The privacy policy (§11 "XRPL Lending launch
  list") promises ONE email at mainnet activation, then deleting the list (keeping unsubscribed addresses as do-not-email).
  Count: `select count(*) from "LendingSignup" where "unsubscribedAt" is null`. Unsubscribe link:
  `/api/lending/signup?unsubscribe=<unsubscribeToken>`.
- **"Set up email now" reminder (one-time, decided 2026-10-16):** the first hour any lending amendment has 25+ yes
  votes, or the list has 25+ signups, while `RESEND_API_KEY` is unset, the hourly job sends ONE healthchecks.io `/fail`
  whose body says why (`maybeResendAlert`, `src/lib/lendingOps.ts`). Recorded in IndexerCheckpoint
  `lending-resend-alert` so it never repeats; the next daily cron's success ping turns the check green again, so real
  failures still email. To re-arm it: `delete from "IndexerCheckpoint" where id = 'lending-resend-alert'`.
- **Resend setup — do this when that reminder arrives (free plan: 3,000 emails/month, 100/day):**
  1. Create an account at https://resend.com (support@xrplhub.io).
  2. Domains → Add domain → `xrplhub.io` (region us-east-1). Resend shows DNS records: an MX and a TXT (SPF) on the
     `send` subdomain, and a TXT `resend._domainkey` (DKIM). Add all of them at the DNS host for xrplhub.io, exactly as
     shown. Optional but recommended: a TXT `_dmarc` with `v=DMARC1; p=none;`.
  3. Back in Resend press Verify; wait until the domain shows "Verified" (minutes to a few hours).
  4. API Keys → Create API key → permission "Sending access", domain `xrplhub.io`. Copy it once.
  5. Vercel → project `kreditkarma-obi2` → Settings → Environment Variables → add `RESEND_API_KEY` (Production,
     Sensitive). Redeploy with the build cache UNCHECKED.
  6. Then the one-time launch email still has to be built (it is not written yet): send each `LendingSignup` row with
     `unsubscribedAt` null one plain email when lending is enabled, with its unsubscribe link, set `notifiedAt`, then delete
     the list except unsubscribed addresses (what privacy §11 promises). At 100/day, more than 100 signups means sending
     over several days.
- **Phase 2 (dormant until `lendingLive()`):** the same hourly run calls `runLendingIndex` (`src/lib/lendingIndex.ts`):
  a resumable `ledger_data type=vault` walk (checkpoint `lending-walk:mainnet`, pinned to xrplcluster) for discovery,
  then each vault → its brokers (vault owner's `loan_broker` objects) → each broker's loans (broker pseudo-account's
  `loan` objects) → lending transactions (`account_tx` on the pseudo-accounts, cursor `lending-tx:mainnet:<account>`).
  Grades: `src/lib/lendingGrade.ts`, method published at `/lending/method` from the same `RULES` table
  (`METHOD_VERSION = lending-grade-v1`). Stored per run in `LendingGrade`. Lending Pro webhooks (`LendingAlertWatch`)
  fire when a watched grade changes. Tested end to end against XRPL Devnet on 2026-10-16 (lending is enabled on Devnet;
  Ripple's lending tutorials use Devnet).
- **Copies:** `lendingGrade.ts` and `lendingFacts.ts` are copied into the uxus repo for the paid grade API. Change both.
- **Lending Pro (phase 2, off until `lendingLive()`):** sold on uxus.finance ($49/mo, Stripe price
  `price_1URAofRoquiH1GTZCgWWeul3`, plan `lending_pro`, 20,000 grade calls/month). The customer's uxus key works here:
  `GET /api/lending/pro/history?type=&id=&days=` and `GET|POST|DELETE /api/lending/pro/watch` (grade-change webhooks,
  signed like monitoring webhooks). `src/lib/lendingPro.ts` checks the key against
  `https://uxus.finance/api/billing/entitlement` (cached 5 min) and stores only its SHA-256. The paid per-call grade API
  is `GET https://uxus.finance/api/lending/grade?id=` ($0.02 x402; 503 before the paywall until lending is live) and MCP
  tool `lending_grade` on uxus.
- **Schedule keepalive (2026-10-16):** the repo is public, and GitHub disables scheduled workflows after 60 days with no
  repository activity. The workflow's `keepalive` job checks the newest commit on main every hour and, if it is 40+ days
  old, pushes one empty commit ("keepalive: …") with the workflow's own token (no secret, no human). That push also
  triggers a Vercel deploy, which is harmless. If the schedule stops anyway, the daily watchdog refreshes the tracker itself (WARN), so
  the chart keeps at least two points a day; RED only if that refresh fails too. Scheduled workflows only run from the
  default branch, which is `main`.
- **Activation self-test (phase 2):** once `lendingLive()`, the hourly job runs `runLendingSelfTest` (`src/lib/lendingOps.ts`)
  daily (hourly while failing): `/lending/vaults` and a vault page, the uxus grade API's $0.02 402 challenge, MCP
  `lending_grade` returning the paid resource, and the Lending Pro pricing card + a Stripe Checkout session (created, never
  paid; it expires). No purchases. Result in IndexerCheckpoint `lending-selftest`; watchdog `lending-selftest` is RED while it
  fails, so healthchecks.io emails. It waits up to 48 h after activation for the first vault to be discovered.

## 24. XRP Yield Desk (/yield) and XRPLHub Pro (2026-10-16)

- **What it is:** every way to earn on XRP or RLUSD we can verify from public data, each with an A–F risk grade
  (`src/lib/yieldGrade.ts`, method rendered at `/yield/method`). Pages: `/yield`, `/yield/<slug>` (one per option),
  `/yield/method`, `/yield/best-xrp-yield`; all in the sitemap. JSON: `GET /api/yield/options[?asset=|?slug=]`.
- **Sources** (`src/lib/yieldSources.ts`, `src/lib/yieldAmm.ts`): Doppler public API (api.doppler.finance), the Firelight
  stXRP contract on Flare (read directly), DefiLlama yields + protocols APIs (Flare FXRP products, RLUSD/XRP elsewhere,
  ≥ $250K), Binance Simple Earn and OKX Savings public rate endpoints, XRPL AMM pools XRP/RLUSD and XRP/USDC (size from
  amm_info, fee income from on-ledger trades, scanned incrementally: checkpoint `yield-amm:<account>`), and XLS-66 vaults
  once lending is live. Each source's last good read: checkpoint `yield-source:<name>`. A failing source keeps its last
  numbers (each card shows when they were read); options a source drops stay as pages, marked unlisted.
- **Schedule:** `.github/workflows/lending-tracker.yml` job `yield` calls the public `GET /api/cron/yield-refresh` hourly
  (no-op if refreshed in the last 45 min). Last full refresh: checkpoint `yield-refresh`.
- **Watchdog (self-repair):** finding `yield-desk`. If the last refresh is over 3 h old, or any source has had no good
  read for 24 h, the watchdog runs the refresh itself (17 s budget). WARN if that fixes it; RED (healthchecks.io `/fail`)
  only if the refresh fails or the source is still stale. A RED naming one source usually means that API changed shape.
- **Alerts:** grade changes are stored in `YieldGrade`. Free list: `YieldSignup` (stored only; emails start once
  RESEND_API_KEY is set — send each `YieldGrade` row with `emailedAt = null` to the matching signups, then set
  `emailedAt`). XRPLHub Pro webhooks: `POST /api/yield/pro/watch` (Pro key), stored in `LendingAlertWatch` with
  subjectType `yield`, sent by each refresh.
- **Visits:** `YieldPageView` (day, path, count), counted by a cookie-free beacon (`/api/yield/visit`) on the /yield pages,
  because Vercel Web Analytics is not switched on for kreditkarma-obi2 (the `<Analytics />` component is mounted).
  To switch it on: Vercel dashboard → kreditkarma-obi2 → Analytics → Enable (free on Hobby), then redeploy.
- **Money:** uxus sells `GET /api/yield/grade?id=<slug>` at $0.02 (x402) and the MCP tool `yield_grade` (v1.4.0); unknown
  ids get 404 before the paywall (no charge). XRPLHub Pro ($49/mo, plan `xrplhub_pro` on uxus, formerly Lending Pro;
  old price archived, old `lending_pro` keys still accepted) is on sale now. Never test with a real purchase.
- **Rules:** non-custodial (we never touch funds), general information only, never paid by graded products, no referral
  codes or per-deposit commissions. Every /yield page shows that.
