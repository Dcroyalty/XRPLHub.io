# XRPLScore v1.1 — model redesign & calibration

Calibrated Sep 2026 against **333 real mainnet accounts** (non-curated: recent
transactors, active DEX traders, long-lived accounts, and named exchange/issuer
wallets). Raw data: `scratchpad/calib-raw-333.jsonl`. Prototype:
`scratchpad/xrplscore-v1.1-model.mjs`.

## Why v1 was broken

v1's distribution collapsed a nominal 300–850 range into a real 300–690 band.
Median 498; **nothing scored above 700**; every major exchange scored 600–690.
Causes:

| Signal | v1 problem |
|---|---|
| `builderCommitment` (10%) | Counted payments to the XRPLHub treasury. 0 for 100% of non-customers. A "have you paid us" metric inside a credit score. |
| `reserveRatio` (9%) | Used `10 + 2·OwnerCount` — the pre-Dec-2024 (20-XRP-base) reserve. Real is `1 + 0.2·OwnerCount`. ~10× too harsh. |
| `txVelocity` (20%) | `account_tx` caps at 400 rows; formula was `count/500`. A 400-tx and a 40,000-tx wallet scored identically (80). 22 pts structurally unreachable. |
| `securityFlags` + `ammActivity` + `nftActivity` (20%) | 85–99% of wallets score 0. Minority behaviours weighted as if universal. |
| `trustLines` (13%) | Cap at 15 lines; median wallet holds 2–3. |

## The 6 fixes (all applied)

1. **`builderCommitment` removed from the base score entirely.** Not down-weighted — gone. A public credit standard cannot score wallets higher for being the issuer's customers.
2. **`reserveRatio` → `financialHealth`**: real reserve `1 + 0.2·OwnerCount`; `0.4·log10(spendableXRP) + 0.6·(buffer above the reserve line)`.
3. **`txVelocity` → `txActivity`**: lifetime estimate, not a 400-row count. Modern (deletable) accounts: `Sequence − firstTxLedger`. Legacy: `Sequence`. Log curve, reference ~8,000 txs.
4. **`securityFlags` (→`securityConfig`), `ammActivity`, `nftActivity`** down-weighted from 20% combined to **8%** combined.
5. **`trustLines` → `tokenEngagement`**: `sqrt(lines / 8)` — a 3-line wallet scores 61, not 20.
6. **Rescaled** so real wallets populate 300–850 on an **absolute** scale.

## The v1.1 model (`src/lib/xrplscore.ts`)

`score = 300 + Σ(signal·weight)·5.5`, signals 0–100.

| Signal | Weight | Formula |
|---|--:|---|
| `accountAge` | 28% | `sqrt(ageDays / 1095)·100` — max at 3 yr |
| `txActivity` | 22% | `log10(lifetimeTx + 1) / log10(8000)·100` |
| `financialHealth` | 22% | `0.4·clamp(log10(spendable+1)/log10(2500)·100) + 0.6·clamp((buffer−1)/7·100)` |
| `tokenEngagement` | 12% | `sqrt(trustLineCount / 8)·100` |
| `dexActivity` | 8% | `(hasOffers?20:0) + min(80, sqrt(dexTx/25)·80)` |
| `ammActivity` | 3% | `sqrt(ammTx / 8)·100` |
| `securityConfig` | 3% | multisig 40 + regKey 20 + domain 20 + emailHash 10 + escrow 10 |
| `nftActivity` | 2% | `nftCount/8·50 + nftTx/15·50` |

## v1 → v1.1 (333-account calibration)

| | v1 | v1.1 |
|---|---|---|
| median | 498 | **633** |
| p90 / p95 | 596 / 620 | **743 / 763** |
| max | 691 | **806** |
| range used | 300–690 | **364–806** |

**Named wallets:**

| Wallet | v1 | v1.1 |
|---|---:|---:|
| Bitstamp (hot) | 687 | **765** |
| Sologenic (SOLO issuer) | 687 | **765** |
| Bitstamp USD issuer | 617 | **765** |
| GateHub (hot) | 651 | **753** |
| Kraken (hot) | 612 | **750** |
| Bitso | 645 | 742 |
| Coinfield | 672 | 740 |
| Ripple RLUSD issuer | 641 | 721 |
| XRPL Labs (Xaman) | 601 | 675 |
| Uphold | 461 | 603 |
| **Treasury** `rs59g3…` | **358** | **462** |

**By account type (median):** long-lived (2 yr+) **681** · DEX trader **667** ·
recent active sender **569** · recent recipient **552**.

## Tier qualification (min600 / 650 / 700 / 750 kept)

| Tier | % of the 333-account sample | ≈ % of all XRPL* |
|---|--:|--:|
| min600 | 62% | ~40% |
| min650 | 41% | ~25% |
| min700 | 22% | ~13% |
| min750 | 10% | ~5% |

\* The sample over-represents *active* wallets by design. Against the full
ledger (which is mostly dormant/dust wallets that will never request a
credential) subtract ~20 points from each row.

**Semantics — the tier names are meaningful on the absolute scale:**

- **min750** — Bitstamp, Kraken, Sologenic, GateHub. Near-max on the
  fundamentals: multi-year, high lifetime activity, funded, engaged. Institutional-grade.
- **min700** — old + active + funded + engaged. Top of the active population.
- **min650** — an established, clean 2-year wallet (long-lived median 681).
- **min600** — a real, sustained history. Roughly the median *active* wallet.
  Below this: throwaway / brand-new / dust — correctly not eligible.

If a stricter reading is wanted (min600 = "top 30%", not "median active"),
multiply the score by 5.3 instead of 5.5 — this drops the median ~15 pts but
also pulls the top exchanges to ~750 exactly. Current recommendation: keep 5.5;
the eligibility floor already excludes non-serious wallets.
