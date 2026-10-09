# XRPLHub — hub gaps research (2026-10-09)

Goal: find what XRPL users, developers, businesses and agents need that nobody on XRPL provides, then build the
top candidates that pass every gate. Every claim below has a source; "not found" means searched for and not found,
which is weaker evidence than a positive source and is labelled as such.

**Gates:** DEMAND · UNIQUE · XAMAN-SAFE · NON-CUSTODIAL · LIVE · TERMS-SAFE · PLAIN · AUTONOMOUS.

## Live ledger state (read from mainnet `feature`, xrplcluster.com, 2026-10-09)

| Amendment | Enabled | Note |
|---|---|---|
| PermissionDelegationV1_1 | yes | went live 2026-10-08 ([The Coin Republic](https://www.thecoinrepublic.com/2026/10/08/xrp-ledger-permission-delegation-goes-live-what-you-need-to-know/)) |
| BatchV1_1 + fixBatchV1_2 | yes | activated ~2026-10-09 ([U.Today](https://u.today/five-days-left-for-key-xrp-transaction-upgrade-what-comes-next), [bitbase](https://www.bitbase.com/news/xrp-batch-upgrade-gets-fix-in-latest-xrpl-software-release-as-community-resets-vote)) |
| TokenEscrow, PriceOracle, Credentials, PermissionedDomains, MPTokensV1, AMMClawback, DID | yes | |
| DynamicMPT, LendingProtocol, SingleAssetVault, fixCleanup3_4_0 | **no** | |

## Ranked result

| # | Candidate | Verdict |
|---|---|---|
| 1 | **Wallet Permissions Check** — "who can move money from this wallet?" | **PASSES all gates → BUILD** |
| 2 | **Batch Send** — "pay up to 8 people with one approval" | **PASSES all gates → BUILD** (one wallet test needs you, see below) |
| 3 | Payroll / recurring invoices for teams | **SKIPPED** (owner decision 2026-10-09) |
| 4 | Wallet inheritance ("dead man's switch") | **PARKED** (owner decision 2026-10-09) |
| 5 | XRPLScore as an on-ledger credit oracle | fails DEMAND + needs treasury money → rejected |
| 6 | Consumer wallet activity alerts | fails AUTONOMOUS + UNIQUE → rejected |
| 7 | Team treasury / multi-approver wallet (Safe-like) | fails UNIQUE → rejected |
| 8 | Account cleanup that returns locked reserve | fails XAMAN-SAFE/UNIQUE → rejected |
| 9 | Portfolio and profit/loss tracking | fails UNIQUE/XAMAN-SAFE → rejected |

Only two candidates pass every gate. I did not force a third.

---

## 1. Wallet Permissions Check — BUILD

**One sentence:** "Paste a wallet and see everyone who can move money out of it — and remove the ones you don't want."

**Demand**
- Ethereum's equivalent, revoke.cash: **2M+ users, 20M+ approvals revoked, $140M+ protected, 80+ networks** ([revoke.cash](https://revoke.cash/)).
- XRPL just gained the same risk class: Permission Delegation lets another account send transactions for yours ([xrpl.org: Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation)). It went live 2026-10-08 (above).
- Revoking needs a DelegateSet with an empty `Permissions` list, and only works if the entry exists ([xrpl.org: DelegateSet](https://xrpl.org/docs/references/protocol/transactions/types/delegateset)).
- xrpl.org's own risk notes: compromised delegate keys, and "it is recommended not to delegate the PaymentBurn granular permission" until fixCleanup3_4_0 (still not enabled, above) ([xrpl.org](https://xrpl.org/docs/concepts/accounts/permission-delegation)).

**Unique**
- Xaman's documented xApps and XRPL Services list no permissions or delegation viewer ([Xaman help index](https://help.xaman.app/app/llms.txt), [xApps](https://help.xaman.app/app/all-about-xapps/xumm-xapps)).
- Explorers show raw account objects. A search for delegation-viewing tools found none ([search, 2026-10-09](https://xrpl.org/resources/dev-tools/xrpl-explorers)). *Not-found evidence.*
- "Cerberus Index": no public trace found. Bithomp, XRPScan, xrpl.to, XPMarket, First Ledger and xrpldashboard: no plain "who can move your money" view found. *Not-found evidence.*

**Other gates**
- Xaman-safe: read-only; the revoke transaction is free.
- Non-custodial, live (Delegation enabled), terms-safe (reads public ledger data from our own node pool).
- Plain, as above.
- Autonomous: no cron needed; a watchdog probe covers it.

**Money:** free for people on the page. Agents and businesses pay per call over x402 (USDC on Base or RLUSD on XRPL), same rails and price tier as the score API.

**Size:** small to medium (one library, two API routes, page, MCP tool, docs).

## 2. Batch Send — BUILD

**One sentence:** "Send XRP or RLUSD to up to 8 people with one approval — all of them get paid, or none do."

**Demand**
- The ledger feature exists for exactly this: "Up to eight transactions can be submitted in a single batch", with an all-or-nothing mode ([xrpl.org: Batch](https://xrpl.org/docs/concepts/transactions/batch-transactions)).
- Asset managers are preparing for it ([bitbase](https://www.bitbase.com/news/asset-managers-are-preparing-for-xrpl-batch-what-can-it-actually-do)).
- On EVM chains, bulk-send tools (Disperse, BulkSender) are a standard category ([dev.to comparison](https://dev.to/block_experts_766a3a21915637/comparing-ethereum-bulk-senders-why-transparency-and-verified-contracts-matter-4odf), [dev.to costs](https://dev.to/zouhairstack/maximize-your-savings-how-much-can-you-earn-by-bulk-sending-to-100-addresses-instead-of-sending-aef)).

**Unique**
- Xaman's documented xApps include no bulk, batch or multi-recipient send ([Xaman help index](https://help.xaman.app/app/llms.txt)).
- A search for an XRPL bulk-send tool found none. *Not-found evidence.*

**Other gates**
- Xaman-safe: Xaman doesn't offer it, and it stays **free** anyway (it is a transaction).
- Non-custodial: the payer signs one Batch in their own wallet.
- Live: Batch enabled.
- Terms-safe, plain.
- Autonomous: nothing runs on a schedule.

**Open item (not a gate failure):** whether Xaman signs a Batch transaction correctly has never been tested by a person. Our Spend Controls Batch flag (`SPEND_BATCH_XAMAN_VERIFIED`) is still false for that reason. Testnet proves the ledger side; one small real Batch signed in Xaman proves the wallet side.

**Money:** free. Indirect value: the same builder makes Spend Controls one-signature, and it is a free on-ramp to the paid tools.

**Size:** small.

## 3. Payroll and recurring invoices — SKIPPED (owner decision, 2026-10-09)

**Decision:** skip. Ripple sells enterprise RLUSD payroll and payouts, and Ripple is the company we'd want to acquire
us — we don't compete with Ripple. Paying several people on a schedule is already covered by Spend Controls budgets
(and one-off by Batch Send). Reopen only if Ripple's position changes.

Research kept for the record:

- **Demand is real:** Request Finance had paid $200M+ in crypto invoices for 2,000+ Web3 operations by June 2022 ([newsletter](https://email.mg2.substack.com/c/eJwlUcuO5CAM_JrmlggISdMHDnPZ34gImDSaBLLgTJT9-jXTEsJW-VF22VmENZfbHLkia9-M9wEmwVU3QITCzgpljt4oKZ7Dc2LkeaFHzWKdQwHYbdwMlhPYcS5bdBZjTq1ASiE1exuwQmluZfBhDKOQk7PWaxdsUFJNyn9o7ekjJAcGfqDcOQFzed8hYWvFNvNGPOpj-HrIP_Su6-qPe09Ye0ojoA1MJqYfqNjKOizWfUMhUHIpyRT4e1KwCzFZIurWkq-Y1s5DPSJC58p9YO4Io7W7YmOF2o2tOYum9eCTEIIPWrz6oeeODwufrFYyTHpUD8X3Vfb1XCoScRuLFVMgWcwUWyD9IzL7i5NQc9vuTBHvmVKWDfxHQ_xc4lfVeYUEhS7kZ4tGTKN6qeElNX_pj2akzKj1c1BaMyL2maqSwXesF8B3TKGt4t7_AToPpvE), [coincodex](https://coincodex.com/review/12722/request-finance-review-manage-your-crypto-payments-and-invoices-with-ease)). PaymentX offers crypto payroll and invoices on other chains ([alternativeto](https://alternativeto.net/software/paymentx/about/)).
- **Not unique on XRPL:** Ripple itself sells crypto payroll and stablecoin payouts in RLUSD ([ripple.com/use-case/global-payouts](https://ripple.com/use-case/global-payouts/)). That is enterprise and fiat-connected; ours would be self-serve and non-custodial.
- **Build size if you say yes:** medium. Multi-payee Autopay on the infrastructure we already tested (one pre-approved payment per employee per period, on tickets).
- **Your call:** is "Ripple does enterprise payouts" close enough to block us?

## 4. Wallet inheritance — PARKED (owner decision, 2026-10-09)

**Decision:** parked, for three reasons:
1. **Weak demand:** only a community amendment idea (not an XLS spec, not on any ledger) and multi-chain products elsewhere.
2. **Legal exposure:** it would move a possibly-living person's money after silence; it is not a will.
3. **The full sweep failed** on Testnet (below): a pre-signed AccountDelete burned its ticket and can't pass trust lines.

Reopen only with real demand evidence AND a legal review. Research kept for the record:

- **Demand:** a community "dead man's switch" amendment idea (Kris Dangerfield, Nov 2024; resurfaced Sept 2025) for automatic transfer to a beneficiary after inactivity. It is not an XLS spec or on mainnet ([MEXC News](https://www.mexc.com/news/496976), [MEXC News](https://www.mexc.com/news/498179)). Multi-chain inheritance products exist: Vault12 ([Substack](https://vault12.substack.com/p/how-it-works-vault12-digital-inheritance)), Bron (launched 2026-03-02, [BusinessWire](https://www.businesswire.com/news/home/20260302944689/en)), Casa ([CB Insights](https://www.cbinsights.com/company/vault12/alternatives-competitors)).
- **Feasibility tested on XRPL Testnet (2026-10-09):** a pre-signed AccountDelete on a ticket (the only way to sweep *all* XRP) returned `tecTOO_SOON`, and that failure **used up the ticket**. Re-submitting returned `tefNO_TICKET`. AccountDelete is also blocked by trust lines that hold tokens ([xrpl.org: Deleting Accounts](https://xrpl.org/docs/concepts/accounts/deleting-accounts)), so it can't sweep a typical holder's wallet. The workable form is a pre-signed *fixed-amount* payment (our Autopay mechanics), plus a "proof of life" sign-in to reset the timer.
- **Decisions only you can make:**
  - Do we operate a product that moves a possibly-living person's money after silence?
  - Minimum waiting period and warnings.
  - Legal wording (this is not a will).
  - That it covers a fixed XRP amount, not "everything".

## 5. XRPLScore as an on-ledger credit oracle — REJECTED

- **Fails DEMAND:** XLS-65 and XLS-66 never read oracles; no on-ledger consumer exists. From our own research, 2026-09: [XLS-66 spec](https://github.com/XRPLF/XRPL-Standards/discussions), see memory `xls47-oracle-research-sep-2026`.
- **Needs money:** about 41 XRP of reserve per 1,000 wallets, from the treasury.

## 6. Consumer wallet activity alerts — REJECTED

- **Fails UNIQUE:** zerptracker already monitors the XRPL with "notifications via email, SMS, webhooks" ([xrpl.js APPLICATIONS.md](https://github.com/XRPLF/xrpl.js/blob/main/APPLICATIONS.md)).
- **Fails AUTONOMOUS:** real-time alerts need a listener; our Vercel Hobby plan runs crons once a day.
- Our paid monitoring API already serves businesses.

## 7. Team treasury / multi-approver wallet — REJECTED

- **Fails UNIQUE:** the "Multi sign" xApp "allows users to easily create, distribute & collect multi sign signatures", listed as trusted by XRPL Labs ([XRPLWin](https://xrplwin.com/apps/xapp:xumm.multisign)). A second MultiSig xApp exists too ([XRPLWin](https://xrplwin.com/apps/xapp:lathan.multisig)).
- Safe's adoption on Ethereum is proven ($60B+ secured, 57.5M Safes; [MEXC News](https://www.mexc.com/news/467694)), but the XRPL niche is taken.

## 8. Account cleanup that returns reserve — REJECTED

- **Fails XAMAN-SAFE:** Xaman offers Account delete in XRPL Services ([Xaman help](https://help.xaman.app/app/learning-more-about-xaman/deleting-an-xrpl-account)), plus Token Trasher ([Xaman help](https://help.xaman.app/app/all-about-xapps/xrpl-services/token-trasher)) and Account Merge ([Xaman help](https://help.xaman.app/app/all-about-xapps/xumm-xapps/account-merge)).

## 9. Portfolio and profit/loss tracking — REJECTED

- **Fails UNIQUE:** XPMarket offers token portfolio tracking with profit and loss ([CoinCodex](https://coincodex.com/crypto/xpmarket/guides)).
- **Fails XAMAN-SAFE:** Xaman has Account Worth and a Transaction Exporter xApp ([Xaman help index](https://help.xaman.app/app/llms.txt)), and a Koinly CSV exporter exists ([GitHub](https://github.com/go140point6/xrpl-tx-exporter-csv)).
