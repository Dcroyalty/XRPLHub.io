// src/app/lending/vault/[id]/page.tsx — one XRPL lending vault: size, utilization, loss, yield, brokers, grade.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/xrplscore-db";
import { lendingLive } from "@/lib/lendingTracker";
import { num } from "@/lib/lendingFacts";
import { latestGrade, gradeHistory, recentTxs, GRADE_COLOR, fmtNum } from "../../explorer";
import GradePanel from "../../GradePanel";
import { L, C, fmtTime } from "../../ui";

export const revalidate = 300;
export const metadata: Metadata = { title: "XRPL Lending Vault — Risk Grade | XRPLHub" };

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ flex: "1 1 140px", padding: "10px 12px", border: `1px solid ${C.row}`, borderRadius: 10 }}>
      <div style={L.small}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{value}</div>
      {note && <div style={L.small}>{note}</div>}
    </div>
  );
}

export default async function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9A-F]{64}$/i.test(id) || !(await lendingLive())) notFound();
  const v = await prisma.lendingVault.findUnique({ where: { id: id.toUpperCase() } });
  if (!v || v.network !== "mainnet") notFound();
  const [g, history, brokers, txs] = await Promise.all([
    latestGrade("vault", v.id),
    gradeHistory("vault", v.id),
    prisma.lendingBroker.findMany({ where: { vaultId: v.id, deleted: false } }),
    recentTxs({ vaultId: v.id }),
  ]);
  const brokerGrades = await Promise.all(brokers.map((b) => latestGrade("broker", b.id)));
  const m = (g?.metrics ?? {}) as Record<string, number | null>;
  const total = num(v.assetsTotal);
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <nav style={L.nav}>
          <a href="/lending/vaults" style={L.link}>← All vaults</a>
          <a href="/lending/method" style={L.link}>How grades work</a>
        </nav>
        <h1 style={L.h1}>{v.assetLabel || "Vault"} vault{v.deleted ? " (closed)" : ""}</h1>
        <p style={{ ...L.mono, color: C.small, margin: "0 0 14px" }}>{v.id}</p>
        <GradePanel g={g} history={history} />
        <div style={L.card}>
          <p style={L.h2}>The numbers</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Stat label="Size" value={fmtNum(total)} note={v.assetLabel} />
            <Stat label="Lent out (utilization)" value={m.utilizationPct == null ? "—" : `${fmtNum(m.utilizationPct, 1)}%`} note={`${fmtNum(num(v.assetsAvailable))} available`} />
            <Stat label="Unrealized loss" value={m.lossPct == null ? "—" : `${fmtNum(m.lossPct, 2)}%`} note={fmtNum(num(v.lossUnrealized))} />
            <Stat label="Realized yield" value={m.realizedYieldPct == null ? "Not enough history" : `${fmtNum(m.realizedYieldPct, 2)}% / yr`} note={m.yieldMeasuredOverDays ? `over ${m.yieldMeasuredOverDays} days` : undefined} />
          </div>
          <p style={{ ...L.small, marginTop: 8 }}>
            Owner <span style={L.mono}>{v.owner}</span>{v.isPrivate ? " · private vault (deposits by permission only)" : ""}. Read from ledger #{v.lastLedger.toLocaleString("en-US")}.
          </p>
        </div>
        <div style={L.card}>
          <p style={L.h2}>Loan brokers lending from this vault</p>
          {brokers.length ? (
            <table style={L.table}>
              <tbody>
                {brokers.map((b, i) => (
                  <tr key={b.id}>
                    <td style={{ ...L.td, fontWeight: 800, color: GRADE_COLOR[brokerGrades[i]?.grade ?? "N/A"] }}>{brokerGrades[i]?.grade ?? "…"}</td>
                    <td style={L.td}><a href={`/lending/broker/${b.id}`} style={L.link}>Broker {b.id.slice(0, 10)}…</a></td>
                    <td style={{ ...L.td, textAlign: "right" }}>{fmtNum(num(b.debtTotal))} lent</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>No broker is lending from this vault yet.</p>
          )}
        </div>
        <div style={L.card}>
          <p style={L.h2}>Recent lending activity</p>
          {txs.length ? (
            <table style={L.table}>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.hash}>
                    <td style={L.td}>{t.txType}</td>
                    <td style={L.td}>{fmtTime(t.closeTime.toISOString())}</td>
                    <td style={L.td}><a href={`https://xrpscan.com/tx/${t.hash}`} style={L.link}>{t.result === "tesSUCCESS" ? "view" : t.result}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>None recorded yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
