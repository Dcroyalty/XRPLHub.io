"use client";
// src/app/home/HomeTop.tsx — the top of the homepage, ratings-style: the free wallet check (one box, a score dial),
// then the "Buy now" row, the Yield Desk's top A-rated options, and the trust strip. Navy and white with one gold
// accent, drawn over the site's existing background. Words: "wallet score", "risk grade", "ratings" only.
import { useEffect, useState } from "react";
import type React from "react";
import ProBuy from "@/components/ProBuy";
import { B, S } from "@/components/brand";

type Score = { ledgerScore: number; grade?: string; breakdown?: { label: string; score: number }[] };
const MIN = 300, MAX = 850;

function Dial({ score }: { score: number | null }) {
  // A 234° arc (153° → 387°) from 300 to 850, filled in gold up to the score.
  const r = 86, cx = 110, cy = 104;
  const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15;
  const t = score == null ? 0 : (Math.min(MAX, Math.max(MIN, score)) - MIN) / (MAX - MIN);
  const at = (f: number) => { const a = a0 + (a1 - a0) * f; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (f0: number, f1: number) => { const [x0, y0] = at(f0), [x1, y1] = at(f1); const large = (a1 - a0) * (f1 - f0) > Math.PI ? 1 : 0; return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`; };
  return (
    <svg viewBox="0 0 220 170" width="100%" style={{ maxWidth: 280, display: "block", margin: "0 auto" }} role="img" aria-label={score == null ? "Wallet score dial" : `Wallet score ${score} out of ${MAX}`}>
      <path d={arc(0, 1)} stroke="rgba(255,255,255,.18)" strokeWidth="14" fill="none" strokeLinecap="round" />
      {score != null && <path d={arc(0, Math.max(0.005, t))} stroke={B.accent} strokeWidth="14" fill="none" strokeLinecap="round" />}
      <text x="110" y="104" textAnchor="middle" fill="#fff" style={{ fontFamily: B.serif, fontSize: 44, fontWeight: 700 }}>{score ?? "—"}</text>
      <text x="110" y="128" textAnchor="middle" fill="rgba(233,238,248,.66)" style={{ fontFamily: B.sans, fontSize: 12 }}>wallet score · {MIN}–{MAX}</text>
      <text x={at(0)[0]} y={at(0)[1] + 22} textAnchor="middle" fill="rgba(233,238,248,.5)" style={{ fontSize: 10 }}>{MIN}</text>
      <text x={at(1)[0]} y={at(1)[1] + 22} textAnchor="middle" fill="rgba(233,238,248,.5)" style={{ fontSize: 10 }}>{MAX}</text>
    </svg>
  );
}

export function WalletCheck({ onFullReport, initial = "" }: { onFullReport: (addr: string) => void; initial?: string }) {
  const [addr, setAddr] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<{ addr: string; s: Score } | null>(null);
  useEffect(() => { if (initial) setAddr(initial); }, [initial]);
  const check = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const a = addr.trim();
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) { setErr("Paste an XRP wallet address (it starts with r)."); return; }
    setErr(""); setBusy(true);
    try {
      const r = await fetch(`/api/score/${encodeURIComponent(a)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || "Couldn't check that wallet.");
      setRes({ addr: a, s: { ledgerScore: j.ledgerScore ?? j.score, grade: j.grade, breakdown: j.breakdown } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't check that wallet.");
    } finally { setBusy(false); }
  };
  return (
    <section id="check" style={{ ...S.card, padding: "22px 18px", background: B.navyDeep, scrollMarginTop: 80 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 18, alignItems: "center" }}>
        <div>
          <div style={S.eyebrow}>Free wallet check · XRPLScore</div>
          <h1 style={{ fontFamily: B.serif, fontSize: "clamp(30px,7.5vw,50px)", color: B.white, margin: "8px 0 10px", lineHeight: 1.08 }}>
            Check any XRP wallet before you trust it.
          </h1>
          <p style={{ fontSize: 16, color: B.ink, margin: "0 0 16px", lineHeight: 1.55 }}>
            A wallet score from 300 to 850, built only from the wallet&apos;s public history on the XRP Ledger. Free, no sign-up.
          </p>
          <form onSubmit={check} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input aria-label="XRP wallet address" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Paste a wallet address (r…)" autoComplete="off" spellCheck={false} style={{ ...S.input, flex: "1 1 220px" }} />
            <button type="submit" disabled={busy} style={{ ...S.btnPrimary, flex: "0 0 auto" }}>{busy ? "Checking…" : "Check wallet"}</button>
          </form>
          {err && <p role="alert" style={{ color: "#fca5a5", margin: "8px 0 0", fontSize: 14 }}>{err}</p>}
          <p style={{ ...S.small, margin: "8px 0 0" }}>It rates a wallet, not a person. Not a consumer report, not advice.</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <Dial score={res?.s.ledgerScore ?? null} />
          {res ? (
            <>
              <div style={{ color: B.white, fontWeight: 800, fontSize: 18 }}>{res.s.grade ?? ""}</div>
              {res.s.breakdown && (
                <ul style={{ listStyle: "none", padding: 0, margin: "10px auto 0", maxWidth: 300, textAlign: "left", fontSize: 13 }}>
                  {res.s.breakdown.slice(0, 4).map((b) => (
                    <li key={b.label} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${B.navyLine}`, padding: "5px 0" }}><span>{b.label}</span><strong style={{ color: B.white }}>{b.score}</strong></li>
                  ))}
                </ul>
              )}
              <button onClick={() => onFullReport(res.addr)} style={{ ...S.btnSecondary, marginTop: 12 }}>Full report</button>
            </>
          ) : (
            <p style={{ ...S.small, margin: "4px 0 0" }}>Your result shows here.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ProductCard({ name, line, price, children }: { name: string; line: string; price: string; children: React.ReactNode }) {
  return (
    <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ color: B.white, fontSize: 17, fontFamily: B.serif }}>{name}</strong>
        <span style={{ color: B.accent, fontWeight: 800, fontSize: 14 }}>{price}</span>
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, flex: 1 }}>{line}</p>
      {children}
    </div>
  );
}

export function BuyRow() {
  return (
    <section aria-labelledby="buy-now" style={{ marginTop: 22, fontFamily: B.sans }}>
      <h2 id="buy-now" style={S.h2}>Buy now</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))", gap: 12 }}>
        <ProductCard name="XRPLHub Pro" price="$49/mo · or 49 RLUSD / 30 days" line="Alerts the moment a yield or lending risk grade changes, plus 20,000 grade API calls a month.">
          <ProBuy compact />
        </ProductCard>
        <ProductCard name="Grade API" price="$0.02 per call" line="Risk grades for XRP yield options and XRPL lending vaults, for apps and AI agents. No account needed.">
          <a href="/developers" style={S.btnSecondary}>See the API</a>
        </ProductCard>
        <ProductCard name="Free tools" price="Free" line="Wallet check, Yield Desk ratings, the lending tracker, wallet permissions and more.">
          <a href="#products" style={S.btnPrimary}>Use free</a>
        </ProductCard>
      </div>
    </section>
  );
}

type YieldRow = { slug: string; name: string; asset: string; chain: string; rate: number | null; gradeDetail: { grade: string } };

export function TopRated() {
  const [rows, setRows] = useState<YieldRow[] | null>(null);
  useEffect(() => {
    fetch("/api/yield/options").then((r) => r.json()).then((j) => setRows(((j.options ?? []) as YieldRow[]).filter((o) => o.gradeDetail?.grade === "A").slice(0, 4))).catch(() => setRows([]));
  }, []);
  return (
    <section aria-labelledby="top-rated" style={{ marginTop: 22, fontFamily: B.sans }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h2 id="top-rated" style={S.h2}>Top-rated ways to earn on XRP and RLUSD</h2>
        <a href="/yield" style={{ color: B.accent, fontWeight: 700, fontSize: 14 }}>All yield ratings →</a>
      </div>
      <p style={{ ...S.small, margin: "0 0 10px" }}>Risk grade A from the Yield Desk. General information, not advice. We are never paid by what we grade.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))", gap: 10 }}>
        {rows == null && <div style={S.card}>Loading ratings…</div>}
        {rows?.length === 0 && <div style={S.card}>No option holds an A right now. <a href="/yield" style={{ color: B.accent }}>See all ratings</a>.</div>}
        {rows?.map((o) => (
          <a key={o.slug} href={`/yield/${o.slug}`} style={{ ...S.card, textDecoration: "none", display: "flex", gap: 12, alignItems: "center" }}>
            <span aria-label="Risk grade A" style={{ width: 40, height: 40, flex: "0 0 auto", borderRadius: 8, background: B.white, color: B.navy, fontFamily: B.serif, fontWeight: 800, fontSize: 22, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>A</span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", color: B.white, fontWeight: 700, fontSize: 14, lineHeight: 1.3 }}>{o.name}</span>
              <span style={{ display: "block", fontSize: 12, color: B.muted }}>{o.chain} · {o.rate == null ? "rate pending" : `${(o.rate * 100).toFixed(o.rate >= 0.1 ? 1 : 2)}% a year`}</span>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

export function GrantsBanner() {
  return (
    <a href="/grants" style={{ ...S.card, marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", textDecoration: "none" }}>
      <span style={{ color: B.white, fontWeight: 700 }}>Need help with rent, bills or food? Community grants are open — applying is free.</span>
      <span style={S.btnPrimary}>Apply for a grant</span>
    </a>
  );
}

export function TrustStrip() {
  const items = ["Methods published", "Data straight from the XRP Ledger", "We never hold your funds", "Never paid by what we grade"];
  return (
    <section aria-label="Our commitments" style={{ marginTop: 22, background: B.white, color: B.navy, borderRadius: 12, padding: "12px 14px", fontFamily: B.sans }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))", gap: "8px 16px", fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>
        {items.map((t) => <li key={t} style={{ display: "flex", gap: 7 }}><span aria-hidden="true" style={{ color: B.accent, fontWeight: 900 }}>✓</span>{t}</li>)}
      </ul>
    </section>
  );
}

export function GrantsTeaser() {
  const [bal, setBal] = useState<{ xrp: number; rlusd: number } | null>(null);
  useEffect(() => { fetch("/api/grants/pool").then((r) => r.json()).then((j) => setBal({ xrp: j.balanceXrp ?? 0, rlusd: j.rlusd?.balance ?? 0 })).catch(() => {}); }, []);
  return (
    <div style={S.card}>
      <div style={S.eyebrow}>Community grants</div>
      <h2 style={{ ...S.h2, marginTop: 6 }}>Grants are open. Applying is free.</h2>
      <p style={{ margin: "0 0 10px", lineHeight: 1.55 }}>
        Small grants for rent, bills, food or school, reviewed by a person and paid in RLUSD. The pool holds{" "}
        <strong style={{ color: B.white }}>{bal == null ? "…" : `${bal.rlusd.toLocaleString("en-US", { maximumFractionDigits: 2 })} RLUSD + ${bal.xrp.toLocaleString("en-US", { maximumFractionDigits: 2 })} XRP`}</strong>; the first 10 grants go out at 1,000 XRP (RLUSD counted at the XRP price). XRP donations are held in the pool.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="/grants#apply" style={S.btnPrimary}>Apply free</a>
        <a href="/grants/ledger" style={S.btnSecondary}>Every donation and grant</a>
      </div>
    </div>
  );
}

// ── The rest of the homepage, in the same cards ───────────────────────────────────────────────────────────────────
type Prod = { name: string; line: string; price: string; href?: string; onClick?: () => void; cta?: string };

export function ProductGrid({ onMptIssue }: { onMptIssue: () => void }) {
  const items: Prod[] = [
    { name: "Yield Desk", line: "Every way to earn on XRP and RLUSD we can verify, each with an A–F risk grade.", price: "Free", href: "/yield" },
    { name: "Lending tracker", line: "Is XRPL lending live yet? The validator vote, hour by hour.", price: "Free", href: "/lending" },
    { name: "Spend Controls", line: "Allowances that can only be spent where you pick, and recurring payments you approve.", price: "Free", href: "/spend" },
    { name: "Token check", line: "See what a token's creator can do: freeze it, take it back, or block you from selling.", price: "Free", href: "#mpt" },
    { name: "Wallet permissions", line: "Who can move money from your wallet? Find and remove old permissions.", price: "Free", href: "/permissions" },
    { name: "Batch Send", line: "Pay up to 8 people with one all-or-nothing approval.", price: "Free", href: "/send-many" },
    { name: "Issue a token (MPT)", line: "Build a Multi-Purpose Token with its backing declared on the ledger. You sign in your wallet.", price: "Free", onClick: onMptIssue },
    { name: "Community grants", line: "Small grants for rent, bills, food or school, paid in RLUSD. Applying is free.", price: "Free", href: "/grants" },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))", gap: 12, fontFamily: B.sans }}>
      {items.map((p) => (
        <ProductCard key={p.name} name={p.name} price={p.price} line={p.line}>
          {p.onClick
            ? <button onClick={p.onClick} style={S.btnPrimary}>{p.cta ?? "Use free"}</button>
            : <a href={p.href} style={S.btnPrimary}>{p.cta ?? "Use free"}</a>}
        </ProductCard>
      ))}
    </div>
  );
}

export function DevelopersSection() {
  return (
    <section id="api" style={{ ...S.card, scrollMarginTop: 80 }}>
      <div style={S.eyebrow}>For businesses, builders and AI agents</div>
      <h2 style={{ ...S.h2, marginTop: 6 }}>Ratings and wallet scores as an API</h2>
      <p style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
        Risk grades for XRP yield and XRPL lending at $0.02 per call (x402, no account), the wallet score API, sanctions screening, wallet alerts and an MCP server for AI agents.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="/developers" style={S.btnPrimary}>See the API</a>
        <a href="/pricing" style={S.btnSecondary}>Wallet score API pricing</a>
      </div>
    </section>
  );
}

export function HomeFaq() {
  const qa: [string, string][] = [
    ["Do I need to know crypto?", "No. If you have an XRP wallet like Xaman, you can use everything here."],
    ["Does XRPLHub ever hold my money?", "No. Your money stays in your wallet, and you approve every payment yourself. We never see your keys."],
    ["What's free?", "The wallet check, Yield Desk ratings, the lending tracker, Spend Controls, Token check, wallet permissions, Batch Send and grant applications. XRPLHub Pro and the grade API are paid."],
  ];
  return (
    <section id="faq" style={{ fontFamily: B.sans }}>
      <h2 style={S.h2}>Questions</h2>
      <div style={{ display: "grid", gap: 10 }}>
        {qa.map(([q, a]) => (
          <div key={q} style={S.card}>
            <h3 style={{ margin: "0 0 4px", color: B.white, fontSize: 17 }}>{q}</h3>
            <p style={{ margin: 0, lineHeight: 1.55 }}>{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
