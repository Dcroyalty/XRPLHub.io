// src/lib/domainGuide.ts — the plain-English guide served at GET /api/domains/guide (text/markdown) and mirrored in docs/PERMISSIONED-DOMAINS.md.
// Written for a compliance or product lead, not an XRPL engineer. Every factual claim here is checked against the ledger or the specs
// (see docs/PERMISSIONED-DOMAINS.md "What was verified").

export const DOMAIN_GUIDE_MD = `# Gate a Permissioned Domain on XRPLScore — a plain-English guide

## What a Permissioned Domain is
A **Permissioned Domain** (XLS-80) is an object on the XRP Ledger that lists the credentials a wallet must hold to be "in" it. Venues built on top of it — for example a permissioned DEX order book — let only members trade or hold. Membership is not a list you maintain: it is *whatever wallets currently hold a credential you accept*. You change who can enter by changing which credentials you accept.

## What gating on XRPLScore tiers means
XRPLHub issues an on-ledger credential (XLS-70) to a wallet that has requested one, from a single issuer account (\`rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f\`). The credential type says how the wallet's XRPLScore (300–850, computed from its public on-chain behaviour) compared to a threshold **at the moment of issuance**:

| Credential type | Means |
|---|---|
| \`io.xrplhub.score.v1.min600\` | score was 600 or more when issued |
| \`io.xrplhub.score.v1.min650\` | 650 or more |
| \`io.xrplhub.score.v1.min700\` | 700 or more |
| \`io.xrplhub.score.v1.min750\` | 750 or more |

A domain that accepts these admits wallets that earned at least that score, with no list for you to maintain. It is **not** KYC, not a sanctions check, not identity verification and not a creditworthiness or compliance determination: the score is an opinion computed from public ledger activity. Whether a wallet should be admitted to your venue is your decision. Layer your own checks (and our screening receipts, if you use them) on top.

## Which tier to pick
Pick the **lowest** score you are willing to admit; the builder adds every higher tier for you.

- Each step up admits a smaller set of wallets. We have not published how many wallets sit in each tier and this guide does not claim to: score any wallet you care about first (GET /api/score/<address>) to see where your expected members land.
- If unsure, start at the lowest tier you would accept; you can update the domain later (\`domainId\`).

Two rules to know:
1. **A wallet holds only its highest tier.** A wallet scoring 780 gets \`min750\` and nothing else. So a domain that lists only \`min650\` would reject it. That is why "650 or better" means listing \`min650\`, \`min700\` **and** \`min750\`. The builder does this; if you hand-write a domain, do the same.
2. **Credentials expire after 90 days.** A wallet whose score has fallen below the tier is not re-issued and leaves the domain at expiry on its own. A wallet whose score has risen can be re-issued at the higher tier.

## How to create the domain
1. \`POST /api/domains/build\` with your domain-owner account and \`minTier\` (optionally \`alsoAccept\`: up to ten credentials in total, so you can also accept another issuer's credential alongside ours; optionally \`domainId\` to update a domain you already own). It returns the plan, free.
2. The unsigned \`PermissionedDomainSet\` transaction is the storefront service \`permdomain\`: pay for it over x402 (USDC on Base or RLUSD on XRPL, same price on both) or in the storefront. XRPLHub never signs and never holds keys — you sign with your own wallet.
3. Creating a domain adds one object to your account: **0.2 XRP** owner reserve plus a fee of a fraction of a cent.
4. Read the new **DomainID** (a 64-character hex string) from the validated transaction's metadata: it is the \`LedgerIndex\` of the created \`PermissionedDomain\` node.

## Be honest with yourself about day one
A domain gated on our credentials has as many members as there are wallets that have **requested and accepted** a credential. Our only credential issued so far went out unsolicited and has not been accepted, so **a domain created today starts empty**. Getting members is the work: send them the steps below.

## What a member wallet must do
1. **Request** — \`POST /api/credentials/request\` with \`{ "subject": "r…" }\`. We compute the wallet's score fresh (never a cached number) and, if it is 600 or more, queue a credential for the tier it earned. Below 600, or an account that is not activated on mainnet, gets none and no ledger object is created.
2. **We issue** — after review by a person, our issuer wallet sends a \`CredentialCreate\`. The credential now exists but is **pending**; a pending credential does not satisfy any domain.
3. **Accept** — the member signs one \`CredentialAccept\` from the **same wallet** (\`GET /api/credentials/request?subject=r…\` returns the unsigned transaction). Accepting moves the 0.2 XRP reserve from us to the member.
4. **Check** — \`GET /api/domains/eligible?address=r…&domain=<DomainID>\` says whether the wallet currently qualifies, and why or why not.

"We issue, they accept": nothing we do can put a wallet in your domain without that wallet choosing to accept.

## Limits
- The credential attests to a score at issuance, not to who controls the wallet.
- Requests are reviewed and issued by a person from an offline key; expect a delay, not an instant.
- Amendments used: Credentials (XLS-70) and PermissionedDomains (XLS-80) — both enabled on mainnet.
`;
