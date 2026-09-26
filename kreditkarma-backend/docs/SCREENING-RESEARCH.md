# Sanctions screening — research, decisions and what is NOT verified

Written 2026-09-25 while extending screening from "OFAC SDN, XRP addresses" to OFAC + EU + UK across XRPL/EVM/Bitcoin/Tron.
Everything below marked **verified** was read from the primary source or measured on the real file on that date.
This is engineering documentation, not legal advice.

## 1. Which lists contain screenable crypto addresses (measured on the real files)

| List | Publisher / source | Address content (measured) | Screened? |
|---|---|---|---|
| **OFAC SDN** | US Treasury, `sdn.xml` | Structured: `Digital Currency Address - <CUR>` identifiers. 1,059 addresses: Tron 334, Bitcoin 542, EVM 133, XRP 1 (CHATEX), other chains 49 | **Yes** — XRPL, EVM, BTC, Tron |
| **EU consolidated financial sanctions** | European Commission FISMA "Financial Sanctions Files" (XML, token URL) | **Name/entity list.** Crypto addresses appear only as free text in `<remark>` fields: **9 addresses** found (Garantex-type designations; EVM and Tron). None on the XRP Ledger | **Yes, partial by nature** — we say so in every receipt's list entry (`chainAddressCount`) and in the Terms |
| **UK Sanctions List** | UK FCDO (single source since 2026-01-28; the OFSI Consolidated List is **closed**) | **Name/entity list.** Addresses only as free text in `OtherInformation` / `UKStatementofReasons`: **59 addresses** (Bitcoin, EVM, Tron). None on the XRP Ledger | **Yes, partial by nature** |
| **UN Security Council consolidated** | UN | Name/entity list. **0 crypto addresses** (checked the full file) | **No.** We cannot claim address screening against it, and we do not |

Consequence stated plainly: **for an XRP Ledger address, EU and UK screening can never produce a hit today** (they name no XRPL addresses). Their receipts still name the lists and say `names 0 XRP Ledger addresses`, so the receipt is honest about what was and was not checked. For EVM / Bitcoin / Tron the EU and UK lists add real, if few, addresses.

**Ingestion honesty.** Addresses in free text are extracted only when they pass a chain checksum (XRPL base58, EIP-55 for mixed-case EVM, base58check/bech32/bech32m for Bitcoin, base58check 0x41 for Tron). Address-like text that does *not* verify is reported as `unparsed` (with an operator alert), never silently dropped. One EU Tron address is split by whitespace in the source; it is repaired at ingestion (tested). A query address that fails its checksum is **refused** (HTTP 400), never answered "not listed".

## 2. What a MiCA-licensed VASP actually needs — and what we do about each

Sources read: EBA/GL/2024/15 (restrictive-measures policies for PSPs **and CASPs**, applies from 30 Dec 2025), EBA/GL/2024/14, EBA/GL/2024/11 (Travel Rule), Regulation (EU) 2023/1114 (MiCA) Art. 68(9), AMLR Art. 77.

* **Lists.** EBA/GL/2024/15 §4.1.5 ¶19–22: CASPs screen **all** transfers of crypto-assets before making them available; screening data includes originator/beneficiary **wallet addresses "to the extent that this information is available in official lists of wallet addresses linked to restrictive measures"** (¶21(f)). ¶9: update the screened dataset **immediately** after a measure is adopted/updated/lifted. ¶6: review the screening system at least annually and document its capabilities **and limitations**. → We publish the lists, versions and limitations per receipt and at `/api/screen/lists`; refresh is **daily** (~06:00 UTC), which is *not* "immediately" — we say so. The VASP's own process must cover the gap.
* **Outsourcing.** The VASP keeps ultimate responsibility for its screening system even if it uses a third-party tool (EBA guideline on delivery-channel/third-party dependence, incl. ¶26a as read). → Terms say so; we never claim to discharge it.
* **Retention / audit format.** MiCA Art. 68(9) and the AML record-keeping rules require the **VASP** to keep records (five years, extendable by the authority). → We commit to **at least 10 years, no pruning** for our copy of every receipt, leaf, proof, anchor and list snapshot, write the retention code `retain-10y-no-prune/v1` **into every receipt**, and ship `GET /api/attest/export` (JSON + CSV, inclusion proofs, anchor tx hashes) so the VASP keeps its own copy. The export is verifiable by an auditor without trusting us (recipe in the response).
* **Travel Rule interaction.** Screening is a separate duty from Travel Rule data transfer (EBA/GL/2024/11 §4.6: new information obtained later must also be screened). → We carry an optional caller `reference` (e.g. a transfer id) **inside the attested leaf** so a receipt can be tied to a transfer. It is an opaque id: the field validator rejects personal-looking text, and the Terms tell callers not to put personal data in it. We do **no** Travel Rule data exchange.
* **What we do not do.** No name/alias/fuzzy matching (a VASP screening customers by name needs a name-matching system — EBA ¶17–18); no transaction-graph/counterparty analysis; no "MiCA compliant" claim anywhere; no claim that using the service satisfies any obligation.

## 3. Design decisions

* **One receipt per address, canon `sanctions-screen-v2`** (engine `sanction-screen-v2`). Each of the lists used is a separate entry `{name, vintage, sha256, chainAddressCount}`; the receipt therefore names every list and vintage. v1 (`ofac-screen-v1`, OFAC only) receipts are untouched and still rebuild to their stored leaf hash (tested on 5 sampled v1 receipts copied from production into the rehearsal branch, and a mixed v1+v2 anchor batch produced valid inclusion proofs for every receipt).
* **Integrity gates** (per list, before any snapshot replaces the previous one): size floor, record-count drop >10%, zero addresses when the previous had some, address drop >40%, byte-identical content deduped. A refused snapshot alerts an operator and the previous snapshot stays in force. Snapshots are written atomically (one transaction, row-count asserted).
* **Fail closed.** A list with no snapshot ⇒ 503 for screening (never "checked fewer lists"). A v1 (XRP-only) OFAC snapshot cannot vouch for an EVM address, so a screen on a non-XRPL chain is unavailable until OFAC has a v2 snapshot.
* **Batch** `POST /api/screen/batch` (≤100): valid addresses charged one call each; refused *as a whole* if the quota cannot cover them; all receipts in one DB transaction ⇒ same anchor batch, shared `batchId`.
* **Monitoring.** `sanctions_hit` (name unchanged from the earlier build; "sanctions_listed" does not exist) now checks every list on every daily pass, for subjects on any supported chain. The hit event names the list(s), every list checked, and carries a fresh receipt id. `sanctions_delisted` says where it had been listed. Tested offline (17 cases) incl. listed-tomorrow, still-listed, delisted, two-list baseline hit, fail-closed.
* **Frozen canon.** `monitor-observation-v1` is unchanged; several lists are carried in its existing three strings by a documented set-descriptor convention (`list`=`A+B+C`, `vintage`=`A@v;B@v`, `sha256`=hash of the per-list hashes). Engine version bumped to `monitor-engine-v2`.

## 4. NOT verified / open — read before relying on any of this

1. **Regulation (EU) 2023/1113 (TFR) Article 26 was not re-read from the primary text** — only via the EBA guidelines' citations. Do not quote it from this document.
2. **10-year retention vs. the database.** The promise is written into every receipt and the Terms. It is only as good as the storage: the database is on a Neon plan whose durability/backup terms were not audited here. The **owner (and counsel) must approve the 10-year figure** and decide on off-platform archival (`/api/attest/export` is the mechanism). I stated the period because the brief asked for an exact one.
3. **Publisher feeds can change.** The EU FSF download uses a public token URL; the UK file location moved when OFSI closed. Both are gated (size/record floors) and alert on failure, but a format change would surface as a refused snapshot, not a silent pass.
4. **Production ingestion of the new lists could not be triggered by me** except by running the operator script against the production database (which is how the first snapshots are seeded before deploy); thereafter the daily cron does it.
5. **Free-text address extraction is best-effort.** An address written in a form our extractor does not recognise is invisible to screening. Checksummed extraction found 9 (EU) and 59 (UK); zero `unparsed` on the files read.
6. **No end-to-end paid-flow tests on production** (no real customer payments were made by me).
7. The EU/UK lists are updated by publishers on their own schedule; our daily job confirms them daily but the *content* may only change weekly or less.
