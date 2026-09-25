# AGENT-DISTRIBUTION — where agents find XRPLHub, and what still needs a human

Written 2026-09-25. Facts below were read from the live registries/directories that day; anything inferred is marked
**(inferred)**. Posture: **XRPLHub builds unsigned transactions and scores wallets; it never signs and never holds keys.**
Agents sign with their own wallet (Ripple's XRPL AI Starter Kit has Wallet and Payment skills for that).

## State on 2026-09-25

| Channel | State | Refreshes how |
|---|---|---|
| Official MCP Registry (`io.github.Dcroyalty/xrplhub`) | **1.12.0** (latest), description "…34 XRPL actions. You sign; no keys held." Old 1.3.0 ("35 actions") is still listed as a non-latest version. | Bump `server.json` `version`, `git tag vX.Y.Z && git push origin vX.Y.Z` (workflow `publish-mcp.yml`, GitHub OIDC). The `version` MUST change for the registry to accept it. |
| Glama (`glama.ai/mcp/connectors/io.github.Dcroyalty/xrplhub`) | Auto-synced from the official registry; already shows the new description. **Unclaimed.** | Automatic. To claim (health checks, analytics): the page offers GitHub, HTTP-challenge or DNS — needs a human login. |
| Smithery (`butterballslaw/XRPLHub`, ~768 uses) | **STALE**: shows 3 tools and "35 XRPL transaction builders"; we serve 20 tools. | Human, needs a Smithery login: `smithery mcp publish "https://www.xrplhub.io/api/mcp" -n butterballslaw/XRPLHub`. `/.well-known/mcp/server-card.json` is current (v1.12.0, 20 tools) and is what a scan falls back to. |
| mcp.so | **Not listed.** Human-reviewed, submission is a GitHub issue on `chatmcp/mcpso` (needs a GitHub login). | Draft below. |
| xrpl-ai.org (t54's XRPL x402 directory) | **Listed** as one merchant card ("XRPLHub — XRPLScore™", merchant = treasury, category Trust & Security). `POST https://xrpl-ai.org/api/verify {"url":"https://www.xrplhub.io"}` on 2026-09-25 reported `registeredCount: 7`. The 4 it rejected are Base-only resources (no PAYMENT-REQUIRED header), by design. The card's "endpoints" count may lag or count only endpoints with settlements **(inferred)**. | Re-run the same `POST /api/verify` (it is the public "List your service" form's endpoint) after any change to `/.well-known/x402`. |
| ElizaOS registry | **Retired by elizaOS on 2026-09-23** (PR #32223 / issue #32219): third-party plugins and registry entries are out of scope and existing submissions were closed. | n/a — distribute via npm. See `plugins/plugin-xrplhub/README.md`. |

## x402: which resources take which rail

`/.well-known/x402` lists 15 entries (11 URLs). XRPL-native (RLUSD via t54, x402 v2, `PAYMENT-REQUIRED` header, network `xrpl:0`):
`score` ($0.02), `report` ($0.08), `tx` ($0.15) — XRPL only; and `usdc/mpt/{id}`, `screen/ofac`, `lending/exposure`,
`lending/underwrite` — **both rails at the same face value** (`src/lib/x402Dual.ts`: `PAYMENT-SIGNATURE` header = XRPL rail,
`X-PAYMENT` = Base rail; the 402 body stays the v1 Base challenge, the v2 XRPL challenge is in the header).
Base-only by design: `usdc/score` (its XRPL twin is `/api/x402/score`, at $0.02 vs $0.01 — deliberately not merged),
and `checkout/usdc/{starter,growth,scale}` (human subscription plans that mint a key before settlement).

## mcp.so submission — paste as a new issue on https://github.com/chatmcp/mcpso/issues

Title: `Submit: XRPLHub — XRPL wallet scores, OFAC screening & unsigned transactions (remote)`

```
**Name:** XRPLHub

**Type:** MCP Server (remote, Streamable HTTP)

**Website:** https://www.xrplhub.io

**Repository:** https://github.com/Dcroyalty/XRPLHub.io

**MCP endpoint:** `https://www.xrplhub.io/api/mcp` (no auth)

**Official MCP Registry:** `io.github.Dcroyalty/xrplhub`, version 1.12.0

**Description:** XRP Ledger tools for agents. Free 300–850 wallet scores (XRPLScore), OFAC SDN screening receipts
(process, not ground truth), MPT issuer risk, credential/permissioned-domain lookups, XLS-66 lending exposure, and
UNSIGNED ready-to-sign transactions for 34 XRPL actions (trustlines, escrows, AMM, NFTs, multisig, MPT issuance…).
XRPLHub never signs and never holds keys: the agent signs with its own wallet.

**Tools:** check_xrpl_score, list_xrpl_services, build_xrpl_transaction, screen_address_ofac, check_mpt_risk,
search_mpts, get_issuer_mpts, verify_mpt_registry, verify_attestation, get_account_credentials, get_issuer_credentials,
check_domain_eligibility, get_lending_exposure, get_lending_history, get_underwriting_inputs, get_monitoring_info,
check_service_health, issue_score_credential, submit_grant_application, donate_to_community_fund

**Connection config:**
{
  "mcpServers": {
    "xrplhub": { "type": "http", "url": "https://www.xrplhub.io/api/mcp" }
  }
}
```

## ElizaOS plugin (`plugins/plugin-xrplhub`) — publish to npm

Not published yet. From `plugins/plugin-xrplhub`:

1. `npm login` (an npm account that will own the unscoped name `plugin-xrplhub`; it was unclaimed on 2026-09-25; 2FA on).
2. `npm run verify` (offline typecheck + 30 tests + build + surface check; `prepublishOnly` runs it again).
3. `npm publish` (`publishConfig.access` is already `public`).
4. `git tag plugin-xrplhub-v0.1.0 && git push origin plugin-xrplhub-v0.1.0`.

Do **not** run `elizaos publish` — it opens a registry PR, and that registry no longer accepts third-party plugins.
Agents install it with `npm install plugin-xrplhub` and add it to `character.plugins`.
Optional: `node scripts/live-check.mjs` exercises every action against production (nothing is signed or submitted).

## Open decision recorded here

`build_xrpl_transaction` (MCP) and therefore the ElizaOS build action return the unsigned txjson for **all 34 services with
no payment gate**, while the same builders are behind the paid gate in the storefront (`/api/execute`) and at
`/api/x402/tx` ($0.15 RLUSD). That is the current, advertised behaviour ("Free, no signup"), unchanged by the 2026-09-25
work; it is recorded here because distributing the plugin widens who can use it.
