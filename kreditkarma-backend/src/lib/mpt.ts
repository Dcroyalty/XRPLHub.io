// src/lib/mpt.ts
// The risk view of one Multi-Purpose Token issuance (XLS-33). LIVE reads, no
// index — every field is read from the validated ledger (or the issuer's
// live XRPLScore) on each request. Backs GET /api/mpt/:issuanceId.
//
// What a buyer wants before touching an MPT and can't get from XRPScan or
// Bithomp today: what can this issuer DO to a holder (clawback, freeze,
// require-auth, non-transferable), and is the issuer itself trustworthy
// (XRPLScore, account age, verified domain, credentials).
//
// SOURCE HONESTY: `ledger_entry` is authoritative for existence on the
// current validated ledger. A separate Bithomp lookup adds a second signal.
// If neither has it we return "unknown" — never "does not exist".

import { convertHexToString } from "xrpl";
import { connectMainnetOrThrow } from "./credentials";
import { listCredentialsHeldBy, type LiveCredential } from "./credentialLookup";
import { scoreWallet, AccountNotFoundError } from "./xrplscore";
import { bithompMptLookup, bithompConfigured } from "./bithomp";
import { reportLink, credentialsAccountLink, mptFullLink, type RelatedLink } from "./related";

export const MPT_ISSUANCE_ID_RE = /^[0-9A-Fa-f]{48}$/; // 192-bit MPTokenIssuanceID

// MPTokenIssuance Flags (XLS-33)
const F = {
  locked: 0x0001,
  canLock: 0x0002,
  requireAuth: 0x0004,
  canEscrow: 0x0008,
  canTrade: 0x0010,
  canTransfer: 0x0020,
  canClawback: 0x0040,
} as const;

function safeDecode(hex: string): string {
  try { return convertHexToString(hex); } catch { return hex; }
}
function parseMetadata(hex: string | undefined): unknown {
  if (!hex) return null;
  const s = safeDecode(hex);
  try { return JSON.parse(s); } catch { return s; }
}

export interface MptRisk {
  issuanceId: string;
  found: boolean;
  source: {
    ledger: string;
    bithompIndex: string;
    interpretation: string;
  };
  issuer: string | null;
  issuance: {
    assetScale: number;
    maximumAmount: string | null;
    outstandingAmount: string;
    transferFeeBps: number; // basis points (TransferFee is tenths of a bp)
    metadata: unknown;
  } | null;
  issuerPowers: {
    clawback: boolean;       // issuer can seize holder balances
    canFreeze: boolean;      // issuer can lock balances
    currentlyFrozen: boolean;
    requiresAuth: boolean;   // issuer must approve each holder
    transferable: boolean;   // false = can only be returned to issuer (store credit)
  } | null;
  issuerRisk: {
    xrplScore: number | null;
    grade: string | null;
    // full lookups only:
    accountAgeDays?: number | null;
    blackholed?: boolean;
    domain?: string | null;
    domainVerified?: boolean; // issuer address listed in the domain's xrp-ledger.toml
    credentialsHeld?: number;
    credentials?: { issuer: string; type: string; accepted: boolean; expired: boolean }[];
  } | null;
  related?: RelatedLink[];
  tier: "basic" | "full";
}

/** Best-effort check: is `address` listed in https://<domain>/.well-known/xrp-ledger.toml ? */
async function verifyDomain(domain: string, address: string): Promise<boolean> {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return false;
  try {
    const res = await fetch(`https://${host}/.well-known/xrp-ledger.toml`, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: "text/plain" },
    });
    if (!res.ok) return false;
    const toml = await res.text();
    return toml.includes(address);
  } catch {
    return false;
  }
}

export async function getMptRisk(issuanceId: string, opts: { full?: boolean } = {}): Promise<MptRisk> {
  const full = opts.full ?? false;
  const id = issuanceId.toUpperCase();
  const client = await connectMainnetOrThrow();

  let node: Record<string, unknown> | null = null;
  try {
    const res = await client.request({
      command: "ledger_entry",
      ledger_index: "validated",
      mpt_issuance: id,
    } as unknown as Parameters<typeof client.request>[0]);
    node = (res.result as { node?: Record<string, unknown> }).node ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/entryNotFound|not.*found|malformed/i.test(msg)) {
      await client.disconnect().catch(() => {});
      throw err;
    }
  }

  // Bithomp cross-check (independent of ledger result)
  const bithomp = await bithompMptLookup(id);
  const bithompStr = !bithompConfigured()
    ? "not checked (BITHOMP_API_KEY unset)"
    : bithomp ? "listed in Bithomp's index" : "not in Bithomp's index";

  if (!node || node.LedgerEntryType !== "MPTokenIssuance") {
    await client.disconnect().catch(() => {});
    return {
      issuanceId: id,
      found: false,
      tier: full ? "full" : "basic",
      source: {
        ledger: "not present on the validated ledger",
        bithompIndex: bithompStr,
        interpretation: bithomp
          ? "Bithomp's index has this issuance but it is not on the current validated ledger — it may have been destroyed."
          : "unknown — not found on the validated ledger and not in Bithomp's index. This does not mean it never existed.",
      },
      issuer: bithomp?.issuer ?? null,
      issuance: null,
      issuerPowers: null,
      issuerRisk: null,
    };
  }

  const issuer = String(node.Issuer);
  const flags = Number(node.Flags ?? 0);

  // BASIC: just the score. FULL: + account_info (domain, blackhole) +
  // credentials + xrp-ledger.toml domain verification.
  const tasks: Promise<unknown>[] = [scoreWallet(issuer)];
  if (full) {
    tasks.push(
      client.request({ command: "account_info", account: issuer, ledger_index: "validated", signer_lists: true }),
      listCredentialsHeldBy(issuer)
    );
  }
  const settled = await Promise.allSettled(tasks);
  await client.disconnect().catch(() => {});

  const scoreRes = settled[0] as PromiseSettledResult<Awaited<ReturnType<typeof scoreWallet>>>;
  let xrplScore: number | null = null, gradeStr: string | null = null;
  if (scoreRes.status === "fulfilled") {
    xrplScore = scoreRes.value.ledgerScore;
    gradeStr = scoreRes.value.grade;
  } else if (!(scoreRes.reason instanceof AccountNotFoundError)) {
    // non-fatal — leave nulls
  }

  const issuerPowers = {
    clawback: (flags & F.canClawback) !== 0,
    canFreeze: (flags & F.canLock) !== 0,
    currentlyFrozen: (flags & F.locked) !== 0,
    requiresAuth: (flags & F.requireAuth) !== 0,
    transferable: (flags & F.canTransfer) !== 0,
  };
  const issuance = {
    assetScale: Number(node.AssetScale ?? 0),
    maximumAmount: node.MaximumAmount != null ? String(node.MaximumAmount) : null,
    outstandingAmount: String(node.OutstandingAmount ?? "0"),
    transferFeeBps: Number(node.TransferFee ?? 0) / 10,
    metadata: parseMetadata(node.MPTokenMetadata as string | undefined),
  };

  if (!full) {
    return {
      issuanceId: id, found: true, tier: "basic",
      source: { ledger: "MPTokenIssuance present on the validated ledger (live read)", bithompIndex: bithompStr, interpretation: "exists" },
      issuer, issuance, issuerPowers,
      issuerRisk: { xrplScore, grade: gradeStr },
      related: [mptFullLink(id)],
    };
  }

  const acctRes = settled[1] as PromiseSettledResult<{ result: unknown }>;
  const creds = settled[2] as PromiseSettledResult<LiveCredential[]>;

  let accountAgeDays: number | null =
    scoreRes.status === "fulfilled" ? scoreRes.value.details?.accountAgeDays ?? null : null;
  let domain: string | null = null, blackholed = false;
  if (acctRes.status === "fulfilled") {
    const d = (acctRes.value.result as unknown as { account_data: Record<string, unknown> }).account_data;
    const acctFlags = Number(d.Flags ?? 0);
    domain = d.Domain ? safeDecode(String(d.Domain)) : null;
    const masterDisabled = (acctFlags & 0x00100000) !== 0; // lsfDisableMaster
    const hasSignerList = Array.isArray(d.signer_lists) && d.signer_lists.length > 0;
    blackholed = masterDisabled && !hasSignerList && !d.RegularKey;
  }
  const domainVerified = domain ? await verifyDomain(domain, issuer) : false;
  const credList: LiveCredential[] = creds.status === "fulfilled" ? creds.value : [];

  const related: RelatedLink[] = [reportLink(issuer)];
  if (credList.length > 0) related.push(credentialsAccountLink(issuer));

  return {
    issuanceId: id, found: true, tier: "full",
    source: { ledger: "MPTokenIssuance present on the validated ledger (live read)", bithompIndex: bithompStr, interpretation: "exists" },
    issuer, issuance, issuerPowers,
    issuerRisk: {
      xrplScore, grade: gradeStr, accountAgeDays, blackholed, domain, domainVerified,
      credentialsHeld: credList.length,
      credentials: credList.map((c) => ({
        issuer: c.issuer, type: c.credentialTypeDecoded, accepted: c.accepted, expired: c.expired,
      })),
    },
    related,
  };
}
