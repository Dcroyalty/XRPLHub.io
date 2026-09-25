# plugin-xrplhub

**XRPLHub for ElizaOS agents.** Score an XRPL wallet, screen an address against OFAC SDN, look up an MPT issuer,
and get an **unsigned**, ready-to-sign transaction for any of 34 XRPL services — trustlines, escrows, AMM, NFTs,
multisig, MPT issuance and more.

> **Unsigned only. No custody.** This plugin never signs, never submits, and never touches a key. Every transaction it
> returns is a JSON object for **your agent's own wallet** to sign and submit. For agent wallet creation, signing and
> payments, use Ripple's [XRPL AI Starter Kit](https://ripple.com/insights/xrpl-ai-starter-kit/) (Agent Wallet and
> Payment skills). XRPLHub is the complement: it builds and scores; something else signs.

## Install

```bash
npm install plugin-xrplhub
```

Add it to your character:

```ts
import xrplhub from "plugin-xrplhub";

export const character = {
  name: "MyAgent",
  plugins: [xrplhub /* , …your wallet/signing plugin */],
};
```

Or by name in `character.json`: `"plugins": ["plugin-xrplhub"]`.

There is nothing to configure: no API key, no environment variable, no setting. The endpoint is fixed to
`https://www.xrplhub.io/api/mcp`.

## Actions

| Action | What it does | Needs |
|---|---|---|
| `XRPLHUB_SCORE_WALLET` | XRPLScore (300–850, 8 on-chain signals) for one wallet. Use before paying, lending to, or onboarding a wallet. | an XRPL address |
| `XRPLHUB_SCREEN_ADDRESS` | Compares an address to a pinned OFAC SDN snapshot and returns a verifiable receipt. **Attests to process, not ground truth**: "no match" is not "clean". | an XRPL address |
| `XRPLHUB_MPT_RISK` | What an MPT issuer can do to a holder (clawback, freeze, require-auth, non-transferable) plus the issuer's score. | a 48-hex `MPTokenIssuanceID` |
| `XRPLHUB_LIST_SERVICES` | Every transaction XRPLHub can build, with each one's parameters. | — |
| `XRPLHUB_BUILD_TRANSACTION` | An **unsigned** txjson for one service and one wallet. | `product_id`, a wallet address, `params` |

Arguments come from `options.parameters` when your runtime provides structured action parameters
(`wallet_address`, `issuance_id`, `product_id`, `params`), otherwise from the message text (an address, a 48-hex id, and
optionally a JSON object such as `{"product_id":"trustline","params":{"currency":"RLUSD","value":"100"}}`).

### Building a transaction

```
User:  build a trustline to RLUSD for rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF
Agent: (XRPLHUB_LIST_SERVICES → XRPLHUB_BUILD_TRANSACTION) → unsigned TrustSet txjson
Agent: (your signing plugin) signs and submits it
```

The result's `data` carries `{ unsigned: true, safetyTier, transactions: [{ id?, label?, txjson }] }`, and
`values.xrplhubUnsignedTransactions` holds the same list so a following signing action can pick it up. Multi-step
services return several transactions to sign **in order**. Services tagged `caution` change account security or
permissions and can be hard to undo; the text says so and asks for explicit confirmation before signing.

## Safety rules the plugin enforces

- **Wrong-account guard.** Before returning a transaction it checks every step's `Account` equals the wallet you asked
  for. Anything else is refused, so a bad response can never reach a signer.
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
npm run verify        # typecheck + tests (offline) + build + surface check
node scripts/live-check.mjs   # manual: exercises every action against production and builds all 34 services
```

## Links

- Site: <https://www.xrplhub.io> · MCP server: <https://www.xrplhub.io/api/mcp> · `llms.txt`: <https://www.xrplhub.io/llms.txt>
- Ripple's XRPL AI Starter Kit (signing, wallets, payments): <https://ripple.com/insights/xrpl-ai-starter-kit/>

MIT licensed. © 2026 XRPLHub.io
