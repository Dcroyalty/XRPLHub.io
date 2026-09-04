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
`src/lib/xrplscore.ts`. As of the first mainnet issuance this is **v1.1**
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
- This is why mainnet rollout issues the **first credential to a
  self-controlled wallet** (issuer→issuer, or issuer→a team wallet) and only
  starts issuing to real external subjects after the type strings and issuer
  address in this file are final and reviewed. A mistake caught at that stage is
  a one-transaction fix.
