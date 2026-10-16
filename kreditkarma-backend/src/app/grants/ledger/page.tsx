// src/app/grants/ledger/page.tsx — every donation into the XRPLHub grants pool and every grant paid out of it, from
// 2026-10-16 on (the account's older test history is left out). XRP/RLUSD rows come from the XRP Ledger
// (src/lib/grantsPool.ts, refreshed hourly); card donations from Morrbiz LLC's Stripe account via uxus.finance.
import type React from "react";
import type { Metadata } from "next";
import { prisma } from "@/lib/xrplscore-db";
import { cardDonations, donationsUsdInYear, cardOwed, paidFirstGrants, CARD_TRANSFER_SOURCE, rlusdReceiveStatus, NOT_DONATION_SOURCES, OWNER_TOPUP_SOURCES } from "@/lib/grantsPool";
import { GRANTS_POOL, DONATION_DISCLOSURE } from "@/lib/grantsCopy";
import SiteNav from "@/components/SiteNav";
import { B, S } from "@/components/brand";

export const revalidate = 120;

export const metadata: Metadata = {
  title: "Grants Pool Ledger: Every Donation and Every Grant | XRPLHub",
  description: "Every donation into the XRPLHub grants pool and every grant paid out, with XRP Ledger transaction links. Published from 16 October 2026.",
  alternates: { canonical: "https://www.xrplhub.io/grants/ledger" },
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (d: string | Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function GrantsLedgerPage() {
  const [rows, cards] = await Promise.all([
    prisma.grantsLedgerEntry.findMany({ orderBy: { at: "desc" }, take: 500 }),
    cardDonations(),
  ]);
  const year = new Date().getUTCFullYear();
  const [totals, owed, firstQueue] = await Promise.all([donationsUsdInYear(prisma, year, cards), cardOwed(prisma, cards ?? []), paidFirstGrants(prisma)]);
  const firstReady = await Promise.all(firstQueue.map((g) => rlusdReceiveStatus(g.walletAddress, g.approvedAmount ?? 0)));
  const movedBy = new Map(owed.rows.map((r) => [r.id, r.movedAt]));
  const transfers = rows.filter((r) => r.direction === "in" && r.counterparty === CARD_TRANSFER_SOURCE);
  const topups = rows.filter((r) => r.direction === "in" && OWNER_TOPUP_SOURCES.includes(r.counterparty));
  type Row = { at: string; kind: string; amount: string; detail: React.ReactNode };
  const donations: Row[] = [
    ...rows.filter((r) => r.direction === "in" && !NOT_DONATION_SOURCES.includes(r.counterparty)).map((r) => ({ at: r.at.toISOString(), kind: r.currency, amount: `${r.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${r.currency}${r.usdValue != null ? ` (${usd(r.usdValue)})` : ""}`, detail: <a href={`https://xrpscan.com/tx/${r.txHash}`} rel="noopener" style={{ color: B.accent }}>from {short(r.counterparty)}</a> })),
    ...(cards ?? []).map((c) => ({ at: c.received_at, kind: "Card", amount: usd(c.amount_usd), detail: <span>card fee {c.fee_usd == null ? "pending" : usd(c.fee_usd)} · net {c.net_usd == null ? "pending" : usd(c.net_usd)} · {movedBy.get(c.id) ? <>moved to the pool {day(movedBy.get(c.id)!)}</> : <strong style={{ color: B.accent }}>not yet moved to the pool</strong>} · ref …{c.id}</span> })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const grants = rows.filter((r) => r.direction === "out");
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${B.navyLine}`, color: B.muted, fontSize: 12, fontWeight: 700 };
  const td: React.CSSProperties = { padding: "8px 6px", borderBottom: `1px solid ${B.navyLine}`, fontSize: 13, verticalAlign: "top" };
  return (
    <div style={{ minHeight: "100vh", fontFamily: B.sans, color: B.ink }}>
      <SiteNav active="grants" />
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={S.eyebrow}>Public ledger</div>
        <h1 style={{ fontFamily: B.serif, fontSize: "clamp(28px,6vw,40px)", color: B.white, margin: "6px 0 10px" }}>Every donation in, every grant out</h1>
        <p style={{ margin: "0 0 16px", lineHeight: 1.55 }}>
          From 16 October 2026. Pool account <a href={`https://xrpscan.com/account/${GRANTS_POOL}`} style={{ color: B.accent, wordBreak: "break-all" }}>{GRANTS_POOL}</a>. XRP and RLUSD donations
          are valued in US dollars when received. Card donations are moved into the pool, after card fees, as XRP Ledger payments you can see here too.
        </p>
        <div style={{ ...S.card, marginBottom: 16 }}>
          <div style={S.eyebrow}>Donations in {year}</div>
          <div style={{ fontFamily: B.serif, fontSize: 32, color: B.white, fontWeight: 700 }}>{usd(totals.total)}</div>
          <div style={S.small}>XRP and RLUSD {usd(totals.ledger)} · card {totals.cardKnown ? usd(totals.card) : "(couldn't load right now)"}</div>
        </div>

        <section style={{ ...S.card, marginBottom: 16 }}>
          <div style={S.eyebrow}>Card donations owed to the pool</div>
          <div style={{ fontFamily: B.serif, fontSize: 28, color: B.white, fontWeight: 700 }}>{cards == null ? "—" : usd(owed.owedUsd)}</div>
          <p style={{ ...S.small, margin: "4px 0 0" }}>Card donations arrive in Morrbiz LLC's Stripe balance. They are moved to the pool after card fees, as RLUSD at 1 RLUSD per dollar, in payments from the XRPLHub treasury {CARD_TRANSFER_SOURCE.slice(0, 6)}…{CARD_TRANSFER_SOURCE.slice(-4)} ({transfers.length} so far), oldest first; each card donation below shows the date it was moved.</p>
        </section>

        <section style={{ ...S.card, marginBottom: 16 }}>
          <h2 style={{ ...S.h2, fontSize: 22 }}>Paid first ({firstQueue.length})</h2>
          {firstQueue.length === 0 ? <p style={{ margin: 0 }}>Nothing waiting.</p> : (
            <>
              <p style={{ margin: "0 0 8px" }}>Approved in July 2026, before this pool existed. They are first in the queue and are paid from the first donations.</p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{firstQueue.map((g, i) => <li key={g.id}>{day(g.createdAt)}: ${g.approvedAmount} in RLUSD to {short(g.walletAddress)} — approved, paid first{firstReady[i]?.canReceive ? "" : " (waiting for the recipient to add an RLUSD trust line)"}</li>)}</ul>
            </>
          )}
        </section>

        <section style={{ ...S.card, marginBottom: 16, overflowX: "auto" }}>
          <h2 style={{ ...S.h2, fontSize: 22 }}>Grants paid ({grants.length})</h2>
          {grants.length === 0 ? <p style={{ margin: 0 }}>None yet. The first {10} grants go out when the pool reaches 1,000 XRP.</p> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Amount</th><th style={th}>To</th></tr></thead>
              <tbody>{grants.map((g) => (
                <tr key={g.txHash}><td style={td}>{day(g.at)}</td><td style={td}>{g.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} {g.currency}</td><td style={td}><a href={`https://xrpscan.com/tx/${g.txHash}`} style={{ color: B.accent }}>{short(g.counterparty)}</a></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>

        <section style={{ ...S.card, overflowX: "auto" }}>
          <h2 style={{ ...S.h2, fontSize: 22 }}>Donations received ({donations.length})</h2>
          {donations.length === 0 ? <p style={{ margin: 0 }}>None yet. <a href="/grants#donate" style={{ color: B.accent }}>Be the first</a>.</p> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Amount</th><th style={th}>Details</th></tr></thead>
              <tbody>{donations.map((d, i) => (
                <tr key={i}><td style={td}>{day(d.at)}</td><td style={td}>{d.amount}</td><td style={td}>{d.detail}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
        {topups.length > 0 && (
          <section style={{ ...S.card, marginTop: 16 }}>
            <h2 style={{ ...S.h2, fontSize: 18 }}>Top-ups from the owner (not donations)</h2>
            <p style={{ ...S.small, margin: "0 0 6px" }}>Payments from XRPLHub's owner, for example to cover the account reserve. Not counted as donations.</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{topups.map((t) => <li key={t.txHash}>{day(t.at)}: {t.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} {t.currency} · <a href={`https://xrpscan.com/tx/${t.txHash}`} style={{ color: B.accent }}>transaction</a></li>)}</ul>
          </section>
        )}
        <p style={{ ...S.small, marginTop: 14 }}>{DONATION_DISCLOSURE}</p>
      </main>
    </div>
  );
}
