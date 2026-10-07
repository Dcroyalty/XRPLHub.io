# plugin-xrplhub

**XRPLHub for ElizaOS agents.** Score an XRPL wallet, screen an address against OFAC SDN, and see what an MPT issuer
can do to its holders — three read-only lookups.

> **Read-only. No custody.** This plugin never builds, signs or submits a transaction and never touches a key. For agent
> wallet creation, signing and payments, use Ripple's [XRPL AI Starter Kit](https://ripple.com/insights/xrpl-ai-starter-kit/)
> (Agent Wallet and Payment skills). XRPLHub is the complement: it tells your agent about a wallet or token before it acts.

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

Arguments come from `options.parameters` when your runtime provides structured action parameters (`wallet_address`,
`issuance_id`), otherwise from the message text (an address or a 48-hex id).

The transaction list / preview / build actions were removed on 2026-10-07, when XRPLHub stopped building generic XRPL
transactions. Build transactions with your wallet or the XRPL libraries.

## Safety rules the plugin enforces

- **Never a transaction.** No action passes a transaction on, even from a server that (wrongly) returns one — a test
  asserts it.
- **Checksums, not just regexes.** Addresses are verified with the XRPL base58 checksum. A mistyped address is refused
  before any network call.
- **No guessing.** An invalid explicit parameter is refused (never swapped for another address found in the chat text).
  Two different addresses in one message means the plugin asks which one.
- **Untrusted ledger text.** Token names, metadata and domains are stripped of control/bidi characters, length-capped,
  and labelled as data, never instructions.
- **Failures are values, not exceptions.** Network errors, timeouts and server errors come back as `success: false`
  with a plain message.
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
node scripts/live-check.mjs   # manual: exercises every action against production
```

## Links

- Site: <https://www.xrplhub.io> · MCP server: <https://www.xrplhub.io/api/mcp> · `llms.txt`: <https://www.xrplhub.io/llms.txt>
- Ripple's XRPL AI Starter Kit (signing, wallets, payments): <https://ripple.com/insights/xrpl-ai-starter-kit/>

MIT licensed. © 2026 XRPLHub.io
