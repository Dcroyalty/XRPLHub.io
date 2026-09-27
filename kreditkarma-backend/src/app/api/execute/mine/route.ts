// src/app/api/execute/mine/route.ts
// GET /api/execute/mine?type=checks|nfts|mpts|holders&account=r...
//
// "What do I already hold" — a compact, ready-to-pick list for the ID-shaped fields that would otherwise force a
// customer to go find a Check ID, NFToken ID, MPT Issuance ID, or trust-line holder address themselves before they
// can use checkcash/checkcancel, nftburn/nftoffer, mptsend, or freezeline. Free, read-only, no signup.
//
//   checks   — every Check linked to this account (sent OR received; a Check occupies a directory entry on both
//              sides — OwnerNode for the sender, DestinationNode for the recipient — so account_objects finds both).
//              direction is labeled so the caller can filter: only the DESTINATION can cash one (checkcash);
//              either party (or anyone, after Expiration) can cancel one (checkcancel).
//   nfts     — every NFT this account currently owns (account_nfts) — for nftburn / nftoffer.
//   mpts     — every MPT this account has ISSUED, from the existing MPT registry index (no extra ledger call) —
//              for mptsend (distributing tokens you created). Does not cover MPTs you only hold a balance of.
//   holders  — every counterparty with a trust line to this account (account_lines) — for freezeline, so an issuer
//              picks a holder instead of pasting an address.
//
// Bounded and best-effort: capped at 200 items per type, one ledger page (no follow-the-marker loop) — this is a
// convenience picker, not a census. A caller who has more than that can still type an ID by hand.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/address";
import { xrplRpc } from "@/lib/xrplNodes";
import { dropsToXrp } from "xrpl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const LIMIT = 200;
const TYPES = ["checks", "nfts", "mpts", "holders"] as const;
type PickType = (typeof TYPES)[number];

interface PickItem {
  id: string;
  label: string;
  /** Extra machine-readable fields a specific field can use (e.g. freezeline wants the holder's currency, not just the address). */
  meta?: Record<string, string>;
}

function amountLabel(a: unknown): string {
  if (typeof a === "string") return `${dropsToXrp(a)} XRP`;
  if (a && typeof a === "object" && "currency" in (a as Record<string, unknown>)) {
    const v = a as { currency: string; value: string; issuer?: string };
    return `${v.value} ${v.currency}`;
  }
  return "?";
}

async function listChecks(account: string): Promise<PickItem[]> {
  const r = await xrplRpc("account_objects", { account, type: "check", ledger_index: "validated", limit: LIMIT });
  if (!r.ok) return [];
  const nodes = ((r.body as { result?: { account_objects?: Record<string, unknown>[] } }).result?.account_objects ?? []) as Record<string, unknown>[];
  return nodes.map((n) => {
    const sender = String(n.Account);
    const dest = String(n.Destination);
    const iOwn = sender === account;
    const amount = amountLabel(n.SendMax);
    return {
      id: String(n.index),
      label: iOwn ? `You wrote: ${amount} to ${dest.slice(0, 10)}…${dest.slice(-4)}` : `Written to you: ${amount} from ${sender.slice(0, 10)}…${sender.slice(-4)}`,
      meta: { direction: iOwn ? "sent" : "received", canCash: String(!iOwn) },
    };
  });
}

async function listNfts(account: string): Promise<PickItem[]> {
  const r = await xrplRpc("account_nfts", { account, ledger_index: "validated", limit: LIMIT });
  if (!r.ok) return [];
  const nfts = ((r.body as { result?: { account_nfts?: Record<string, unknown>[] } }).result?.account_nfts ?? []) as Record<string, unknown>[];
  return nfts.map((n) => {
    const id = String(n.NFTokenID);
    const taxon = n.NFTokenTaxon !== undefined ? ` (taxon ${n.NFTokenTaxon})` : "";
    return { id, label: `${id.slice(0, 8)}…${id.slice(-6)}${taxon}` };
  });
}

async function listIssuedMpts(account: string): Promise<PickItem[]> {
  const rows = await prisma.indexedMPT.findMany({ where: { issuer: account }, orderBy: { lastSeenAt: "desc" }, take: LIMIT });
  return rows.map((r) => ({
    id: r.issuanceId,
    label: `${r.name || r.ticker || r.issuanceId.slice(0, 10)}${r.ticker && r.name ? ` (${r.ticker})` : ""} — outstanding ${r.outstanding}`,
  }));
}

async function listHolders(account: string): Promise<PickItem[]> {
  const r = await xrplRpc("account_lines", { account, ledger_index: "validated", limit: LIMIT });
  if (!r.ok) return [];
  const lines = ((r.body as { result?: { lines?: Record<string, unknown>[] } }).result?.lines ?? []) as Record<string, unknown>[];
  // A holder of a currency WE issue has a negative limit_peer/balance convention on our side is confusing; simplest honest
  // signal: any line at all is a counterparty relationship. We can't tell from this call alone which currencies are ours to
  // freeze vs. lines we hold in others' currencies — surface both, labeled, and let the caller recognise their own currency.
  return lines.map((l) => ({
    id: String(l.account),
    label: `${String(l.account).slice(0, 10)}…${String(l.account).slice(-4)} — ${l.currency} balance ${l.balance}`,
    meta: { currency: String(l.currency) },
  }));
}

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const account = (u.get("account") ?? "").trim();
  const type = (u.get("type") ?? "") as PickType;
  if (!isValidXrplAddress(account)) return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL address (&account=r...)." }, { status: 400 });
  if (!TYPES.includes(type)) return NextResponse.json({ error: "bad_request", message: `type must be one of: ${TYPES.join(", ")}.` }, { status: 400 });

  try {
    const items =
      type === "checks" ? await listChecks(account) : type === "nfts" ? await listNfts(account) : type === "mpts" ? await listIssuedMpts(account) : await listHolders(account);
    return NextResponse.json(
      {
        account,
        type,
        count: items.length,
        capped: items.length >= LIMIT,
        items,
        note: type === "mpts" ? "MPTs this account has ISSUED only (from the registry index) — not MPTs it merely holds a balance of." : undefined,
      },
      { headers: { "Cache-Control": "public, max-age=15" } }
    );
  } catch (err) {
    return NextResponse.json({ error: "lookup_failed", message: err instanceof Error ? err.message : "unknown" }, { status: 502 });
  }
}
