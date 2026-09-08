// src/app/api/mcp/route.ts
// ═══════════════════════════════════════════════════════════════════════════
// XRPLHub MCP Server — the three pillars of XRPLHub as AI-agent tools.
//
// Compatible with:
//   • Claude Desktop   → add to claude_desktop_config.json
//   • Claude Code      → claude mcp add xrplhub --url https://www.xrplhub.io/api/mcp
//   • XRPL AI Starter Kit (Ripple/Anthropic, 2026)
//   • Any MCP-compatible agent framework
//
// Implements MCP Streamable HTTP transport (spec 2024-11-05).
// Stateless — zero new infrastructure, runs on Vercel as a standard serverless fn.
// No new npm packages required.
//
// NINETEEN TOOLS:
//   1. check_xrpl_score        — free 300–850 wallet creditworthiness score
//   2. list_xrpl_services      — the 35 build_xrpl_transaction actions + their params
//   3. build_xrpl_transaction  — ready-to-sign txjson for any of 35 XRPL actions
//   4. issue_score_credential  — paid signed, verifiable score certificate (1 XRP/RLUSD)
//   5. submit_grant_application — apply for a 1–100 RLUSD community micro-grant
//   6. donate_to_community_fund — donate XRP or RLUSD to the XRPLHub treasury
//   7. get_account_credentials — free, live: every XLS-70 credential an account holds
//   8. get_issuer_credentials  — free, census-backed: everything an issuer has issued
//   9. check_domain_eligibility — free, live: does an account satisfy a PermissionedDomain
//  10. check_mpt_risk          — free, live: issuer powers + issuer trust for one MPT issuance
//  11. search_mpts             — free, indexed: find MPT issuances by issuer / id / name
//  12. get_issuer_mpts         — free, indexed: everything one issuer has issued + its score
//  13. verify_mpt_registry     — free: the latest on-ledger Merkle-root anchor of the registry
//  14. check_service_health    — free: is the money path up before you pay
//  15. screen_address_ofac     — free: compare an address to a pinned OFAC SDN snapshot (process, not ground truth)
//  16. verify_attestation      — free: inclusion proof + on-ledger anchor for a screening / lending receipt
//  17. get_lending_exposure    — free: a borrower's total XLS-66 exposure across ALL brokers + observation history
//  18. get_lending_history     — free: every loan XRPLHub has ever observed for a borrower
//  19. get_underwriting_inputs — paid ($0.05 USDC/Base x402): the full underwriting-inputs bundle, facts only
//
// © 2026 XRPLHub.io · XRPLScore™ · All Rights Reserved
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { buildServiceTx } from '@/app/api/execute/txBuilder';
import { SERVICE_CATALOG, SERVICE_IDS, serviceParamLines } from '@/app/api/execute/serviceCatalog';
import { prisma } from '@/lib/xrplscore-db';
import { screenOfac, NoSnapshotError } from '@/lib/screen';
import { isValidXrplAddress } from '@/lib/engine';
import { runExposureQuery, priorObservation } from '@/lib/lendingExposure';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://www.xrplhub.io';

// ─── CORS HEADERS (agents call from anywhere) ────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// ─── SERVER IDENTITY ────────────────────────────────────────────────────────
// Exported so /.well-known/mcp/server-card.json stays in lockstep with the
// JSON-RPC surface (one source of truth for scanners like Smithery).
export const MCP_SERVER_INFO = {
  name: 'xrplhub',
  version: '1.11.0',
  description:
    'Free XRPL wallet creditworthiness scores · ready-to-sign txjson for 35 XRPL actions (incl. MPT ' +
    'issuance with a plain-English flag guide + on-ledger backing declaration) · verifiable score ' +
    'credential · credential + permissioned domain explorer · MPT issuer risk + backing declarations · ' +
    'OFAC SDN screening attestation (process, not ground truth) · XLS-66 cross-broker lending exposure & ' +
    'underwriting inputs (attested, facts only) · community micro-grants · donations',
};

// ─── TOOL DEFINITIONS (descriptions are the marketing copy to the AI) ────────
// The AI reads these descriptions and decides WHEN to call each tool.
// Write them to match the exact questions agents are asked.
export const TOOLS = [
  {
    name: 'issue_score_credential',
    description:
      "Get a signed, tamper-evident certificate of a wallet's XRPLScore that any counterparty can " +
      "verify without trusting the holder — the free score isn't provable to a third party, this is. " +
      'Two calls: first returns a Xaman payment request (1 XRP or 1 RLUSD, valid 90 days); ' +
      'call again with the same wallet_address + returned uuid after signing to get certId and verifyUrl. ' +
      'Params: wallet_address (r..., required), currency (XRP|RLUSD, default XRP), uuid (2nd call only). No signup.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: {
          type: 'string',
          description: 'XRP Ledger wallet address the credential will attest to (starts with r)',
        },
        currency: {
          type: 'string',
          enum: ['XRP', 'RLUSD'],
          description: 'Payment currency. Defaults to XRP.',
        },
        uuid: {
          type: 'string',
          description: 'Only for the second call: the payment uuid returned by the first call, after the user has signed in Xaman.',
        },
      },
      required: ['wallet_address'],
    },
  },
  {
    name: 'check_xrpl_score',
    description:
      'Get a 300–850 creditworthiness score for any XRP Ledger wallet before you pay, lend to, ' +
      'trade with, or onboard it. You get back: the score, a letter grade, peer percentile, a ' +
      'per-signal breakdown (account age, lifetime tx history, financial health, token engagement, ' +
      'DEX activity, AMM participation, security config, NFTs), and ranked tips to raise it. ' +
      'Params: wallet_address (r... classic address, 25–35 chars, required). ' +
      'Free — no API key, no signup, 100% public ledger data.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: {
          type: 'string',
          description: 'XRP Ledger classic address to score (starts with r, 25–35 characters)',
        },
      },
      required: ['wallet_address'],
    },
  },
  {
    name: 'get_account_credentials',
    description:
      'Get every XLS-70 credential an XRPL account holds — issuer, type, whether it has been accepted, ' +
      "whether it's expired, and its expiry date. Live against a validated mainnet ledger (never stale). " +
      'Use this before trusting a counterparty who claims to hold a credential. ' +
      'Default walks the owner directory (bounded ~20s; response has coverage "complete"/"partial" — for an ' +
      'exchange-scale account it can be partial). Pass issuer (and credential_type unless it is XRPLHub\'s ' +
      'issuer) to do a direct ledger lookup instead — always fast and always complete. ' +
      'Params: wallet_address (r..., required), issuer (r..., optional), credential_type (name or hex, optional). Free, no signup.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'XRPL classic address to look up (starts with r)' },
        issuer: { type: 'string', description: 'Optional — restrict to one issuer via a direct ledger lookup (no owner-directory walk)' },
        credential_type: { type: 'string', description: 'Optional — credential type (plain name or hex); required with issuer unless the issuer is XRPLHub\'s' },
      },
      required: ['wallet_address'],
    },
  },
  {
    name: 'get_issuer_credentials',
    description:
      'Get everything an issuer account has issued: every credential type, distinct subject count, and ' +
      'acceptance rate. Served from a network-wide census rebuilt on a schedule — the response includes ' +
      'coverage ("complete" or "partial") so a mid-walk answer is never mistaken for a finished count. ' +
      'Params: issuer_address (r..., required). Free, no signup.',
    inputSchema: {
      type: 'object',
      properties: {
        issuer_address: { type: 'string', description: 'XRPL classic address of the credential issuer (starts with r)' },
      },
      required: ['issuer_address'],
    },
  },
  {
    name: 'check_mpt_risk',
    description:
      "Get the risk view of one XLS-33 Multi-Purpose Token issuance before touching it: what the issuer " +
      "CAN DO to a holder (clawback, freeze, require-auth, whether it's transferable at all) plus the " +
      "issuer's XRPLScore. Free. For the full issuer picture — account age, xrp-ledger.toml-verified " +
      "domain, credentials held, Bithomp cross-check — GET /api/x402/usdc/mpt/{id} pays $0.01 USDC on " +
      "Base via x402. Every response states its source and returns 'unknown', never 'does not exist', " +
      "when an issuance isn't found. Params: issuance_id (48-hex MPTokenIssuanceID, required). No signup.",
    inputSchema: {
      type: 'object',
      properties: {
        issuance_id: { type: 'string', description: 'The MPTokenIssuanceID — 48 hexadecimal characters (XLS-33, 192-bit)' },
      },
      required: ['issuance_id'],
    },
  },
  {
    name: 'search_mpts',
    description:
      'Search the XRPL Multi-Purpose Token (XLS-33) registry index by issuer address, MPTokenIssuanceID ' +
      '(or a hex prefix of one), or token name / ticker. Returns each match with issuer powers ' +
      '(clawback, freeze, require-auth, transferable), supply, holder count and source. Served from the ' +
      "index — the response carries coverage ('complete' or 'partial') and lastCompletedPassAt; treat " +
      "'partial' as a floor, not the whole population. Params: q (required). Free, no signup.",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Issuer address (r...), MPTokenIssuanceID or hex prefix, or token name/ticker' },
      },
      required: ['q'],
    },
  },
  {
    name: 'get_issuer_mpts',
    description:
      'Everything one issuer has put out as Multi-Purpose Tokens (XLS-33), from the registry index, plus ' +
      "the issuer's own XRPLScore. Each issuance lists the issuer's powers over a holder. Response carries " +
      "coverage ('complete-per-known-issuer'/'partial'). Params: issuer_address (r..., required). Free, no signup.",
    inputSchema: {
      type: 'object',
      properties: {
        issuer_address: { type: 'string', description: 'XRPL issuer address (starts with r)' },
      },
      required: ['issuer_address'],
    },
  },
  {
    name: 'check_service_health',
    description:
      'Check whether the XRPLHub money path is working BEFORE you pay: database, Xaman, both x402 ' +
      'facilitators (t54 RLUSD + CDP USDC-on-Base), the on-ledger anchor config, the credential signing ' +
      'secret, and alerting. Returns overall "ok" | "warn" | "down" plus a per-component list. Poll this ' +
      'if a prior paid call failed. No params. Free, no signup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'verify_mpt_registry',
    description:
      'Get the latest on-ledger anchor of the MPT registry (BIS Working Paper 1374 pattern): a Merkle root ' +
      'over the canonicalised index, committed in a Memo on a transaction from a dedicated anchor wallet ' +
      '(not the credential issuer). Returns the root, its tx hash, ledger index, issuance/issuer counts, ' +
      'coverage, and the exact canonicalisation + Merkle scheme so you can reproduce the root from the ' +
      'published /api/mpt/search + /api/mpt/issuer data and check that those rows match the root we anchored ' +
      'on-ledger at a known time (proves published-rows-match-anchored-root, not immutability). No params. Free, no signup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_domain_eligibility',
    description:
      'Check whether an XRPL account holds a credential that satisfies a PermissionedDomain (XLS-80d) — ' +
      'the question every domain operator and every would-be participant actually asks before a real ' +
      'transaction. Live against a validated mainnet ledger. Eligibility is OR: any ONE accepted, unexpired ' +
      "credential matching the domain's AcceptedCredentials is enough. " +
      'Params: wallet_address (r..., required), domain_id (64-hex DomainID, the PermissionedDomain ledger index, required). Free, no signup.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'XRPL classic address to check (starts with r)' },
        domain_id: { type: 'string', description: "The PermissionedDomain's ledger index — 64 hex characters" },
      },
      required: ['wallet_address', 'domain_id'],
    },
  },
  {
    name: 'list_xrpl_services',
    description:
      'List all 35 XRPL actions that build_xrpl_transaction can produce. For each you get: id, ' +
      'plain-English label, category, safety tier, and every parameter (name, type, required, ' +
      'example). Call this FIRST so you pass the right product_id and params in one shot instead ' +
      'of guessing and getting a missing-params error. No parameters. Free, no signup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'build_xrpl_transaction',
    description:
      'Get a ready-to-sign transaction JSON for any of 35 XRPL actions — no XRPL coding. Returns the ' +
      'exact txjson plus a safety tier; the wallet owner signs it in their own wallet (this never ' +
      'signs for anyone). Call list_xrpl_services first for all 35 ids and every parameter with examples. ' +
      'Params: product_id (required — e.g. checkcreate, escrow, trustline, nftmint, dexorder, multisig), ' +
      'wallet_address (r... signer, required), params (object, per-service). Free, no signup.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'string',
          enum: SERVICE_IDS,
          description:
            'Which XRPL action to build. Call list_xrpl_services for the full catalogue with ' +
            'each id\'s label, tier and parameters.',
        },
        wallet_address: {
          type: 'string',
          description: 'XRPL classic address (r...) of the account that will sign the transaction',
        },
        params: {
          type: 'object',
          description:
            'Per-service parameters. Call list_xrpl_services for types + examples for every field. ' +
            'Required fields by id — ' + serviceParamLines(),
        },
      },
      required: ['product_id', 'wallet_address'],
    },
  },
  {
    name: 'submit_grant_application',
    description:
      'Apply for a community micro-grant ($25–$100) paid wallet-to-wallet from the XRPLHub on-chain ' +
      'treasury for rent, utilities, groceries, medical, transport, or childcare. Returns a grant id ' +
      'and status. A person reviews every application and makes every decision — no automated triage, no middleman. ' +
      'Params: wallet_address (r..., required), category (RENT|UTILITIES|GROCERIES|MEDICAL|TRANSPORT|CHILDCARE|OTHER, required), ' +
      'amount (25–100, required), description (2–4 sentences, required). No signup.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: {
          type: 'string',
          description: 'XRPL wallet address where the grant will be sent if approved',
        },
        category: {
          type: 'string',
          description: 'Grant category: RENT, UTILITIES, GROCERIES, MEDICAL, TRANSPORT, CHILDCARE, or OTHER',
        },
        amount: {
          type: 'number',
          description: 'Amount requested in RLUSD (1–100)',
        },
        description: {
          type: 'string',
          description:
            'Clear description of the need, situation, and urgency (2–4 sentences). ' +
            'Be specific — vague applications are harder for the reviewer to verify.',
        },
        currency: {
          type: 'string',
          description: 'Payout currency. Default and recommended: RLUSD',
        },
      },
      required: ['wallet_address', 'category', 'amount', 'description'],
    },
  },
  {
    name: 'donate_to_community_fund',
    description:
      'Donate XRP or RLUSD to the XRPLHub Community Grant Treasury — a transparent on-chain fund that ' +
      'pays approved applicants wallet-to-wallet with zero overhead. Returns the treasury address and, ' +
      'if you pass donor_wallet, a ready-to-sign Payment txjson; every donation and payout is recorded ' +
      'on the XRP Ledger and publicly verifiable. ' +
      'Params: amount (number, required), currency (XRP|RLUSD, default XRP), donor_wallet (r..., optional), ' +
      'message (optional). No signup.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: 'Amount to donate. Minimum 1. Any size welcome — even 1-5 XRP helps fund a real grant.',
        },
        currency: {
          type: 'string',
          description: 'XRP or RLUSD. Default: XRP. Use RLUSD for a stable USD-equivalent donation.',
        },
        donor_wallet: {
          type: 'string',
          description: 'Optional. XRPL wallet address of the donor. Providing this allows building a ready-to-sign Payment transaction.',
        },
        message: {
          type: 'string',
          description: 'Optional. A short dedication or message to attach to the donation record.',
        },
      },
      required: ['amount'],
    },
  },
  {
    name: 'screen_address_ofac',
    description:
      'Compare one XRPL address against a vintage-pinned snapshot of the US Treasury OFAC SDN list ' +
      '(exact address-string match only) and get a factual, Merkle-anchored receipt. ' +
      'ATTESTS TO PROCESS, NOT GROUND TRUTH: the receipt records that the address was compared against a ' +
      'named list snapshot (its OFAC publish date + the SHA-256 of the exact file) at a stated time, and ' +
      'what the comparison found. A "no match" means the address did NOT appear on that list version — it ' +
      'is NOT a statement that the address is clean, safe, or unsanctioned. This is not legal or compliance ' +
      'advice, makes no compliance decision, and does not discharge your own screening obligations. Scope: ' +
      'OFAC SDN only — no EU/UK/UN lists, no name/alias/fuzzy matching, no transaction-graph analysis. ' +
      'Returns queryId (verify it later with verify_attestation), the list {name,vintage,sha256}, ' +
      'result {listed, matches[]}, and a one-sentence factual statement. ' +
      'Params: address (r..., required). Free via MCP. Terms: /legal/screening.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'XRPL classic address (r..., 25–35 chars) to compare against the OFAC SDN list',
        },
      },
      required: ['address'],
    },
  },
  {
    name: 'verify_attestation',
    description:
      "Given a queryId from screen_address_ofac OR get_lending_exposure, return everything needed to verify " +
      'that receipt WITHOUT trusting XRPLHub: the canonical leaf, its Merkle inclusion proof, the on-ledger ' +
      'anchor transaction hash + ledger close time, and the SHA-256 of the source data (the OFAC SDN ' +
      'snapshot, or — for lending — the exact list of Loan ids observed). Rebuild the leaf, fold the proof ' +
      "to the Merkle root, confirm that root is in the anchor tx's MemoData. Before the daily anchor runs " +
      'it shows status "pending" with the leaf hash only. Params: query_id (UUID, required). Free, no signup.',
    inputSchema: {
      type: 'object',
      properties: {
        query_id: { type: 'string', description: 'The queryId (UUID) from screen_address_ofac or get_lending_exposure' },
      },
      required: ['query_id'],
    },
  },
  {
    name: 'get_lending_exposure',
    description:
      "A borrower's TOTAL XLS-66 lending exposure across ALL loan brokers in one call — the XRP Ledger has " +
      "no aggregate borrower-debt object, so a broker carrying first-loss capital cannot see a borrower's " +
      "total leverage elsewhere. Returns: outstanding by asset, loan count, distinct broker count, defaults " +
      "/ impairments / overdue, XRPLHub's XRPLScore, and an observation history summary. " +
      "IMPORTANT: XLS-66 keeps CURRENT exposure only. A defaulted loan zeroes its own amounts (the flag is " +
      "the credit event, not the balance), and either the borrower or the broker can delete a paid or " +
      "defaulted loan to reclaim the borrower's reserve — a borrower can erase evidence of their own " +
      "default. Every call here persists an immutable Merkle-anchored snapshot. `disposition` = " +
      "'no-loans-ever' means we have never observed a loan (NOT proof of none); 'history-only' means loans " +
      "were seen before but none are on the ledger now. XLS-66 is not yet enabled on mainnet — until it is, " +
      "this returns amendment-not-active with the live XRPLScore. Not underwriting or credit advice. " +
      "Params: borrower (r..., required). Free via MCP.",
    inputSchema: {
      type: 'object',
      properties: {
        borrower: { type: 'string', description: 'XRPL classic address (r..., 25–35 chars) of the borrower' },
      },
      required: ['borrower'],
    },
  },
  {
    name: 'get_underwriting_inputs',
    description:
      "The full underwriting-inputs bundle a LoanBroker needs for an XLS-66 decision, in one call: " +
      "cross-broker exposure, XRPLScore + grade, OFAC SDN screening (with its own verifiable receipt), " +
      "observation history + gaps, and one Merkle-anchored attestation over the whole bundle. " +
      "FACTS ONLY — it never returns a recommended principal, rate, approve/decline, or probability of " +
      "default; the broker decides. This is a PAID x402 call: $0.05 USDC on Base at " +
      "GET /api/x402/lending/underwrite?borrower=r... (no free tier, no API key). For the free components " +
      "use get_lending_exposure and screen_address_ofac. This tool returns the payment resource details. " +
      "Params: borrower (r..., required).",
    inputSchema: {
      type: 'object',
      properties: { borrower: { type: 'string', description: 'XRPL classic address (r...) of the borrower' } },
      required: ['borrower'],
    },
  },
  {
    name: 'get_lending_history',
    description:
      "Every loan XRPLHub has EVER observed for a borrower, built from append-only exposure snapshots — the " +
      "credit file the XRP Ledger can't keep. Per loan: first/last observed ledger, last-known status, " +
      "monotonic everDefaulted / everImpaired / everOverdue flags, and for loans since deleted from the " +
      "ledger, the ledger window in which they vanished. A borrower who defaulted and then deleted the loan " +
      "shows nothing on-ledger; here it shows as vanished with everDefaulted true. `observationWindow` says " +
      "how far back our view goes — loans deleted before we first saw this borrower are invisible to us. " +
      "Params: borrower (r..., required). Free, no signup.",
    inputSchema: {
      type: 'object',
      properties: {
        borrower: { type: 'string', description: 'XRPL classic address (r...) of the borrower' },
      },
      required: ['borrower'],
    },
  },
];

// ─── TOOL IMPLEMENTATIONS ─────────────────────────────────────────────────────

async function toolCheckXrplScore(
  args: Record<string, unknown>
): Promise<string> {
  const wallet = String(args.wallet_address || '').trim();
  if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL wallet address. Must start with r and be 25–35 characters.' });
  }
  try {
    const res = await fetch(
      `${API_URL}/api/score/${encodeURIComponent(wallet)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return JSON.stringify({ error: (err as { error?: string }).error || `Score lookup failed (HTTP ${res.status})` });
    }
    const d = await res.json();
    return JSON.stringify({
      wallet,
      xrplScore:      d.ledgerScore,
      grade:          d.grade,
      percentile:     d.percentile,
      percentileLabel: d.percentileLabel,
      breakdown: (d.breakdown || []).map((b: { label: string; score: number; weight: string; desc: string }) => ({
        signal:      b.label,
        score:       b.score,
        weight:      b.weight,
        description: b.desc,
      })),
      topRecommendations: (d.recommendations || []).slice(0, 3).map(
        (r: { action: string; points: string; priority: string }) => ({
          action:   r.action,
          impact:   r.points,
          priority: r.priority,
        })
      ),
      details: {
        accountAgeDays:   d.details?.accountAgeDays,
        transactionCount: d.details?.txCount,
        balanceXRP:       d.details?.balanceXRP,
        trustLines:       d.details?.trustLineCount,
        hasMultiSig:      d.details?.hasMultiSig,
        spendableXRP:     d.details?.spendableXRP,
      },
      methodology: d.methodology,
      disclaimer:  d.disclaimer,
      dataCompleteness: d.dataCompleteness,
      scannedAt:   d.scannedAt,
      poweredBy:   'XRPLHub.io — XRPLScore™ © 2026',
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Score fetch failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolGetAccountCredentials(args: Record<string, unknown>): Promise<string> {
  const wallet = String(args.wallet_address || '').trim();
  const issuer = String(args.issuer || '').trim();
  const credType = String(args.credential_type || '').trim();
  if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL wallet address. Must start with r and be 25–35 characters.' });
  }
  try {
    const qs = new URLSearchParams({ address: wallet });
    if (issuer) qs.set('issuer', issuer);
    if (credType) qs.set('type', credType);
    const res = await fetch(
      `${API_URL}/api/credentials/account?${qs.toString()}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Lookup failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Credential lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolGetIssuerCredentials(args: Record<string, unknown>): Promise<string> {
  const issuer = String(args.issuer_address || '').trim();
  if (!issuer.startsWith('r') || issuer.length < 25 || issuer.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL issuer address. Must start with r and be 25–35 characters.' });
  }
  try {
    const res = await fetch(
      `${API_URL}/api/credentials/issuer?address=${encodeURIComponent(issuer)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Lookup failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Issuer lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolCheckMptRisk(args: Record<string, unknown>): Promise<string> {
  const id = String(args.issuance_id || '').trim();
  if (!/^[0-9A-Fa-f]{48}$/.test(id)) {
    return JSON.stringify({ error: 'Invalid issuance_id — must be the 48-hex-character MPTokenIssuanceID (XLS-33).' });
  }
  try {
    const res = await fetch(`${API_URL}/api/mpt/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Lookup failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `MPT risk lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolSearchMpts(args: Record<string, unknown>): Promise<string> {
  const q = String(args.q || '').trim();
  if (q.length < 2) return JSON.stringify({ error: 'Provide q — an issuer address, an MPTokenIssuanceID or hex prefix, or a token name.' });
  try {
    const res = await fetch(`${API_URL}/api/mpt/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Search failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `MPT search failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolGetIssuerMpts(args: Record<string, unknown>): Promise<string> {
  const issuer = String(args.issuer_address || '').trim();
  if (!issuer.startsWith('r') || issuer.length < 25 || issuer.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL issuer address. Must start with r and be 25–35 characters.' });
  }
  try {
    const res = await fetch(`${API_URL}/api/mpt/issuer?address=${encodeURIComponent(issuer)}`, { signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Lookup failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Issuer MPT lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolCheckServiceHealth(): Promise<string> {
  try {
    const res = await fetch(`${API_URL}/api/health?deep=1`, { signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ overall: "down", error: `health check unreachable: ${e instanceof Error ? e.message : "unknown"}` });
  }
}

async function toolVerifyMptRegistry(): Promise<string> {
  try {
    const res = await fetch(`${API_URL}/api/mpt/anchor`, { signal: AbortSignal.timeout(15000) });
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Lookup failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Anchor lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolScreenAddressOfac(args: Record<string, unknown>): Promise<string> {
  const address = String(args.address || '').trim();
  if (!isValidXrplAddress(address)) {
    return JSON.stringify({ error: 'Invalid XRPL address. Must start with r and be 25–35 characters.' });
  }
  try {
    const out = await screenOfac(prisma, address, 'mcp');
    return JSON.stringify(
      {
        attestation: {
          queryId: out.queryId,
          canonVersion: 'ofac-screen-v1',
          engineVersion: out.leaf.engineVersion,
          leafHash: out.leafHash,
          verify: `${API_URL}/api/attest/verify?queryId=${out.queryId}`,
        },
        subject: out.leaf.subjectAddress,
        screenedAt: out.leaf.screenedAt,
        method: 'exact-match',
        ledgerIndex: out.leaf.ledgerIndex,
        lists: out.leaf.lists,
        result: out.leaf.result,
        statement: out.statement,
        attestsProcessNotGroundTruth:
          'A "no match" means the address did not appear on the named OFAC SDN snapshot — NOT that it is clean, safe, or unsanctioned. Not legal/compliance advice; does not discharge your screening obligations.',
        terms: `${API_URL}/legal/screening`,
      },
      null,
      2
    );
  } catch (e) {
    if (e instanceof NoSnapshotError) return JSON.stringify({ error: e.message });
    return JSON.stringify({ error: `Screen failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolVerifyAttestation(args: Record<string, unknown>): Promise<string> {
  const queryId = String(args.query_id || '').trim();
  if (!queryId) return JSON.stringify({ error: 'query_id is required (the UUID from screen_address_ofac or get_lending_exposure).' });
  try {
    const res = await fetch(`${API_URL}/api/attest/verify?queryId=${encodeURIComponent(queryId)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Verify failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Verify lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolGetLendingExposure(args: Record<string, unknown>): Promise<string> {
  const borrower = String(args.borrower || '').trim();
  if (!borrower.startsWith('r') || borrower.length < 25 || borrower.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL address. Must start with r and be 25–35 characters.' });
  }
  try {
    // Called directly (MCP has no API key) — persists a snapshot like the HTTP route.
    const out = await runExposureQuery(prisma, borrower, 'mcp');
    if (!out.amendmentActive) {
      return JSON.stringify(
        {
          status: 'amendment-not-active',
          amendment: 'LendingProtocol (XLS-66)',
          message: 'XLS-66 is not yet enabled on XRPL mainnet. This serves automatically on activation. The XRPLScore below is live.',
          borrower: out.borrower,
          xrplScore: out.xrplScore,
          grade: out.grade,
          observation: out.observation,
          disclaimer: out.disclaimer,
        },
        null,
        2
      );
    }
    return JSON.stringify(
      {
        borrower: out.borrower,
        ledgerIndex: out.ledgerIndex,
        asOf: out.generatedAt,
        disposition: out.disposition,
        exposure: out.exposure,
        events: out.events,
        worstStatus: out.worstStatus,
        earliestNextPaymentDue: out.earliestNextPaymentDue,
        xrplScore: out.xrplScore,
        grade: out.grade,
        observation: out.observation,
        loans: out.loans,
        brokers: out.brokers,
        vanishedLoans: out.vanishedLoans,
        attestation: { queryId: out.queryId, leafHash: out.leafHash, verify: `${API_URL}/api/attest/verify?queryId=${out.queryId}` },
        disclaimer: out.disclaimer,
      },
      null,
      2
    );
  } catch (e) {
    return JSON.stringify({ error: `Lending exposure query failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolGetUnderwritingInputs(args: Record<string, unknown>): Promise<string> {
  const borrower = String(args.borrower || '').trim();
  if (!borrower.startsWith('r') || borrower.length < 25 || borrower.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL address. Must start with r and be 25–35 characters.' });
  }
  // Paid x402 call — no free tier. Return the payment resource so an agent with a
  // wallet can pay for it, and point at the free components.
  return JSON.stringify(
    {
      paid: true,
      resource: `${API_URL}/api/x402/lending/underwrite?borrower=${encodeURIComponent(borrower)}`,
      price: '0.05 USDC on Base (x402)',
      returns:
        'cross-broker exposure + XRPLScore + OFAC SDN screening (with receipt) + observation history/gaps + one attestation over the whole bundle',
      factsOnly:
        'No recommended principal, rate, approve/decline, or probability of default. The lending decision is entirely the broker’s.',
      freeComponents: {
        exposure: 'MCP tool get_lending_exposure',
        screening: 'MCP tool screen_address_ofac',
        history: 'MCP tool get_lending_history',
      },
      amendmentGated: 'XLS-66 not yet enabled — the paid call returns 503 (with the live XRPLScore + OFAC result) until it is.',
      discovery: `${API_URL}/.well-known/x402`,
    },
    null,
    2
  );
}

async function toolGetLendingHistory(args: Record<string, unknown>): Promise<string> {
  const borrower = String(args.borrower || '').trim();
  if (!borrower.startsWith('r') || borrower.length < 25 || borrower.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL address. Must start with r and be 25–35 characters.' });
  }
  try {
    const res = await fetch(`${API_URL}/api/lending/history?borrower=${encodeURIComponent(borrower)}`, {
      // MCP proxy — /api/lending/history needs a key; MCP calls it with no key,
      // so fall back to the observation summary from the lib directly on 401.
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return JSON.stringify(await res.json(), null, 2);
    const bundle = await priorObservation(prisma, borrower);
    return JSON.stringify({ borrower, summary: bundle.summary, vanished: bundle.vanished }, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Lending history lookup failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolCheckDomainEligibility(args: Record<string, unknown>): Promise<string> {
  const wallet = String(args.wallet_address || '').trim();
  const domainId = String(args.domain_id || '').trim();
  if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL wallet address. Must start with r and be 25–35 characters.' });
  }
  if (!/^[0-9A-Fa-f]{64}$/.test(domainId)) {
    return JSON.stringify({ error: 'Invalid domain_id — must be the 64-hex-character PermissionedDomain ledger index.' });
  }
  try {
    const res = await fetch(
      `${API_URL}/api/domains/eligible?address=${encodeURIComponent(wallet)}&domain=${encodeURIComponent(domainId)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
    const d = await res.json();
    if (!res.ok) return JSON.stringify({ error: d.message || `Eligibility check failed (HTTP ${res.status})` });
    return JSON.stringify(d, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Eligibility check failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

function toolListXrplServices(): string {
  return JSON.stringify({
    count: SERVICE_CATALOG.length,
    note: 'Pass one of these `id` values as product_id to build_xrpl_transaction, ' +
          'plus a params object with the listed fields. This tool builds txjson only — ' +
          'the wallet owner signs it. Free, no signup.',
    services: SERVICE_CATALOG.map((s) => ({
      id: s.id,
      label: s.label,
      category: s.category,
      safetyTier: s.tier,
      gives: s.gives,
      params: s.params.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.desc,
        example: p.example,
      })),
    })),
    poweredBy: 'XRPLHub.io — 35 Done-For-You XRPL Services © 2026',
  }, null, 2);
}

async function toolBuildXrplTransaction(
  args: Record<string, unknown>
): Promise<string> {
  const productId = String(args.product_id || '').trim();
  const wallet    = String(args.wallet_address || '').trim();
  const params    = (args.params as Record<string, string | number | boolean | undefined>) || {};

  if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL wallet address.' });
  }
  if (!productId) {
    return JSON.stringify({ error: 'product_id is required. See tool description for valid options.' });
  }

  try {
    const result = buildServiceTx(productId, wallet, params);
    if (!result.ok) {
      return JSON.stringify({
        error:        result.error || 'Transaction build failed',
        missingParams: result.needsParams || [],
        hint: result.needsParams?.length
          ? `Provide these params and try again: ${result.needsParams.join(', ')}`
          : 'Check the product_id is valid and try again.',
      });
    }
    if (result.tier === 'blocked') {
      return JSON.stringify({
        error: result.error,
        safetyTier: 'blocked',
        reason: 'This operation is disabled for safety — it can permanently lock account access.',
      });
    }
    return JSON.stringify({
      success:     true,
      product:     productId,
      label:       result.label,
      safetyTier:  result.tier,
      transaction: result.txjson,
      signingInstructions:
        'Present this transaction object to the wallet holder. They must sign it ' +
        'using their Xaman wallet — the transaction cannot be submitted without ' +
        'their cryptographic signature. Never sign on behalf of a user.',
      poweredBy: 'XRPLHub.io — 35 Done-For-You XRPL Services © 2026',
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Build failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolSubmitGrantApplication(
  args: Record<string, unknown>
): Promise<string> {
  const wallet   = String(args.wallet_address || '').trim();
  const category = String(args.category      || '').trim().toUpperCase();
  const amount   = Number(args.amount        || 0);
  const desc     = String(args.description   || '').trim();
  const currency = String(args.currency      || 'RLUSD').trim();

  const VALID_CATS = ['RENT','UTILITIES','GROCERIES','MEDICAL','TRANSPORT','CHILDCARE','OTHER'];

  if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
    return JSON.stringify({ error: 'Invalid XRPL wallet address.' });
  }
  if (!VALID_CATS.includes(category)) {
    return JSON.stringify({ error: `Invalid category. Must be one of: ${VALID_CATS.join(', ')}` });
  }
  if (amount <= 0 || amount > 100) {
    return JSON.stringify({ error: 'Amount must be between 1 and 100 RLUSD.' });
  }
  if (!desc || desc.length < 20) {
    return JSON.stringify({ error: 'Description too short. Provide at least 20 characters explaining the need.' });
  }

  try {
    const res = await fetch(`${API_URL}/api/grants/submit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        wallet,
        category,
        amount,
        currency,
        need: desc,
        name: 'Application via XRPLHub MCP',
      }),
      signal: AbortSignal.timeout(12_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data as { error?: string }).error) {
      return JSON.stringify({ error: (data as { error?: string }).error || 'Submission failed' });
    }

    return JSON.stringify({
      success:         true,
      grantId:         (data as { id?: string }).id,
      status:          (data as { status?: string }).status,
      walletAddress:   wallet,
      amountRequested: `${amount} ${currency}`,
      category,
      nextSteps:
        'Application submitted. A person reviews every application and makes every decision — allow 24–48 hours. ' +
        'If approved, funds are sent directly to the wallet address — no further action required from the applicant.',
      poweredBy: 'XRPLHub.io Community Grants — wallet-to-wallet, no middleman © 2026',
    }, null, 2);
  } catch (e) {
    return JSON.stringify({ error: `Grant submission failed: ${e instanceof Error ? e.message : 'unknown'}` });
  }
}

async function toolDonateToFund(
  args: Record<string, unknown>
): Promise<string> {
  const amount      = Number(args.amount || 0);
  const currency    = String(args.currency || 'XRP').trim().toUpperCase();
  const donorWallet = String(args.donor_wallet || '').trim();
  const message     = String(args.message || '').trim();

  const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
  const RLUSD_HEX = '524C555344000000000000000000000000000000';
  const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

  if (amount <= 0) {
    return JSON.stringify({ error: 'Donation amount must be greater than 0.' });
  }
  if (!['XRP', 'RLUSD'].includes(currency)) {
    return JSON.stringify({ error: 'Currency must be XRP or RLUSD.' });
  }

  // Build the donation record in our system
  let donationRecord = null;
  try {
    const res = await fetch(`${API_URL}/api/donate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromAddress: donorWallet || 'AI-initiated',
        amount,
        currency,
        txHash:  `pending-${Date.now()}`,
        message: message || 'AI agent donation to XRPLHub Community Grants',
      }),
      signal: AbortSignal.timeout(8_000),
    });
    donationRecord = await res.json().catch(() => null);
  } catch { /* non-blocking — return payment info regardless */ }

  // Build the payment transaction if donor wallet is provided
  let transaction = null;
  if (donorWallet && donorWallet.startsWith('r') && donorWallet.length >= 25) {
    if (currency === 'XRP') {
      transaction = {
        TransactionType: 'Payment',
        Account:     donorWallet,
        Destination: TREASURY,
        Amount:      String(Math.round(amount * 1_000_000)), // drops
        Memos: message ? [{
          Memo: {
            MemoData: Buffer.from(message, 'utf8').toString('hex').toUpperCase(),
            MemoType: Buffer.from('text/plain', 'utf8').toString('hex').toUpperCase(),
          }
        }] : undefined,
      };
    } else {
      // RLUSD
      transaction = {
        TransactionType: 'Payment',
        Account:     donorWallet,
        Destination: TREASURY,
        Amount: {
          currency: RLUSD_HEX,
          issuer:   RLUSD_ISSUER,
          value:    String(amount),
        },
        Memos: message ? [{
          Memo: {
            MemoData: Buffer.from(message, 'utf8').toString('hex').toUpperCase(),
            MemoType: Buffer.from('text/plain', 'utf8').toString('hex').toUpperCase(),
          }
        }] : undefined,
      };
    }
  }

  return JSON.stringify({
    success: true,
    impact: `Your ${amount} ${currency} donation funds direct wallet-to-wallet grants to people in genuine need — rent, food, medical bills, utilities. No middleman. Every cent tracked on-chain.`,
    treasuryAddress: TREASURY,
    treasuryName:    'XRPLHub Community Grants Treasury (xrplhub.xrp)',
    donationAmount:  `${amount} ${currency}`,
    message:         message || null,
    transaction:     transaction || null,
    signingNote:     transaction
      ? 'Sign this transaction in Xaman to complete your donation. The funds go directly to the community treasury on-chain.'
      : 'To donate, send ${amount} ${currency} directly to ' + TREASURY + ' from any XRPL wallet or Xaman.',
    onChainVerification: `Every donation and every payout is publicly verifiable at https://xrpscan.com/account/${TREASURY}`,
    donationRecord:  donationRecord?.id ? { id: donationRecord.id } : null,
    poweredBy: 'XRPLHub.io Community Grants — wallet-to-wallet, no middleman © 2026',
  }, null, 2);
}

// ─── TOOL: issue_score_credential ─────────────────────────────────────────────
async function handleIssueScoreCredential(args: Record<string, unknown>): Promise<string> {
  const wallet = String(args.wallet_address || '').trim();
  const currency = args.currency === 'RLUSD' ? 'RLUSD' : 'XRP';
  const uuid = String(args.uuid || '').trim();

  if (!wallet.startsWith('r') || wallet.length < 25) {
    return JSON.stringify({ error: 'A valid XRPL wallet address (starting with r) is required.' }, null, 2);
  }

  // Second call: payment signed, claim the credential.
  if (uuid) {
    try {
      const res = await fetch(`${API_URL}/api/credential?claim=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: wallet, uuid, currency }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return JSON.stringify({
          success: false,
          status: data.status || 'unverified',
          message: data.error || 'Payment not confirmed yet. Sign the request in Xaman, then retry with the same uuid.',
        }, null, 2);
      }
      return JSON.stringify({
        success: true,
        credentialIssued: true,
        certId: data.certId,
        wallet: data.wallet,
        score: data.score,
        grade: data.grade,
        validUntil: data.expiresAt,
        verifyUrl: data.verifyUrl,
        howToUse: 'Share the verifyUrl with any counterparty. They can confirm the score is authentic and unaltered without trusting you or contacting XRPLHub.',
        poweredBy: 'XRPLHub.io — XRPLScore Verified Credential © 2026',
      }, null, 2);
    } catch {
      return JSON.stringify({ error: 'Credential service unreachable. Try again shortly.' }, null, 2);
    }
  }

  // First call: create the payment request.
  try {
    const res = await fetch(`${API_URL}/api/credential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: wallet, currency }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.uuid) {
      return JSON.stringify({ error: data.error || 'Could not start credential purchase.' }, null, 2);
    }
    return JSON.stringify({
      step: 'payment_required',
      whatThisBuys: 'A signed, tamper-evident credential attesting to this wallet\'s XRPLScore, with a public URL any third party can verify. Valid 90 days.',
      price: data.price,
      wallet,
      paymentUuid: data.uuid,
      signInXaman: data.deep_link,
      qrCode: data.qr_png,
      expiresInSeconds: data.expires_in,
      nextStep: `Have the user sign the payment in Xaman, then call issue_score_credential again with the SAME wallet_address plus uuid="${data.uuid}" to receive the credential.`,
      poweredBy: 'XRPLHub.io © 2026',
    }, null, 2);
  } catch {
    return JSON.stringify({ error: 'Credential service unreachable. Try again shortly.' }, null, 2);
  }
}

// ─── JSON-RPC DISPATCHER ──────────────────────────────────────────────────────
function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
    { headers: CORS }
  );
}
function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json(
    { jsonrpc: '2.0', id, result },
    { headers: CORS }
  );
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS });
}

// GET — human-readable server info and Claude Desktop integration instructions
export async function GET() {
  return NextResponse.json(
    {
      name:        'XRPLHub MCP Server',
      version:     MCP_SERVER_INFO.version,
      description: 'XRPLHub as AI-agent tools: free 300–850 wallet creditworthiness scores, ' +
                   'ready-to-sign txjson for 35 XRPL actions, a paid verifiable score credential, ' +
                   'community micro-grants, and charitable donations. No signup; paid actions settle in XRP or RLUSD.',
      serverCard:  '/.well-known/mcp/server-card.json',
      tools: TOOLS.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  Object.keys((t.inputSchema?.properties as Record<string, unknown>) ?? {}),
      })),
      quickstart: {
        claudeDesktop: {
          step: 'Add to your Claude Desktop config file',
          configFile: {
            mac:     '~/.config/claude/claude_desktop_config.json',
            windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
          },
          add: {
            mcpServers: {
              xrplhub: { url: 'https://www.xrplhub.io/api/mcp' },
            },
          },
        },
        claudeCode:  'claude mcp add xrplhub --url https://www.xrplhub.io/api/mcp',
        xrplStarter: 'Compatible with the XRPL AI Starter Kit (Ripple/Anthropic, 2026)',
        directAPI:   'POST https://www.xrplhub.io/api/mcp — JSON-RPC 2.0',
      },
      links: {
        site:        'https://www.xrplhub.io',
        github:      'https://github.com/Dcroyalty/XRPLHub.io',
        crunchbase:  'https://www.crunchbase.com/organization/xrplhub-io',
        methodology: 'XRPLScore™ methodology whitepaper available at partners@xrplhub.io',
      },
      copyright: '© 2026 XRPLHub.io · XRPLScore™ · All Rights Reserved',
    },
    { headers: CORS }
  );
}

// POST — MCP JSON-RPC 2.0 endpoint
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error — request body must be valid JSON');
  }

  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return rpcError(body?.id, -32600, 'Invalid Request — must be JSON-RPC 2.0');
  }

  const { id, method, params } = body as {
    id:     unknown;
    method: string;
    params: Record<string, unknown>;
  };

  // ── INITIALIZE ────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities:    { tools: {} },
      serverInfo:      MCP_SERVER_INFO,
    });
  }

  // ── TOOLS/LIST ────────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  // ── TOOLS/CALL ────────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName = String((params as { name?: string })?.name || '');
    const toolArgs = ((params as { arguments?: Record<string, unknown> })?.arguments) || {};
    let output: string;

    try {
      if (toolName === 'check_xrpl_score') {
        output = await toolCheckXrplScore(toolArgs);
      } else if (toolName === 'list_xrpl_services') {
        output = toolListXrplServices();
      } else if (toolName === 'build_xrpl_transaction') {
        output = await toolBuildXrplTransaction(toolArgs);
      } else if (toolName === 'submit_grant_application') {
        output = await toolSubmitGrantApplication(toolArgs);
      } else if (toolName === 'donate_to_community_fund') {
        output = await toolDonateToFund(toolArgs);
      } else if (toolName === 'issue_score_credential') {
        output = await handleIssueScoreCredential(toolArgs);
      } else if (toolName === 'get_account_credentials') {
        output = await toolGetAccountCredentials(toolArgs);
      } else if (toolName === 'get_issuer_credentials') {
        output = await toolGetIssuerCredentials(toolArgs);
      } else if (toolName === 'check_domain_eligibility') {
        output = await toolCheckDomainEligibility(toolArgs);
      } else if (toolName === 'check_mpt_risk') {
        output = await toolCheckMptRisk(toolArgs);
      } else if (toolName === 'search_mpts') {
        output = await toolSearchMpts(toolArgs);
      } else if (toolName === 'get_issuer_mpts') {
        output = await toolGetIssuerMpts(toolArgs);
      } else if (toolName === 'verify_mpt_registry') {
        output = await toolVerifyMptRegistry();
      } else if (toolName === 'check_service_health') {
        output = await toolCheckServiceHealth();
      } else if (toolName === 'screen_address_ofac') {
        output = await toolScreenAddressOfac(toolArgs);
      } else if (toolName === 'verify_attestation') {
        output = await toolVerifyAttestation(toolArgs);
      } else if (toolName === 'get_lending_exposure') {
        output = await toolGetLendingExposure(toolArgs);
      } else if (toolName === 'get_lending_history') {
        output = await toolGetLendingHistory(toolArgs);
      } else if (toolName === 'get_underwriting_inputs') {
        output = await toolGetUnderwritingInputs(toolArgs);
      } else {
        return rpcError(id, -32601, `Tool not found: ${toolName}`);
      }
    } catch (e) {
      output = JSON.stringify({
        error: `Tool execution error: ${e instanceof Error ? e.message : 'unknown'}`,
      });
    }

    return rpcResult(id, {
      content: [{ type: 'text', text: output }],
    });
  }

  // ── NOTIFICATIONS (no response) ───────────────────────────────────────────
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return new NextResponse(null, { status: 204, headers: CORS });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
