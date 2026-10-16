// src/app/lending/vaults/page.tsx — every XRPL lending vault and its risk grade (phase 2).
// Until LendingProtocol + SingleAssetVault are enabled on mainnet this page only says so.
import BrandLogo from "@/components/BrandLogo";
import type { Metadata } from "next";
import { lendingLive } from "@/lib/lendingTracker";
import { vaultList, GRADE_COLOR, fmtNum } from "../explorer";
import { L, C, fmtTime } from "../ui";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "XRPL Lending Vaults — Risk Grades A–F | XRPLHub",
  description: "Every XRP Ledger lending vault with its size, how much is lent out and an A–F risk grade from on-ledger data only.",
};

export default async function VaultsPage() {
  const live = await lendingLive();
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <nav style={{ ...L.nav, flexWrap: "wrap" }}>
          <BrandLogo />
          <span style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <a href="/lending" style={L.link}>← Lending tracker</a>
            <a href="/lending/method" style={L.link}>How grades work</a>
            </span>
        </nav>
        <h1 style={L.h1}>XRPL lending vaults</h1>
        {!live ? (
          <div style={L.card}>
            <p style={{ margin: 0, fontSize: 15 }}>
              Lending isn&apos;t enabled on the XRP Ledger mainnet yet, so there are no vaults to show. This page fills in on its
              own within an hour of activation. <a href="/lending#notify" style={L.link}>Get one email when it happens.</a>
            </p>
          </div>
        ) : (
          <VaultTable />
        )}
      </div>
    </div>
  );
}

async function VaultTable() {
  const rows = await vaultList();
  if (!rows.length) return <div style={L.card}><p style={{ margin: 0 }}>Lending is live. We haven&apos;t found any vaults yet — the first scan of the ledger takes a day or two.</p></div>;
  return (
    <div style={{ ...L.card, padding: 0, overflowX: "auto" }}>
      <table style={L.table}>
        <thead>
          <tr>
            <th style={L.th}>Grade</th>
            <th style={L.th}>Vault</th>
            <th style={{ ...L.th, textAlign: "right" }}>Size</th>
            <th style={{ ...L.th, textAlign: "right" }}>Lent out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ v, g, total, available }) => (
            <tr key={v.id}>
              <td style={{ ...L.td, fontWeight: 800, fontSize: 16, color: GRADE_COLOR[g?.grade ?? "N/A"] }}>{g?.grade ?? "…"}</td>
              <td style={L.td}>
                <a href={`/lending/vault/${v.id}`} style={L.link}>{v.assetLabel || "Vault"}</a>
                <div style={{ ...L.mono, color: C.small }}>{v.id.slice(0, 16)}…{v.isPrivate ? " · private" : ""}</div>
              </td>
              <td style={{ ...L.td, textAlign: "right" }}>{fmtNum(total)}</td>
              <td style={{ ...L.td, textAlign: "right" }}>{total > 0 ? `${fmtNum(((total - available) / total) * 100, 1)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...L.small, padding: "8px 12px" }}>Grades updated hourly. Latest: {fmtTime(rows[0]?.g?.takenAt?.toISOString())}.</p>
    </div>
  );
}
