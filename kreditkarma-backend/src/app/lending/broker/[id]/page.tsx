// src/app/lending/broker/[id]/page.tsx — one XRPL loan broker: debt, first-loss cover, loan health, grade.
import BrandLogo from "@/components/BrandLogo";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { lendingLive } from "@/lib/lendingTracker";
import { brokerDetail, latestGrade, gradeHistory, recentTxs, fmtNum } from "../../explorer";
import GradePanel from "../../GradePanel";
import { L, C, fmtDate } from "../../ui";

export const revalidate = 300;
export const metadata: Metadata = { title: "XRPL Loan Broker — Risk Grade | XRPLHub" };

export default async function BrokerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9A-F]{64}$/i.test(id) || !(await lendingLive())) notFound();
  const d = await brokerDetail(id.toUpperCase());
  if (!d) notFound();
  const { b, loans, metrics: m } = d;
  const [g, history, txs] = await Promise.all([latestGrade("broker", b.id), gradeHistory("broker", b.id), recentTxs({ brokerId: b.id })]);
  const sorted = [...loans].sort((x, y) => y.f.principalOutstanding - x.f.principalOutstanding);
  const status = (f: (typeof loans)[number]["f"]) => (f.defaulted ? "Defaulted" : f.impaired ? "Impaired" : f.late ? `Late ${f.daysLate}d` : "On time");
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <nav style={{ ...L.nav, flexWrap: "wrap" }}>
          <BrandLogo />
          <span style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <a href={`/lending/vault/${b.vaultId}`} style={L.link}>← Its vault</a>
            <a href="/lending/method" style={L.link}>How grades work</a>
            </span>
        </nav>
        <h1 style={L.h1}>Loan broker</h1>
        <p style={{ ...L.mono, color: C.small, margin: "0 0 14px" }}>{b.id}</p>
        <GradePanel g={g} history={history} />
        <div style={L.card}>
          <p style={L.h2}>The numbers</p>
          <table style={L.table}>
            <tbody>
              <tr><td style={L.td}>Lent out (debt)</td><td style={{ ...L.td, textAlign: "right" }}>{fmtNum(m.debtTotal)}{m.utilizationOfLimit != null ? ` · ${fmtNum(m.utilizationOfLimit, 1)}% of its limit` : ""}</td></tr>
              <tr><td style={L.td}>First-loss cover</td><td style={{ ...L.td, textAlign: "right" }}>{fmtNum(m.coverAvailable)}{m.coverPctOfDebt != null ? ` · ${fmtNum(m.coverPctOfDebt, 2)}% of debt` : ""}</td></tr>
              <tr><td style={L.td}>Cover ratio (vs its required minimum)</td><td style={{ ...L.td, textAlign: "right" }}>{m.coverRatio == null ? "No minimum set" : `${fmtNum(m.coverRatio, 2)}×`}</td></tr>
              <tr><td style={L.td}>Active loans / ever made</td><td style={{ ...L.td, textAlign: "right" }}>{m.activeLoans} / {m.loansEver}</td></tr>
              <tr><td style={L.td}>Late · impaired · defaulted</td><td style={{ ...L.td, textAlign: "right" }}>{m.lateLoans} · {m.impairedLoans} · {m.defaultedLoans}</td></tr>
              <tr><td style={L.td}>Largest single loan</td><td style={{ ...L.td, textAlign: "right" }}>{m.largestLoanPct == null ? "—" : `${fmtNum(m.largestLoanPct, 1)}% of principal`}</td></tr>
            </tbody>
          </table>
          <p style={{ ...L.small, marginTop: 8 }}>Managed by <span style={L.mono}>{b.owner}</span>. Read from ledger #{b.lastLedger.toLocaleString("en-US")}.</p>
        </div>
        <div style={L.card}>
          <p style={L.h2}>Open loans</p>
          {sorted.length ? (
            <div style={{ overflowX: "auto" }}>
              <table style={L.table}>
                <thead><tr><th style={L.th}>Status</th><th style={{ ...L.th, textAlign: "right" }}>Principal left</th><th style={{ ...L.th, textAlign: "right" }}>Rate</th><th style={L.th}>Next due</th></tr></thead>
                <tbody>
                  {sorted.map(({ row, f }) => (
                    <tr key={row.id}>
                      <td style={{ ...L.td, fontWeight: 700, color: f.defaulted || f.impaired ? C.no : f.late ? "#a16207" : C.yes }}>{status(f)}</td>
                      <td style={{ ...L.td, textAlign: "right" }}>{fmtNum(f.principalOutstanding)}</td>
                      <td style={{ ...L.td, textAlign: "right" }}>{fmtNum(f.interestRatePct, 3)}%</td>
                      <td style={L.td}>{fmtDate(f.nextPaymentDue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>No open loans.</p>
          )}
          <p style={{ ...L.small, marginTop: 8 }}>Borrower addresses are public on the ledger; we don&apos;t list them here and we don&apos;t grade borrowers.</p>
        </div>
        <div style={L.card}>
          <p style={L.h2}>Recent lending activity</p>
          {txs.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
              {txs.map((t) => <li key={t.hash}><a href={`https://xrpscan.com/tx/${t.hash}`} style={L.link}>{t.txType}</a> · {fmtDate(t.closeTime.toISOString())}{t.result !== "tesSUCCESS" ? ` · ${t.result}` : ""}</li>)}
            </ul>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>None recorded yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
