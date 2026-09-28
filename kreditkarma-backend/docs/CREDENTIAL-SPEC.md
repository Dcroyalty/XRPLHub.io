# XRPLScore Credential Specification — v1 (FROZEN)

Native XLS-70 credential representation of XRPLScore on the XRP Ledger.

> **Status:** frozen for mainnet. Every string below is permanent once the first
> mainnet credential is issued. Changing any of them requires a new `v2`
> namespace and a coordinated migration with integrators.

---

## 1. Issuer

| | |
|---|---|
| **Issuer address** | `rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f` |
| **Network** | XRP Ledger **mainnet** (`network_id 0`) |
| **Pinned in code** | `EXPECTED_ISSUER` in `src/lib/credentials.ts` — a seed deriving any other address cannot issue |

The issuer address is the other half of every gate — integrators list
`(issuer, CredentialType)` pairs, so this address is as permanent as the type
strings. It **MUST NOT** be the treasury (`rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF`).

Requirements for the issuer wallet, before the first issuance:

- **Dedicated.** Single purpose: issuing XRPLScore credentials. No payments, no
  NFTs, no trust lines.
- **Independent keys.** Its signing key(s) are separate from the treasury's
  multi-sig signers. Prefer a 2-of-3 multi-sig with cold keys.
- **Funded.** Owner reserve is `0.2 XRP` per *pending* (unaccepted) credential
  plus the `1 XRP` base reserve. Fund for the expected steady-state count of
  unaccepted credentials (acceptance is never guaranteed). `50 XRP` covers
  ~245 simultaneously-pending credentials.
- **Documented.** Published in `/openapi.json`, `/.well-known/`, and this file.

Fill the address into this table in the same commit that adds the mainnet
issuing path. (`src/lib/credentials.ts` today is a Devnet-only PoC and holds no
mainnet address.)

---

## 2. CredentialType strings (FROZEN)

Namespace: **`io.xrplhub.score.v1`**

| Tier string | Full `CredentialType` (ASCII) | Hex |
|---|---|---|
| `min600` | `io.xrplhub.score.v1.min600` | `696F2E7872706C6875622E73636F72652E76312E6D696E363030` |
| `min650` | `io.xrplhub.score.v1.min650` | `696F2E7872706C6875622E73636F72652E76312E6D696E363530` |
| `min700` | `io.xrplhub.score.v1.min700` | `696F2E7872706C6875622E73636F72652E76312E6D696E373030` |
| `min750` | `io.xrplhub.score.v1.min750` | `696F2E7872706C6875622E73636F72652E76312E6D696E373530` |

- 26 ASCII chars, well under the 64-byte XLS-70 limit.
- Charset `[a-z0-9.]` only — accepted by every XRPL wallet, explorer, and the
  reference credential tooling. (Colons / slashes are protocol-legal but break
  parsers; not used.)
- `min<N>` names the **guarantee** ("score was ≥ N at issuance"), not the score.
  A threshold never changes, so the string never needs to.
- Score drift is corrected by expiry (§4), not by re-typing.

### Why versioned (`v1`)

The credential permanently encodes "scored by the v1 methodology". When the
9-signal engine changes materially, a `v2` namespace is minted; `v1` credentials
keep their exact meaning and integrators opt into `v2` deliberately. Without the
version segment a methodology change would silently redefine what every live
integration already trusts.

**`v1` = XRPLScore methodology v1.x** — the `scoreWallet()` engine in
`src/lib/xrplscore.ts`. As of the mainnet issuance (tx `3C5D2EE4C905B82F85930496374CB4AE1580F330E1EB8A8D95ED9162B5C51286`) this is **v1.1**
(`METHODOLOGY` const: "XRPLHub XRPLScore v1.1 — 8-signal native on-chain
behavioral scoring, absolute scale"; calibration in
`docs/XRPLSCORE-CALIBRATION.md`).

Point releases stay inside `score.v1`: v1.0 → v1.1 removed `builderCommitment`
(a credit standard must not score wallets higher for paying the issuer) and
recalibrated to the full 300–850 range. The **tier guarantee** (`min750` =
"score was ≥ 750 at issuance") is unchanged by any v1.x point release, so the
frozen `CredentialType` strings keep their exact meaning. A `v2` namespace is
minted only for a fundamentally different scoring approach, and integrators opt
into it deliberately. The verification page (`/verify/wallet/<subject>`) always
shows the exact `METHODOLOGY` string.

---

## 3. Tier mapping

`eligibleTier(score)` in `src/lib/credentials.ts`:

| XRPLScore (300–850) | Credential issued |
|---|---|
| **≥ 750** | `io.xrplhub.score.v1.min750` |
| **700 – 749** | `io.xrplhub.score.v1.min700` |
| **650 – 699** | `io.xrplhub.score.v1.min650` |
| **600 – 649** | `io.xrplhub.score.v1.min600` |
| **< 600** | **none** — `not_eligible`, no ledger object, no reserve, no transaction |
| **not on mainnet** | **none** — `not_eligible` |

### One credential per wallet — the highest tier only

A wallet that scores 780 receives **only** `min750`. It does **not** also receive
`min700` / `min650` / `min600`. (Issuing every qualifying tier would multiply the
reserve and the acceptance friction for no benefit.)

> ### ⚠️ Integrator trap — read this
>
> Because a wallet holds only its highest tier, an integrator that wants to admit
> **"650 or better"** MUST list **all three** of
> `min650`, `min700`, `min750` (with this issuer) in their
> `PermissionedDomain.AcceptedCredentials` / `DepositPreauth` set.
>
> Listing only `min650` **silently rejects every wallet scoring 700+** — i.e. it
> turns away your best borrowers. There is no error; the gate just doesn't match.
>
> Rule of thumb: **accept your floor tier and every tier above it.**
>
> | Integrator wants | Must accept |
> |---|---|
> | 600+ | `min600`, `min650`, `min700`, `min750` |
> | 650+ | `min650`, `min700`, `min750` |
> | 700+ | `min700`, `min750` |
> | 750+ | `min750` |

---

## 4. Expiration

- Every credential is issued with `Expiration` = **issuance time + 90 days**,
  expressed in seconds since the Ripple epoch (2000-01-01).
- After expiry the ledger object still exists (XLS-70 has no auto-cleanup) but
  gating checks treat it as invalid, and anyone may `CredentialDelete` it.
- 90 days is the correction window for score drift: a wallet that falls below its
  tier simply is not re-issued. A wallet that improves can be re-issued at the
  higher tier once the old credential is deleted or has expired.
- Re-issuance is a fresh `CredentialCreate` (credentials are immutable — no
  update transaction exists).

---

## 5. URI field

Off-ledger pointer to a human-readable view. Hex-encoded ASCII, ≤ 128 bytes
(≤ 256 hex chars). Chosen by the issuer at `CredentialCreate` time:

Every mainnet credential's `URI` is:

```
https://www.xrplhub.io/verify/wallet/<subjectAddress>
```

A public, no-login HTML page that shows, live from the validated ledger: the
on-ledger credential (tier, `CredentialType`, issuer, issued/expires dates,
`lsfAccepted` status) **and** the wallet's live score with the full 8-signal
breakdown and the exact methodology string. This page IS the evidence anyone
can check without trusting XRPLHub — the on-ledger `(issuer, CredentialType,
Expiration)` remains the authoritative attestation; the page just renders it.

`GET /api/credentials/verify?subject=r...` returns the same data as JSON.
The page and API must serve 200 for the subject **before** any credential is
issued to it.

### Required disclosure

Every verification surface (the page and `/api/credentials/verify` JSON) carries,
verbatim:

> **Unsolicited rating.** This assessment was produced by XRPLHub from public XRP
> Ledger data. The subject did not request it, has not accepted it, and no
> relationship or endorsement is implied. Ratings are opinions based on on-chain
> activity, not financial advice.

Source of truth: `UNSOLICITED_DISCLOSURE` in `src/lib/credentials.ts`.

---

## 6. Transactions & costs (mainnet)

| Transaction | Who signs | Fee | Reserve effect |
|---|---|---|---|
| `CredentialCreate` | issuer | 10 drops (0.00001 XRP) | +0.2 XRP owner reserve on the **issuer** (pending) |
| `CredentialAccept` | subject | 10 drops | 0.2 XRP reserve moves **issuer → subject** |
| `CredentialDelete` | issuer (anytime), subject (anytime), anyone (after expiry) | 10 drops | 0.2 XRP reserve released to whoever held it |

Self-issued (`issuer == subject`) credentials are auto-accepted (`lsfAccepted`
set at creation); no `CredentialAccept` needed; the single account holds the
0.2 XRP reserve.

---

## 7. Reading / verifying a credential

`ledger_entry` against the validated ledger:

```json
{ "command": "ledger_entry", "ledger_index": "validated",
  "credential": { "subject": "r...", "issuer": "r...",
                  "credential_type": "<hex from §2>" } }
```

Result flags: `lsfAccepted = 0x00010000`. A credential is **valid for gating**
iff: it exists, `lsfAccepted` is set, and `Expiration` (if present) is in the
future relative to the validated ledger's close time.

`GET /api/credentials/verify?issuer=&subject=&type=` wraps this.

---

## 8. Rollback

Credentials are immutable; the only lever is `CredentialDelete`.

- **Wrong `CredentialType` or issuer address:** delete every affected credential
  (one `CredentialDelete` each, ~10 drops, reserve returned), then re-issue with
  the corrected value. Cost is linear in the number issued.
- This is why the planned rollout was to issue an initial credential to a
  self-controlled wallet (issuer→issuer, or issuer→a team wallet) and only
  start issuing to external subjects once the type strings and issuer address in
  this file are final and reviewed. A mistake caught at that stage is a
  one-transaction fix. (In practice the mainnet credential above was issued to
  an external public wallet, unsolicited and unaccepted; see the disclosure in §5.)

---

## 9. Second credential family: `io.xrplhub.mpt.v1.declared`

A second, unrelated credential family, sharing the same issuer wallet as the score credential (the `CredentialType`
string, not the issuer address, scopes `io.xrplhub.*` namespaces — see §1).

| | |
|---|---|
| **Namespace** | `io.xrplhub.mpt.v1` |
| **CredentialType** | `io.xrplhub.mpt.v1.declared` (one type — no tiers) |
| **Attests** | A backing declaration and the issuer flags of **at least one** MPT this account has issued were **recorded** on-ledger through XRPLHub, at issuance time. |
| **Does NOT attest** | That the declaration is true. That it is "reviewed" or "verified" — it is deliberately never called either. That **every** MPT this account has issued carries a declaration; an issuer can mint further MPTs later with a different one, or none, and this credential does not track that. |

**Why "declared" and not "reviewed":** `src/lib/mptBacking.ts`'s hard line — *"XRPLHub publishes what the issuer
declared. We do not verify it, we cannot verify it, and a declaration is not evidence. An unbacked token and a token
whose issuer merely claims backing look identical on-ledger."* A credential named "reviewed" would misstate that.

**Trigger — automatic, not opt-in.** Queued the instant a `mptissue` purchase delivers (`src/lib/mptCredential.ts`,
called from `src/app/api/execute/verify/route.ts`), because the issuer has already engaged us by buying the service —
unlike the score credential, there is no separate request step. Still "we issue, they accept": a queued request sits
in the same `CredentialRequest` table (`kind: "mpt-declared"`) until a person issues it from the offline key
(`scripts/issue-mpt-credential.cjs`, run via `scripts/issue-queued-credentials.cjs`), and it is not usable for gating
until the subject signs `CredentialAccept`.

**Expiration: 1 year** (longer than the score/domain families' 90 days, and screening's 30) — the fact attested ("a
declaration was recorded at issuance") is inherently point-in-time and doesn't go stale the way a score or a
sanctions check does, so there is no correctness reason to check in more often. It can still be OUTDATED — by a later
MPT from the same issuer with a different declaration, or by DynamicMPT (XLS-94) letting the issuer rewrite an
existing one's metadata — but expiry length doesn't fix either of those; a future improvement is having the daily
MPT-registry pass compare each declaration against what was recorded at issuance and flag (or `CredentialDelete`) one
that has drifted.

**Every issued credential expires — no exceptions.** This matters for reserve hygiene as much as for correctness: an
unaccepted credential ties up 0.2 XRP on the issuer forever unless something expires it and then deletes it (see
"Reissuance and reserve recycling" below). A credential with no `Expiration` would never qualify for that cleanup.

**URI:** `https://www.xrplhub.io/verify/mpt-issuer/<subjectAddress>` — shows the on-ledger credential status and
every MPT this account has issued, with its declaration, live.

**Reserve:** 0.2 XRP per pending credential, same mechanics as §6. Funding the issuer wallet for the score credential
alone assumed one credential family; a second family issuing on its own trigger (every `mptissue` purchase, not just
a subject who asks) changes the worst-case pending count and should be re-budgeted before this is issued at volume.

---

## 10. Third credential family: `io.xrplhub.screen.v2.nomatch`

A third credential family, same issuer wallet as the other two.

| | |
|---|---|
| **Namespace** | `io.xrplhub.screen.v2` (tied to the screening engine version, `sanction-screen-v2`) |
| **CredentialType** | `io.xrplhub.screen.v2.nomatch` (one type — no tiers) |
| **Attests** | At issuance, the subject XRP Ledger address did NOT appear on the current snapshot of every sanctions list XRPLHub screens (OFAC-SDN, EU-FSF, UK-SL). |
| **Does NOT attest** | That the address, or anyone associated with it, is clean, safe, lawful, or unsanctioned. That using it satisfies any screening, AML, or compliance obligation. Never called "clean", "screened-ok", or "verified" anywhere — deliberately named "nomatch", matching the receipts' own vocabulary. |

**Scope note:** screening itself covers XRP Ledger, EVM, Bitcoin and Tron addresses, but a `Credential`'s `Subject`
must be an XRP Ledger account (XLS-70 is XRPL-only) — so this credential can only ever be issued for an XRPL address.

**Opt-in only — never unsolicited.** Unlike the score credential, this is issued only through
`POST /api/credentials/screen-request { subject }`, which screens the address FRESH first: an address currently
listed gets no queued request (200, `not_eligible`), and the screening receipt is still recorded and anchored either
way, like every screen. A clean result queues a `CredentialRequest` (`kind: "screen-nomatch"`).

**Expiration: 30 days** — shorter than the other two families' 90, because the underlying fact changes: a wallet
screened clean today can be listed tomorrow. This is the operationally expensive credential the brief flagged —
every live holder needs re-screening and re-issuance roughly monthly to stay covered, not once.

**Issuance re-checks fresh, every time.** `scripts/issue-screen-credential.mjs` re-screens (calling the same
`screenAll()` engine the live site runs, not a second implementation) immediately before signing, and refuses if the
address is listed at that moment — the request-time screen (possibly hours or days old) is never trusted for the
actual issuance decision. Run via `scripts/issue-queued-credentials.cjs`, same as the other two families.

**URI:** `https://www.xrplhub.io/verify/screening/<subjectAddress>` — the on-ledger credential status plus the most
recent screening receipts on file for that address, live.

**Reserve:** 0.2 XRP per pending credential — see the live finding below.

> **Operational finding (2026-09-27, live check):** the credential issuer wallet (`rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f`)
> holds **1.300009 XRP** against a **1.2 XRP** reserve requirement (1 XRP base + 0.2 XRP × 1 existing pending object),
> leaving roughly **0.1 XRP** of headroom — enough for at most one more pending credential across ALL THREE families
> combined. **Fund this wallet before issuing anything from the `screen-nomatch` or `mpt-declared` queues at any
> real volume**; the 30-day churn of this family alone will otherwise stall on the very first re-issuance cycle.

---

## 11. Fourth credential family: `io.xrplhub.domain.v1.verified`

A fourth credential family, same issuer wallet as the other three. Depends on item 0 of the 2026-09-27 build (the
real two-way `xrp-ledger.toml` check, `src/lib/domainVerify.ts`) — it could not be built honestly before that fix.

| | |
|---|---|
| **Namespace** | `io.xrplhub.domain.v1` |
| **CredentialType** | `io.xrplhub.domain.v1.verified` (one type — no tiers) |
| **Attests** | At issuance, the account's own ledger `Domain` field AND that domain's `xrp-ledger.toml` confirmed a two-way link (the domain lists this exact account under `[[ACCOUNTS]]`). |
| **Does NOT attest** | Identity, KYC, or anything about the account's trustworthiness or intentions, or the content of that domain. A domain-control check only — the same one the MPT issuer risk page already runs, made portable. |

**Opt-in, free to request** — `POST /api/credentials/domain-request { subject }` runs the live two-way check right
now; either direction failing means nothing is queued, and the response says exactly which one and why (the same
`reason` string `domainVerify.ts` produces everywhere else). No purchase gate: this is a low-friction ecosystem trust
signal, not a paid product.

**Expiration: 90 days**, matching the score credential. A domain-hijack or DNS-reassignment window of up to 90 days
is a real, if small, exposure — flagged, not solved.

**Issuance re-checks fresh, every time**, both directions — `scripts/issue-domain-credential.mjs` reads the account's
current `Domain` field and re-runs `verifyDomainTwoWay()` immediately before signing (the same function the live site
uses, not a second implementation), refusing if either side no longer holds.

**URI:** `https://www.xrplhub.io/verify/domain/<subjectAddress>` — shows the on-ledger credential status AND runs the
live check again on every page load, so a reader can see whether the link that was true at issuance is still true
today.

---

## 12. Reissuance and reserve recycling (all four families, added 2026-09-28)

Two facts, checked against the live XRP Ledger docs, not assumed:

- **`CredentialCreate` fails with `tecDUPLICATE`** if a `Credential` object already exists for the same
  (Issuer, Subject, CredentialType) — **regardless of whether it has expired.** Reissuing to a subject who already
  held one is therefore never a plain `CredentialCreate`; the old object must be deleted first, or it fails outright.
- **There is no protocol-level auto-cleanup of expired credentials.** They sit on the ledger — and on whichever
  side's reserve they were on — until someone submits `CredentialDelete`. The issuer can always delete its own
  (expired or not); once expired, anyone can.

**Reissuance fix.** Every `issue-*-credential` script (score, mpt-declared, screen-nomatch, domain-verified) now
checks for an existing credential before signing (`scripts/credentialOps.cjs`, `deleteExpiredCredentialIfAny`):
- exists and **not** expired → refuse (the request-level "already_held" checks should have caught this already —
  reaching this point means something upstream disagrees with the ledger, worth investigating, not papering over);
- exists and **expired** → delete it first (releasing whichever side's 0.2 XRP reserve it was tying up: the issuer's,
  if it was never accepted; the subject's, if it was), then issue the new one.

**Every credential family has a real expiry — this is load-bearing, not incidental.** A credential with no
`Expiration` would never qualify for the cleanup below, and would tie up 0.2 XRP on the issuer forever if the subject
never accepts it. Current validity windows: score 90 days, domain-verified 90 days, mpt-declared 1 year,
screen-nomatch 30 days — every one of them finite.

**Cleanup policy for abandoned (never-accepted) credentials:** delete an unaccepted credential once it has been
expired for **more than 7 days**, uniform across all four families. Reasoning:
- the reserve for an *unaccepted* credential sits on the **issuer** — this is the issuer's own cleanup, not a favor
  to anyone else, and it is why the policy only ever touches unaccepted credentials: an accepted one's reserve has
  already moved to the subject, who is free to keep or delete it as they choose;
- never before expiry — the subject might still accept right up to the last moment, which is the whole point of the
  validity window;
- 7 days, uniform, rather than a per-family number, so the policy stays one sentence: long enough to absorb a
  delayed operator run or clock slop, short enough that reserve doesn't sit locked for weeks over a credential nobody
  was ever going to accept.

Implemented as `scripts/cleanup-unaccepted-credentials.mjs` — walks the issuer's own `account_objects` (authoritative;
independent of our `CredentialRequest` tracking), lists what qualifies by default, `--delete` to act,
`--grace-days N` to override. This **cannot** be a cron job: `CREDENTIAL_ISSUER_SEED` is deliberately never on
Vercel, so nothing that signs runs unattended. Run it by hand, periodically, alongside
`scripts/issue-queued-credentials.cjs` — it is idempotent and safe to run as often as you like.
