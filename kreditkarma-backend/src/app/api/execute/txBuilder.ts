// src/app/api/execute/txBuilder.ts
// The transactions XRPLHub still builds — ONLY the ones its own products depend on (owner decision 2026-10-07: the
// generic transaction catalog was removed; we keep only products nobody else offers):
//   mptissue          — MPTokenIssuanceCreate with a recorded backing declaration; feeds the io.xrplhub.mpt.v1.declared
//                       credential and the MPT issuer-risk registry (/api/execute/verify).
//   permdomain        — PermissionedDomainSet for a domain gated on XRPLScore credentials (/api/domains/build).
//   adminhealthcheck  — admin-only TicketCreate x1 that proves the real paid path (scripts/test-paid-path.mjs).
// Spend Controls builds its checks in src/lib/checks.ts; credentials build CredentialCreate/Accept in their own routes.
//
// SAFETY TIERS:
//   'safe'      → additive or reversible; auto-builds, no special warning
//   'caution'   → can misconfigure account access; sellable but UI must show a hard warning gate
//   'blocked'   → irreversible account-killers; never auto-built (returns error)
//
// Every builder returns a txjson object for the customer's own wallet.
// Params come from the customer (validated here). Never trust raw input.

import { buildMptFlagsValue, flagSelectionFromParams } from '@/lib/mptFlags';
import { normalizeBacking, validateBacking, type BackingDeclaration } from '@/lib/mptBacking';
import { buildMptMetadata } from '@/lib/mptMeta';
import { parseMptLocks, type BuildContext } from '@/lib/mptPermanence';

export type { SafetyTier, BuildResult, BuildStep } from './buildKit';
import {
  BAD, BLOCKED, CAUTION, NEED, SAFE, isAddr, str, xrpToDrops,
  type Builder, type BuildResult, type BuildStep, type Params,
} from './buildKit';
import { planScoreDomain } from '@/lib/domainKit';

// ── Per-product builders ──────────────────────────────────────────────
// account = the customer's own wallet (the signer). A builder may be async (it can read the ledger).
const builders: Record<string, Builder> = {
  // ── MPT issuance with a recorded backing declaration (credentials + MPT issuer risk) ──
  mptissue: (account, p, ctx) => {
    // Full MPTokenIssuanceCreate builder. Choices here are hard or impossible to
    // undo (which ones depends on the live DynamicMPT amendment state — see
    // src/lib/mptPermanence.ts) so this is `caution` tier — the execute route
    // forces a confirmation manifest before signing. See src/lib/mptFlags.ts,
    // src/lib/mptBacking.ts, src/lib/mptMeta.ts.
    const name = str(p.name);
    const ticker = str(p.ticker);
    const max = str(p.maximumAmount);
    if (!name || !ticker || !max) return NEED(['name', 'ticker', 'maximumAmount']);
    if (name.length > 64) return BAD('name must be 64 characters or fewer');
    if (ticker.length > 6 || !/^[A-Za-z0-9]+$/.test(ticker)) return BAD('ticker must be 1–6 letters or digits');

    let maxBig: bigint;
    try {
      maxBig = BigInt(max);
    } catch {
      return BAD('maximum supply must be a whole number');
    }
    const MAX_MPT_SUPPLY = BigInt('9223372036854775807'); // 0x7FFF_FFFF_FFFF_FFFF
    if (maxBig <= BigInt(0) || maxBig > MAX_MPT_SUPPLY) return BAD('maximum supply must be between 1 and 9223372036854775807');

    const scale = Number(p.assetScale ?? 0);
    if (!Number.isInteger(scale) || scale < 0 || scale > 19) return BAD('decimal places (assetScale) must be a whole number 0–19');

    const sel = flagSelectionFromParams(p as Record<string, unknown>);
    const flags = buildMptFlagsValue(sel);

    // TransferFee is only valid with tfMPTCanTransfer (else temMALFORMED on-ledger).
    let transferFee: number | undefined;
    if (p.transferFee !== undefined && p.transferFee !== '' && Number(p.transferFee) > 0) {
      if (!sel.canTransfer) return BAD('a transfer fee requires "holders can transfer" to be enabled');
      const pct = Number(p.transferFee);
      if (!Number.isFinite(pct) || pct < 0 || pct > 50) return BAD('transfer fee must be between 0% and 50%');
      transferFee = Math.round(pct * 1000); // percent -> tenths of a basis point
    }

    const backing = normalizeBacking({
      backingType: str(p.backingType) as BackingDeclaration['backingType'],
      backingStatement: str(p.backingStatement) ?? '',
      verifiedBy: str(p.verifiedBy),
      redeemable: str(p.redeemable) as BackingDeclaration['redeemable'],
    });
    const bErr = validateBacking(backing);
    if (bErr) return BAD(bErr);

    const weblink = str(p.metadataUrl) || undefined;
    if (weblink && !/^https?:\/\/.+/i.test(weblink)) return BAD('metadata URL must start with http:// or https://');

    const md = buildMptMetadata({ name, ticker: ticker.toUpperCase(), weblink, backing });
    if (md.bytes > 1024) return BAD('metadata is too large (>1024 bytes) — shorten the name or the backing statement');

    const txjson: Record<string, unknown> = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: account,
      MaximumAmount: maxBig.toString(),
      AssetScale: scale,
      Flags: flags,
      MPTokenMetadata: md.hex,
    };
    if (transferFee !== undefined) txjson.TransferFee = transferFee;

    // ImmutableFlags (XLS-94 locks). Only ever added when DynamicMPT is confirmed
    // ACTIVE in ctx — otherwise the ledger rejects the field (temDISABLED) after
    // the customer has paid — and never as 0 (temINVALID_FLAG).
    const locks = parseMptLocks(p as Record<string, unknown>, ctx);
    if (!locks.ok) return BAD(locks.error);
    if (locks.value) txjson.ImmutableFlags = locks.value;

    return CAUTION(txjson, 'Multi-Purpose Token Issuance');
  },

  // ── ADMIN-ONLY (see servicePrices.ts's ADMIN_ONLY_SERVICE_IDS; never public) ──
  adminhealthcheck: (account) => SAFE({ TransactionType: 'TicketCreate', Account: account, TicketCount: 1 }, 'Admin health-check (TicketCreate x1)'),

  // ── XRPLScore-gated Permissioned Domain (credentials) ──
  permdomain: (account, p) => {
    // minTier (min600|min650|min700|min750) accepts that tier AND every tier above it (a wallet holds only its highest
    // tier — listing one tier silently rejects better wallets). Optional alsoAccept "rIssuer:type,…" and domainId (to update).
    if (!str(p.minTier)) return NEED(['minTier']);
    const plan = planScoreDomain({ owner: account, minTier: p.minTier, alsoAccept: p.alsoAccept, domainId: p.domainId });
    if (!plan.ok) return BAD(plan.error);
    return SAFE(plan.txjson as unknown as Record<string, unknown>, plan.updatesDomainId ? 'Update Permissioned Domain (XRPLScore-gated)' : 'Create Permissioned Domain (XRPLScore-gated)');
  },
};

/**
 * `ctx` carries live amendment states for builders that depend on them (today only
 * mptissue, via mptBuildContext()), and — for multi-step services — the plan fixed at
 * step 1 (planIds) and the step being built (step). Omitted = "unknown": builders then
 * never emit anything that needs an amendment to be active.
 *
 * Always resolves to a BuildResult with `steps` set on success (single-step services get
 * one step with id "main"); `txjson` is the first step's, for callers that only handle one.
 */
export async function buildServiceTx(productId: string, account: string, params: Params, ctx?: import('@/lib/mptPermanence').BuildContext): Promise<BuildResult> {
  if (!isAddr(account)) return BAD('invalid signer wallet address');
  const b = builders[productId];
  if (!b) return BAD(`product "${productId}" has no execution builder yet`);
  const r = await b(account, params, ctx);
  if (!r.ok) return r;
  const steps: BuildStep[] = r.steps ?? [{ id: 'main', label: r.label ?? productId, txjson: r.txjson as Record<string, unknown> }];
  return { ...r, steps, txjson: steps[0].txjson };
}
