// src/app/lending/page.tsx — XRPL Lending: is it live yet, who is voting for it, and what it means.
// Server-rendered from the hourly snapshots (src/lib/lendingTracker.ts). Phase 2 (vault explorer + risk
// grades) appears here automatically once the amendments are enabled on mainnet.
import BrandLogo from "@/components/BrandLogo";
import type { Metadata } from "next";
import { prisma } from "@/lib/xrplscore-db";
import {
  latestSnapshot, readTracker, voteSeries, lendingLive, LENDING_CONSENT, AMENDMENT_PLAIN,
  type TrackerSnapshot, type SeriesPoint, type LendingAmendment,
} from "@/lib/lendingTracker";
import SignupForm from "./SignupForm";
import { L, C, fmtDate, fmtTime } from "./ui";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Is XRPL Lending Live Yet? Validator Vote Tracker | XRPLHub",
  description:
    "Live tracker for XRP Ledger native lending (LendingProtocol, SingleAssetVault): yes votes vs the 29 needed, which validators vote yes or no, and what lending means for XRP holders. Updated hourly.",
  alternates: { canonical: "https://www.xrplhub.io/lending" },
};

const ORDER: LendingAmendment[] = ["SingleAssetVault", "LendingProtocol", "LendingProtocolV1_1"];
const COLORS: Record<LendingAmendment, string> = { SingleAssetVault: "#0f766e", LendingProtocol: "#7c3aed", LendingProtocolV1_1: "#d97706" };
const SHORT: Record<LendingAmendment, string> = { SingleAssetVault: "Vaults", LendingProtocol: "Loans", LendingProtocolV1_1: "Loans v1.1" };

function headline(s: TrackerSnapshot): { title: string; detail: string } {
  const by = Object.fromEntries(s.amendments.map((a) => [a.name, a])) as Record<LendingAmendment, TrackerSnapshot["amendments"][number]>;
  const core = [by.SingleAssetVault, by.LendingProtocol];
  if (core.every((a) => a.state === "active")) return { title: "Yes — XRPL lending is live.", detail: "Vaults and loans are enabled on the XRP Ledger mainnet." };
  const withMajority = core.filter((a) => a.majoritySince);
  if (withMajority.length === core.length) {
    const when = withMajority.map((a) => a.earliestActivation as string).sort().pop();
    return { title: "Almost — lending has a majority.", detail: `If the majority holds, lending switches on around ${fmtDate(when)}.` };
  }
  const lp = by.LendingProtocol;
  if (lp.yes != null && lp.needed != null) {
    return { title: "Not yet.", detail: `${lp.yes} of ${lp.unlSize} validators vote yes on loans. ${lp.needed} are needed, then the majority has to hold for two weeks.` };
  }
  return { title: "Not yet.", detail: "Lending is not enabled on mainnet. Validator vote counts are temporarily unavailable." };
}

function Progress({ yes, needed, total, color }: { yes: number; needed: number; total: number; color: string }) {
  const pct = (n: number) => `${Math.min(100, (n / total) * 100).toFixed(2)}%`;
  return (
    <div style={{ position: "relative", height: 12, background: C.row, borderRadius: 99, margin: "8px 0 4px" }} aria-hidden="true">
      <div style={{ width: pct(yes), height: "100%", background: color, borderRadius: 99 }} />
      <div style={{ position: "absolute", left: pct(needed), top: -4, bottom: -4, width: 2, background: C.fg }} title="votes needed" />
    </div>
  );
}

function VoteChart({ series, total, needed }: { series: SeriesPoint[]; total: number; needed: number }) {
  const W = 600, H = 260, padL = 44, padR = 12, padT = 16, padB = 38;
  const t0 = new Date(series[0].at).getTime();
  const t1 = Math.max(new Date(series[series.length - 1].at).getTime(), t0 + 86_400_000);
  const x = (iso: string) => padL + ((new Date(iso).getTime() - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - v / total) * (H - padT - padB);
  const ticks = [0, Math.round(total / 2), total];
  const first = fmtDate(series[0].at), last = fmtDate(series[series.length - 1].at);
  // Phone-first sizing: the SVG never renders wider than 600px, so a 17-unit label is ~10px on a 360px phone and
  // 17px on desktop. Bare tick numbers are hidden from text readers; the aria-label carries the meaning.
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Yes votes over time, out of ${total} validators; ${needed} needed`} style={{ display: "block", maxWidth: 600 }}>
      {ticks.map((t) => (
        <g key={t} aria-hidden="true">
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.row} strokeWidth="1.5" />
          <text x={padL - 8} y={y(t) + 6} fontSize="17" textAnchor="end" fill={C.small}>{t}</text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={y(needed)} y2={y(needed)} stroke={C.fg} strokeWidth="2" strokeDasharray="8 6" />
      <text x={W - padR} y={y(needed) - 8} fontSize="17" fontWeight="700" textAnchor="end" fill={C.fg}>{needed} votes needed</text>
      {ORDER.map((n) => {
        const pts = series.filter((p) => p.yes[n] != null).map((p) => [x(p.at), y(p.yes[n] as number)] as const);
        if (!pts.length) return null;
        return (
          <g key={n}>
            {pts.length > 1 && <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={COLORS[n]} strokeWidth="3.5" />}
            {pts.length <= 3 && pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="6" fill={COLORS[n]} />)}
          </g>
        );
      })}
      <text x={padL} y={H - 10} fontSize="16" fill={C.small}>{first}</text>
      {last !== first && <text x={W - padR} y={H - 10} fontSize="16" textAnchor="end" fill={C.small}>{last}</text>}
    </svg>
  );
}

export default async function LendingPage() {
  let snap = await latestSnapshot(prisma).catch(() => null);
  if (!snap) snap = await readTracker(); // first deploy, before the hourly job has stored anything
  const [series, live] = await Promise.all([voteSeries(prisma).catch(() => [] as SeriesPoint[]), lendingLive()]);
  const h = headline(snap);
  const total = snap.unlSize ?? 35;
  const needed = snap.amendments.find((a) => a.needed != null)?.needed ?? Math.floor(total * 0.8) + 1;
  const rows = ORDER.map((n) => snap.amendments.find((a) => a.name === n)).filter((a): a is NonNullable<typeof a> => !!a);

  return (
    <div style={L.shell}>
      <div style={L.page}>
        <nav style={L.nav}>
          <BrandLogo />
          <a href="/lending/method" style={L.link}>How we&apos;ll grade vaults</a>
        </nav>

        <p style={{ ...L.small, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700, margin: 0 }}>XRPL Lending tracker</p>
        <h1 style={L.h1}>Is XRPL lending live? {h.title}</h1>
        <p style={L.sub}>{h.detail}</p>

        {live && (
          <div style={{ ...L.card, borderColor: C.accent }}>
            <p style={L.h2}>Lending is live — see every vault and its risk grade</p>
            <a href="/lending/vaults" style={L.link}>Browse vaults and loan brokers →</a>
          </div>
        )}

        <div style={L.card}>
          <p style={L.h2}>The three votes</p>
          {rows.map((a) => (
            <div key={a.name} style={{ padding: "10px 0", borderTop: `1px solid ${C.row}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ fontSize: 15 }}>{SHORT[a.name]} <span style={{ ...L.mono, color: C.small }}>{a.name}</span></strong>
                <span style={{ fontSize: 14, fontWeight: 700, color: a.state === "active" ? C.yes : C.fg }}>
                  {a.state === "active" ? "Enabled" : a.yes != null ? `${a.yes} of ${a.unlSize} yes · ${a.needed} needed` : a.state === "unknown" ? "Status unknown right now" : "Not enabled"}
                </span>
              </div>
              {a.state !== "active" && a.yes != null && a.needed != null && a.unlSize != null && <Progress yes={a.yes} needed={a.needed} total={a.unlSize} color={COLORS[a.name]} />}
              <div style={L.small}>
                {AMENDMENT_PLAIN[a.name]}{" "}
                {a.state === "active"
                  ? "Enabled on mainnet."
                  : a.majoritySince
                    ? `Majority since ${fmtDate(a.majoritySince)} — enables ${fmtDate(a.earliestActivation)} if it holds.`
                    : "No majority yet."}
              </div>
            </div>
          ))}
          <p style={{ ...L.small, marginTop: 10 }}>
            Updated hourly. Last read {fmtTime(snap.takenAt)}{snap.ledgerIndex ? `, ledger #${snap.ledgerIndex.toLocaleString("en-US")}` : ""}.
            Enabled status and majority dates come straight from the XRP Ledger. Votes come from validators&apos; published votes as collected by{" "}
            <a href="https://xrpscan.com/amendments" style={L.link}>XRPScan</a>, counted for the {total} validators on Ripple&apos;s default list.
            An amendment needs more than 80% of them ({needed}) for two straight weeks.
          </p>
        </div>

        <div style={L.card}>
          <p style={L.h2}>Support over time</p>
          {series.length ? (
            <>
              <VoteChart series={series} total={total} needed={needed} />
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13, marginTop: 6 }}>
                {ORDER.map((n) => (
                  <span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 12, height: 3, background: COLORS[n], display: "inline-block" }} /> {SHORT[n]}
                  </span>
                ))}
              </div>
              {series.length < 24 && <p style={{ ...L.small, marginTop: 6 }}>We started recording on October 16, 2026, so the line is short for now. It grows every hour.</p>}
            </>
          ) : (
            <p style={L.small}>The first hourly reading is being recorded. Check back in an hour.</p>
          )}
        </div>

        {snap.voters && (
          <div style={L.card}>
            <p style={L.h2}>How each validator votes</p>
            <p style={{ ...L.small, marginBottom: 8 }}>The {snap.voters.length} validators on Ripple&apos;s default list. ✓ = votes yes, ✗ = votes no or hasn&apos;t voted.</p>
            <div style={{ overflowX: "auto" }}>
              <table style={L.table}>
                <thead>
                  <tr>
                    <th style={L.th}>Validator</th>
                    {ORDER.map((n) => <th key={n} style={{ ...L.th, textAlign: "center" }}>{SHORT[n]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {snap.voters.map((v) => (
                    <tr key={v.key}>
                      <td style={L.td}>{v.domain ?? <span style={L.mono}>{v.key.slice(0, 12)}…</span>}</td>
                      {ORDER.map((n) => (
                        <td key={n} style={{ ...L.td, textAlign: "center", color: v.votes[n] ? C.yes : C.no, fontWeight: 700 }} aria-label={v.votes[n] ? "yes" : "no"}>
                          {v.votes[n] ? "✓" : "✗"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={L.card} id="notify">
          <p style={L.h2}>Get one email when lending goes live</p>
          <SignupForm consent={LENDING_CONSENT} />
        </div>

        <div style={L.card} id="what-it-means">
          <p style={L.h2}>What XRPL lending means for XRP holders</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15 }}>
            <li style={{ margin: "6px 0" }}><strong>Nothing changes unless you opt in.</strong> Your XRP stays exactly where it is. There is nothing to claim, register or sign up for on-chain.</li>
            <li style={{ margin: "6px 0" }}><strong>Vaults.</strong> Anyone could open a vault. You deposit one kind of asset — XRP, RLUSD or another token — and get vault shares back.</li>
            <li style={{ margin: "6px 0" }}><strong>Loans.</strong> The vault&apos;s manager (the &quot;loan broker&quot;) lends from the vault for a fixed term. Repayments with interest flow back to the vault, so your shares can grow.</li>
            <li style={{ margin: "6px 0" }}><strong>The catch: loans have no collateral.</strong> Borrowers don&apos;t lock anything up. The broker decides who gets a loan, off the ledger. If a borrower stops paying, the vault — and so the depositors — can lose money.</li>
            <li style={{ margin: "6px 0" }}><strong>First-loss cover.</strong> A broker can put up its own money as a buffer that takes losses before depositors do. How big that buffer is matters a lot.</li>
            <li style={{ margin: "6px 0" }}><strong>Everything is public.</strong> Every vault, broker and loan sits on the ledger for anyone to read. That&apos;s what our risk grades will be built on — on-ledger facts only.</li>
            <li style={{ margin: "6px 0" }}><strong>Watch for scams.</strong> No one needs your secret key or a &quot;pre-registration&quot; payment for XRPL lending. Anyone asking is a scammer.</li>
          </ul>
          <p style={{ ...L.small, marginTop: 10 }}>XRPLHub never holds your money or keys and never lends. This page is information, not financial advice.</p>
        </div>

        <p style={L.small}>
          <a href="/lending/method" style={L.link}>How we&apos;ll grade vaults and brokers</a> · <a href="/privacy#lending-list" style={L.link}>Privacy</a> · <a href="/" style={L.link}>XRPLHub home</a>
        </p>
      </div>
    </div>
  );
}
