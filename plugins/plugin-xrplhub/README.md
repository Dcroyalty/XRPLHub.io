# plugin-xrplhub

**XRPLHub for ElizaOS agents.** Score an XRPL wallet, screen an address against OFAC SDN, look up an MPT issuer,
**describe any of 35 XRPL transactions**, and **get the unsigned, ready-to-sign transaction for free** — trustlines,
escrows, AMM, NFTs, multisig, MPT issuance, permission delegation and more.

> **Unsigned only. No custody.** This plugin never signs, never submits, and never touches a key. The transaction it
> returns is a JSON object for **your agent's own wallet** to sign and submit. For agent wallet creation, signing
> and payments, use Ripple's [XRPL AI Starter Kit](https://ripple.com/insights/xrpl-ai-starter-kit/) (Agent Wallet and
> Payment skills). XRPLHub is the complement: it builds transactions (free) and scores wallets; something else signs.

> **Transactions are free** (since 2026-10-05). `XRPLHUB_BUILD_TRANSACTION` returns the unsigned txjson directly — no
> payment, no x402. It only passes a transaction on after checking that every step's `Account` is the wallet you asked
> about and that nothing is already signed. `XRPLHUB_PREVIEW_TRANSACTION` describes one first (what it does, what is
> irreversible, the fields it needs).

## Install

```bash
npm install plugin-xrplhub
```

Add it to your character (alongside a wallet/signing plugin of your choice):

```ts
import xrplhub from "plugin-xrplhub";

export const character = {
  name: "MyAgent",
  plugins: [xrplhub /* , …your wallet / signing plugin */],
};
```

Or by name in `character.json`: `"plugins": ["plugin-xrplhub"]`.

There is nothing to configure: no API key, no environment variable, no setting. The endpoint is fixed to
`https://www.xrplhub.io/api/mcp`.

## Actions

| Action | What it does | Cost | Needs |
|---|---|---|---|
| `XRPLHUB_SCORE_WALLET` | XRPLScore (300–850, 8 on-chain signals) for one wallet. Use before paying, lending to, or onboarding a wallet. | free | an XRPL address |
| `XRPLHUB_SCREEN_ADDRESS` | Compares an address to a pinned OFAC SDN snapshot and returns a verifiable receipt. **Attests to process, not ground truth**: "no match" is not "clean". | free | an XRPL address |
| `XRPLHUB_MPT_RISK` | What an MPT issuer can do to a holder (clawback, freeze, require-auth, non-transferable) plus the issuer's score. | free | a 48-hex `MPTokenIssuanceID` |
| `XRPLHUB_LIST_SERVICES` | Every transaction XRPLHub builds, with each one's parameters. | free | — |
| `XRPLHUB_PREVIEW_TRANSACTION` | Describes one transaction: what it does, **what is irreversible**, every field it needs. **No signable transaction.** | free | `product_id` |
| `XRPLHUB_BUILD_TRANSACTION` | Returns the **unsigned txjson** for one transaction + wallet (every step, in order, for multi-step services), after checking every step's `Account` is that wallet. | free | `product_id`, a wallet address, `params`, `confirm_caution` (caution-tier only) |

Arguments come from `options.parameters` when your runtime provides structured action parameters
(`wallet_address`, `issuance_id`, `product_id`, `params`, `confirm_caution`), otherwise from the message text (an address,
a 48-hex id, and optionally a JSON object such as `{"product_id":"trustline","params":{"currency":"RLUSD","value":"100"}}`).

### Building a transaction

```
User:   set up a trustline for RLUSD on rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF
Agent:  XRPLHUB_PREVIEW_TRANSACTION → what it does, what is irreversible, the fields      (free)
Agent:  XRPLHUB_BUILD_TRANSACTION   → the unsigned TrustSet txjson for that wallet         (free)
Agent:  (your signing plugin)       → checks Account == your wallet, signs, submits
```

- **Free.** XRPLHub charges nothing for transactions; your wallet pays only the XRP Ledger's own network fee.
- **Caution-tier services** (multisig lockdown, regular key, No Freeze, MPT issuance, permission delegation) can be hard or
  impossible to undo. `XRPLHUB_BUILD_TRANSACTION` withholds the transaction and returns what is irreversible until you
  pass `confirm_caution: true`, which you should do **only after the wallet owner has read it**.
- Multi-step services return several transactions: sign them **in order**, each validated before the next.

## Safety rules the plugin enforces

- **Only a transaction for your wallet, never altered.** The build action passes a transaction on only through
  `checkTransactions()`: every step's `Account` must equal the wallet you asked about, nothing may already be signed, and
  any non-printable content is refused rather than trimmed. The read/describe actions never pass a transaction on, even
  from a server that (wrongly) returns one — a test asserts it.
- **Checksums, not just regexes.** Addresses are verified with the XRPL base58 checksum. A mistyped address is refused
  before any network call.
- **No guessing.** An invalid explicit parameter is refused (never swapped for another address found in the chat text).
  Two different addresses in one message means the plugin asks which one.
- **Untrusted ledger text.** Token names, metadata and domains are stripped of control/bidi characters, length-capped,
  and labelled as data, never instructions.
- **Failures are values, not exceptions.** Network errors, timeouts and server errors come back as `success: false`
  with a plain message that says nothing was built or charged.
- **Enforced by a check.** `npm run verify` fails if the built package gains a service, provider, setting, signing or
  submission call, key vocabulary, environment access, or any runtime import other than `node:crypto`.

## What the data is (and is not)

- **XRPLScore** is an informational analytics signal computed only from public XRP Ledger data. It is **not** a FICO
  or consumer credit score, **not** a consumer report or an NRSRO rating, and it **must not** be used, alone or
  combined with other data, to make or communicate any decision about a person's eligibility for credit, insurance,
  employment or housing, or for any other purpose governed by the U.S. Fair Credit Reporting Act (FCRA) or the Equal
  Credit Opportunity Act. The plugin passes XRPLHub's full disclaimer through with every score.
- **OFAC screening** compares an address to a named list snapshot at a stated time (exact match). It is not legal or
  compliance advice and does not discharge your own screening obligations.
- Data is read from the XRP Ledger through XRPLHub's servers; it is only as complete as the public nodes it can reach,
  and responses say when it is partial.

## Compatibility

`@elizaos/core` is a peer dependency used **for types only** — the built package has no runtime import of it, so it does
not pin a core version. Verified against `@elizaos/core` 1.7.2 (npm `latest`) and 2.0.3-beta.7.

## Development

```bash
npm install
npm run verify                # typecheck + tests (offline) + build + surface check
node scripts/live-check.mjs   # manual: exercises every action against production, previews all 35 services
```

## Links

- Site: <https://www.xrplhub.io> · MCP server: <https://www.xrplhub.io/api/mcp> · `llms.txt`: <https://www.xrplhub.io/llms.txt>
- Ripple's XRPL AI Starter Kit (signing, wallets, payments): <https://ripple.com/insights/xrpl-ai-starter-kit/>

MIT licensed. © 2026 XRPLHub.io
