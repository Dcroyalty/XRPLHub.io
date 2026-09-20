# Continuous monitoring

Layered on top of underwriting, not a replacement: underwriting judges structural risk **before** signing;
monitoring reports **observed behavioral changes** in public XRP Ledger data **after** — once a day, for wallets a
subscriber chose. It cannot see borrower credit, collateral, legal structure or anything off the ledger; it gives
no recommendation and **no probability of default**; "no change observed" does not mean "safe".

Live description (limits, capacity, acknowledgement text): `GET /api/monitor` (no key).

## Endpoints (API key; a free key works)

| | |
|---|---|
| `POST /api/monitor/subscribe` | `{ addresses[≤25], webhookUrl, scoreDropPoints?, subscriptionId?, acknowledgement:{accepted:true,version} }` |
| `GET /api/monitor/subscriptions` | this key's subscriptions + per-wallet `lastCheckedAt` / `nextCheckAt` (never the secret) |
| `PATCH` / `DELETE /api/monitor/subscriptions/{id}` | change webhook or threshold, add/remove wallets, rotate the secret (shown once) / stop |
| `GET /api/monitor/history?subject=r…` | attested, sparse time series |
| `GET /api/monitor/events` | the events a webhook would push, readable back |

The **consumer-use acknowledgement** (no use for consumer credit / insurance / employment / housing decisions under
FCRA / ECOA) is required on subscribe and stored with a timestamp and version on the subscription. The Terms carry a
matching addendum (§5A).

## Events

`score_drop` (only if the subscriber sets `scoreDropPoints`; measured from the highest fresh score since subscribing or
the last alert; never across a methodology change — there is **no default threshold**), `sanctions_hit` /
`sanctions_delisted` (exact match against the OFAC SDN list), `first_loan_observed`, `loan_overdue`, `loan_impaired`,
`loan_defaulted` (**dormant until XLS-66 is enabled, then automatic**), and `monitoring_degraded` (we could not observe
the wallet for 3 daily runs — says nothing about the wallet).

## Webhooks

HTTPS, port 443, public hostnames only (DNS re-validated and pinned at connect time; no redirects; private,
loopback, link-local, metadata, CGNAT, ULA, 6to4/NAT64 ranges refused). A test ping is sent on subscribe; if it is not
answered 2xx nothing is created. Signature: `X-XRPLHub-Signature: v1=<hex HMAC-SHA256(secret, "<X-XRPLHub-Timestamp>.<raw body>")>`;
reject timestamps older than 5 minutes; de-duplicate on `X-XRPLHub-Event-Id` (retries reuse it). The secret is random
**per subscription**, shown once, never derived from the API key. Retries: up to 6 attempts over ~3 days (the daily
runs); a webhook is auto-disabled after 8 consecutive failed attempts (events stay readable via `/events`).

## Attestation

Observations are **sparse** — baseline, change, event, and at most a weekly heartbeat — and append-only, under the
frozen canon `monitor-observation-v1` (`src/lib/monitorCanon.ts`), anchored daily as a Merkle root by the existing
anchor wallet with memo type `XRPLHub-Monitor-Attestation/monitor-observation-v1`. Verify any observation at
`/api/attest/verify?queryId={observationId}`.

**A score in an observation is fresh.** `xrplScore` is non-null only when `scoreStatus` is `"fresh"` (computed by
`scoreWallet()` during that observation, never the display cache — enforced by `canonMonitorJson` and the
build-time gate `scripts/check-attestation-freshness.mjs`). An unchanged wallet carries `xrplScore: null`,
`scoreStatus: "not_rescored"` and `scoreObservationRef` pointing at its last fresh observation. Sanctions: the
observation states which SDN snapshot it checked; an attested screening receipt is written at baseline and whenever
a wallet's listed-ness changes (OFAC publishes a new vintage almost daily; a receipt per wallet per vintage would
not be sustainable).

## Capacity — what two daily cron runs can honestly handle

- One check per wallet per day (`nextCheckAt` = last check + 12 h; both crons run once a day).
- A cheap account-state read every check; a **fresh score only when the account changed, or at least weekly**, within a
  budget of ~100 fresh scores per run (a score is ~300+ RPC units; `xrplcluster` allows 2,000 units / 10 s).
- **Shared platform limit: 500 watched wallets across all customers** (`MONITOR_MAX_TOTAL_SUBJECTS`); `subscribe`
  returns `503 monitoring_capacity_reached` beyond it. Plan slots (free 3, starter 25, growth 250, scale 2,500) are
  per-key **ceilings** — the shared limit applies first.
- If more wallets are due than one run can score, the stalest are checked first and the rest roll to the next run.
  The watchdog warns if any wallet is more than 3 days behind.
- No external trigger yet: raising the limit means adding one (e.g. a scheduled GitHub Action calling the cron
  endpoint) or a paid Vercel plan.

## Where things are

`src/lib/monitorEngine.ts` (decision logic, pass, baseline) · `monitorCanon.ts` · `monitorAnchor.ts` ·
`monitorWebhook.ts` · `monitorApi.ts` · `src/app/api/monitor/**` · cron wiring in
`src/app/api/cron/index-credentials/route.ts`. Tables: `MonitorSubscription`, `MonitorSubject`,
`MonitorObservation`, `MonitorAnchor`, `MonitorEvent` (`prisma/schema.prisma`).
