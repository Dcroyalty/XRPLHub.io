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
| Mainnet XLS-70 credentials — 4 families now (score, mpt-declared, screen-nomatch, domain-verified) | the one issued credential (`io.xrplhub.score.v1.min750`) expires **2026-12-03**; see §5 for the other three families' request queues, which are hand-issued the same way | **Manual, by design** — see §5 | watchdog `credential-expiry` covers only the score credential today (warn 45d, red 14d) — **the other three families and the request queue itself have no watchdog coverage; see §5's gap note** |
| Anchor wallet `r9dQS1…XuJXb` | ~1.0 XRP spendable; an anchor costs ~0.00001 XRP (≤4 a day) — decades of headroom | top up if the base reserve is ever raised | watchdog `anchor-wallet` (warn < 0.5, red < 0.25) |
| Neon database (project `kreditkarma`) | 10.8 MB of the 512 MB free-tier branch limit; **6-hour point-in-time history only**; maintenance window Sundays 05:00–06:00 UTC | upgrade plan if it fills | watchdog `db-size` (warn 70%, red 90%) |
| `UsageRecord` table | one row per metered API call, never pruned — the first table to grow under real load (≈1M calls/month ≈ 1 GB/year) | prune or upgrade | `db-size` |
| Sanctions feeds (OFAC SDN, EU FSF, UK Sanctions List) | each list re-confirmed daily; a new snapshot only when its content changes (EU/UK change rarely). A refused (gated) snapshot alerts and the previous one stays in force. Screening FAILS CLOSED (503) if any list has no snapshot. | none; the EU download uses a public token URL and the UK file location has moved once (OFSI closed 2026-01-28) — a publisher format change shows up as a refused snapshot + alert | watchdog `ofac-sdn` (covers all three; freshness = last confirmed; warn 4d, red 8d) |
| Screening retention promise (`retain-10y-no-prune/v1`), **approved 2026-09-28** | receipts, leaves, anchors and every list snapshot's canonical archive are never pruned by any process (only the derived per-address lookup rows of a snapshot >6 h superseded are dropped; the archive stays). Growth ≈ 75 KB/day compressed for OFAC vintages + receipts. Now backed by a daily off-Neon copy (see §6) — but Neon itself is still 6-hour history, so the *live, queryable* copy has no long-term guarantee of its own. | **Owner decision still open:** the off-Neon backup makes the receipts survivable, not queryable at scale for 10 years. Consider a paid Neon plan for real point-in-time recovery. | watchdog `db-size`, `screening-backup` |
| Public XRPL nodes (8 hard-coded hosts) | all healthy today; several are hobbyist hosts | edit `XRPL_NODES` in `src/lib/xrplNodes.ts` | watchdog `xrpl-nodes` (warn ≤ 5 healthy, red ≤ 2) |
| Bithomp API key (free tier 10 req/min, 2K/day) | accepted | replace if revoked | watchdog `bithomp-key` (red on 401/403) — without it the MPT registry silently stops refreshing holder counts |
| XRP/USD price sources (CoinGecko + Coinbase, keyless) | both up | none | watchdog `xrp-price` (warn if BOTH fail: XRP checkout is refused) |
| Xaman (XUMM) API key/secret | present, no expiry | rotate only if revoked | `createPayload` alerts loudly on rejection; health probe |
| Coinbase CDP key (x402 USDC on Base) | present; **usage limits / billing of the CDP facilitator not verified** | check the CDP portal | health deep probe (reachability only, not key validity) |
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
to `>=4.0.0 <5.0.0`. The `Batch` transaction type needs `xrpl.js` `5.1.0+`. Picking up one forecloses the
other without forking a dependency. Neither is in this codebase yet (checked — no `Batch` transaction-type
code anywhere). Decide which one XRPLHub wants first; don't start building against either assuming the
other stays available.

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
