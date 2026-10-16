// src/app/yield/[slug]/page.tsx — one way to earn on XRP or RLUSD: every fact we hold, where it came from and
// when, and the risk grade with each point taken off. One page per option for search (all in the sitemap).
import type React from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/xrplscore-db";
import { parseStored, YIELD_CONSENT } from "@/lib/yieldDesk";
import { RULES } from "@/lib/yieldGrade";
import { L, C, fmtDate, fmtTime } from "../../lending/ui";
import { Disclaimer, YieldNav, GradeBadge, CUSTODY_WORDS, pct, usd } from "../parts";
import VisitBeacon from "../VisitBeacon";
import YieldSignupForm from "../YieldSignupForm";

export const revalidate = 600;

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  if (!/^[a-z0-9-]{3,90}$/.test(slug)) return null;
  const row = await prisma.yieldOption.findUnique({ where: { slug } });
  return row ? { row, o: parseStored(row.data) } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const d = await load(slug);
  if (!d) return { title: "Not found | XRPLHub" };
  const { o } = d;
  return {
    title: `${o.name}: ${o.rate != null ? pct(o.rate) + " " : ""}${o.asset} Yield, Risk Grade ${o.gradeDetail.grade} | XRPLHub`,
    description: `${o.name} on ${o.chain}: rate, size, withdrawal terms, who holds the keys, and an A–F risk grade from public data. General information, not advice.`,
    alternates: { canonical: `https://www.xrplhub.io/yield/${o.slug}` },
  };
}

export default async function OptionPage({ params }: Props) {
  const { slug } = await params;
  const d = await load(slug);
  if (!d) notFound();
  const { row, o } = d;
  const g = o.gradeDetail;
  const [obs, grades] = await Promise.all([
    prisma.yieldObservation.findMany({ where: { slug, day: { gte: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { day: "asc" } }),
    prisma.yieldGrade.findMany({ where: { slug }, orderBy: { takenAt: "asc" }, take: 50 }),
  ]);
  const ruleText = (id: string) => RULES.find((r) => r.id === id)?.text ?? id;
  const facts: [string, React.ReactNode][] = [
    ["Rate", o.rate == null ? "Not available yet" : <>{pct(o.rate)} a year <span style={L.small}>({o.rateKind})</span></>],
    ...(o.rateReward ? ([["Of which reward tokens", pct(o.rateReward)]] as [string, React.ReactNode][]) : []),
    ["Size", o.sizeNote ? <>{usd(o.tvlUsd)} <span style={L.small}>({o.sizeNote})</span></> : usd(o.tvlUsd)],
    ["Lockup", o.lockup],
    ["Getting your money out", o.withdrawal],
    ["Who holds the keys", `${CUSTODY_WORDS[o.custody]}: ${o.keys}`],
    ["Chain", o.chain],
    ["Bridge", o.bridge === "none" ? "None" : o.bridge === "fassets" ? "FAssets (XRP → FXRP on Flare)" : o.bridge === "fassets+layerzero" ? "FAssets, then LayerZero to this chain" : o.bridge === "binance-peg" ? "Binance-Peg (an IOU issued by Binance)" : "Bridged or wrapped XRP"],
    ["Age", o.launchedAt ? `Since ${fmtDate(o.launchedAt)}` : "Unknown"],
    ["Audits", o.audits == null ? "Not applicable" : o.audits === 0 ? "None we can link to" : <>{o.audits} {o.auditLinks.map((u, i) => <a key={u} href={u} rel="nofollow noopener" style={{ ...L.link, marginLeft: 6 }}>report {i + 1}</a>)}</>],
    ...(o.regionNote ? ([["Availability", o.regionNote]] as [string, React.ReactNode][]) : []),
    ["Data source", <><a href={o.source.url} rel="nofollow noopener" style={L.link}>{o.source.name}</a> <span style={L.small}>· read {fmtTime(o.source.at)}</span></>],
  ];
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <YieldNav back={{ href: "/yield", label: "All options" }} />
        <VisitBeacon path={`/yield/${o.slug}`} />
        <h1 style={L.h1}>{o.name}</h1>
        <p style={L.sub}>{o.provider} · {o.chain} · earn on {o.asset}{!row.listed ? " · no longer listed by its source (last data shown)" : ""}</p>
        <Disclaimer />

        <div style={L.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <GradeBadge grade={g.grade} size={52} />
            <div>
              <div style={{ fontWeight: 700 }}>Risk grade {g.grade}{g.score >= 0 ? ` · ${g.score}/100` : ""}</div>
              <div style={L.small}>Updated {fmtTime(row.updatedAt.toISOString())} · <a href={g.methodVersion.startsWith("lending") ? "/lending/method" : "/yield/method"} style={L.link}>how we grade</a></div>
            </div>
          </div>
          {g.adjustments.length > 0 ? (
            <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 14 }}>
              {g.adjustments.map((a, i) => (
                <li key={i} style={{ margin: "5px 0" }} title={ruleText(a.rule)}><strong style={{ color: C.no }}>{a.points}</strong> {a.why}</li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: "10px 0 0", fontSize: 14 }}>No points taken off under our method.</p>
          )}
          {grades.length > 1 && <p style={{ ...L.small, marginTop: 10 }}>Grade history: {grades.map((h) => `${h.grade} (${fmtDate(h.takenAt.toISOString())})`).join(" → ")}</p>}
        </div>

        <div style={L.card}>
          <p style={L.h2}>The facts</p>
          <dl style={{ margin: 0, fontSize: 14 }}>
            {facts.map(([k, v]) => (
              <div key={k} style={{ padding: "7px 0", borderBottom: `1px solid ${C.row}` }}>
                <dt style={{ color: C.small, fontSize: 12, fontWeight: 600 }}>{k}</dt>
                <dd style={{ margin: "2px 0 0" }}>{v}</dd>
              </div>
            ))}
          </dl>
          {o.notes && o.notes.length > 0 && (
            <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 14 }}>
              {o.notes.map((n) => <li key={n} style={{ margin: "4px 0" }}>{n}</li>)}
            </ul>
          )}
          <p style={{ margin: "12px 0 0", fontSize: 14 }}>
            Product site: <a href={o.url} rel="nofollow noopener" style={L.link}>{new URL(o.url).host}</a> <span style={L.small}>(no referral code; we earn nothing if you use it)</span>
          </p>
        </div>

        {obs.length > 1 && (
          <div style={L.card}>
            <p style={L.h2}>What we have seen</p>
            <table style={L.table}>
              <thead><tr><th style={L.th}>Day</th><th style={L.th}>Rate</th><th style={L.th}>Size</th></tr></thead>
              <tbody>
                {obs.slice(-14).reverse().map((r) => (
                  <tr key={r.day.toISOString()}><td style={L.td}>{fmtDate(r.day.toISOString())}</td><td style={L.td}>{pct(r.apr)}</td><td style={L.td}>{usd(r.tvlUsd)}</td></tr>
                ))}
              </tbody>
            </table>
            <p style={{ ...L.small, marginTop: 8 }}>Our own daily readings since {fmtDate(obs[0].day.toISOString())}.</p>
          </div>
        )}

        <div style={L.card}>
          <p style={L.h2}>Email me if this grade changes</p>
          <YieldSignupForm consent={YIELD_CONSENT} slug={o.slug} />
        </div>
      </div>
    </div>
  );
}
