# Permissioned Domain integration kit

Gate an XLS-80 Permissioned Domain on XRPLScore credentials (`io.xrplhub.score.v1.<tier>`, issuer `rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f`).
The plain-English guide an institution reads is served at `GET /api/domains/guide` (source: `src/lib/domainGuide.ts`).

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Plan + tier logic (pure, no keys) | `src/lib/domainKit.ts` | `planScoreDomain` → floor tier **and every higher tier** (a wallet holds only its highest tier); ≤10 accepted credentials (XLS-80); optional other issuers (`alsoAccept`); optional `domainId` to update |
| Free plan endpoint | `GET|POST /api/domains/build` | validates, returns the accepted-credential list, cost, member steps and the paid resource. **Returns no signable transaction.** |
| The unsigned `PermissionedDomainSet` | storefront service `permdomain` via `/api/x402/tx?productId=permdomain&account=…&minTier=…` | same storefront price on both x402 rails ($45 today, `src/lib/servicePrices.ts`); built before settlement, so a bad request is not charged. `permdomain` now also accepts `minTier`, `alsoAccept`, `domainId` (the single-credential form still works) |
| Guide | `GET /api/domains/guide` | markdown |
| Credential request flow | `POST|GET /api/credentials/request` | fresh score (not the display cache) → queue row (`CredentialRequest`) → operator issues → subject accepts. GET returns the unsigned `CredentialAccept` once the credential is on-ledger |
| Operator issuance | `node scripts/issue-queued-credentials.cjs [--issue]` | lists the queue; `--issue` runs the reviewed `scripts/issue-credential.cjs issue <subject>` per row (re-scores at issuance, refuses if the tier changed, signs from the offline `CREDENTIAL_ISSUER_SEED`). The issuer seed is never on Vercel |
| Eligibility check | `GET /api/domains/eligible?address=&domain=` (existing) | live from the validated ledger |

## Why the transaction is not free
On the owner's instruction ("signable txjson is sold, never free"), the signable transaction is only delivered through the paid path. `/api/domains/build` is the free front door; it hands out everything except the ready-to-sign JSON. If you decide the domain builder should be free, change `/api/domains/build` to return `planScoreDomain(...).txjson` — one line — and accept that `permdomain` then has a free equivalent for the tier form.

## Design rules
* **Unsigned only.** Nothing here signs, submits or holds a key. The only signed thing is the issuer's `CredentialCreate`, done by a person on their own machine.
* **We issue, they accept.** An unaccepted credential satisfies no domain. `CredentialCreate` from us leaves a *pending* credential (0.2 XRP issuer reserve until accepted).
* **Abuse limits on the request queue:** 15 new requests per source per day (hashed source, daily salt, never stored raw), 500 open requests overall, one open request per wallet, a live check that the wallet does not already hold our credential.
* **Nothing is put on-ledger by the request.** Below 600 (or not activated): `not_eligible`, no row, no ledger object.

## What was verified (2026-09-25)
* Mainnet has the `Credentials`, `PermissionedDomains` and `PermissionedDEX` amendments **enabled** (`feature` RPC against xrplcluster.com). Reserves: 1 XRP base, 0.2 XRP per object.
* xrpl.js 4.6.0 `validate()` accepts the built `PermissionedDomainSet` for create and update; the credential-type hex for `min650` equals the frozen spec value; duplicates are removed; more than 10 accepted credentials are refused (8 offline tests).
* The `permdomain` builder keeps its old behaviour when `minTier` is absent.

## NOT verified
* **No `PermissionedDomainSet` or `CredentialCreate`/`CredentialAccept` was submitted** for this build (no keys; unsigned-only). Whether a real create lands and how `DomainID` reads back from metadata was checked against the spec text, not by a live transaction. The guide says to read the `DomainID` from the created node's `LedgerIndex`.
* Domain-eligibility for a *member* is only as real as the accepted credentials that exist: today **zero** wallets hold an accepted credential from us, so any domain created now starts empty. The kit does not change that; the request flow is how it changes.
* The score-tier meaning ("≥ N at issuance") is our methodology's claim; no external party has validated it.
