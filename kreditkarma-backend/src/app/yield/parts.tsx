// src/app/yield/parts.tsx — shared pieces for the /yield pages (server components). Same look as /lending.
import { L, C, fmtTime } from "../lending/ui";
import { DISCLAIMER, pct, usd } from "@/lib/yieldGrade";
import type { StoredYield } from "@/lib/yieldDesk";

export const GRADE_COLOR: Record<string, string> = { A: "#047857", B: "#0f766e", C: "#a16207", D: "#c2410c", F: "#b91c1c" };

export const CUSTODY_WORDS: Record<StoredYield["custody"], string> = {
  self: "You hold it",
  contract: "Smart contract",
  custodian: "A company",
  exchange: "An exchange",
};

/** On every /yield page, near the top. */
export function Disclaimer() {
  return (
    <div style={{ ...L.card, background: C.warnBg, borderColor: C.warnBorder, padding: "10px 14px" }}>
      <p style={{ margin: 0, fontSize: 13 }}>
        <strong>General information for everyone, not personal advice.</strong> We are never paid by the products we grade
        and take no commission on deposits. A risk grade is not a credit rating or a recommendation.
      </p>
    </div>
  );
}

export function YieldNav({ back }: { back?: { href: string; label: string } }) {
  return (
    <nav style={L.nav}>
      <a href={back?.href ?? "/"} style={L.link}>← {back?.label ?? "XRPLHub"}</a>
      <span style={{ display: "flex", gap: 14 }}>
        <a href="/yield" style={L.link}>Yield Desk</a>
        <a href="/yield/method" style={L.link}>Method</a>
      </span>
    </nav>
  );
}

export function GradeBadge({ grade, size = 34 }: { grade: string; size?: number }) {
  return (
    <span
      aria-label={`Risk grade ${grade}`}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: 8, flex: "0 0 auto", background: GRADE_COLOR[grade] ?? C.fg, color: "#fff", fontWeight: 900, fontSize: size * 0.55 }}
    >
      {grade}
    </span>
  );
}

/** One option in the table: a card, readable at 360px wide. */
export function OptionCard({ o, listed = true }: { o: StoredYield; listed?: boolean }) {
  const g = o.gradeDetail;
  return (
    <a href={`/yield/${o.slug}`} style={{ ...L.card, display: "block", color: C.fg, textDecoration: "none", padding: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <GradeBadge grade={g.grade} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.3 }}>{o.name}</div>
          <div style={L.small}>{o.chain} · {o.asset}{!listed ? " · no longer listed by its source" : ""}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: "8px 12px", marginTop: 10, fontSize: 13 }}>
        <Fact label="Rate" value={o.rate == null ? "not yet" : pct(o.rate)} strong />
        <Fact label="Size" value={o.sizeNote ? "exchange" : usd(o.tvlUsd)} />
        <Fact label="Keys" value={CUSTODY_WORDS[o.custody]} />
        <Fact label="Withdraw" value={o.withdrawShort} />
      </div>
      <div style={{ ...L.small, marginTop: 8 }}>{o.rateKind} · as of {fmtTime(o.source.at)}</div>
    </a>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ color: C.small, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: strong ? 800 : 600, fontSize: strong ? 16 : 13 }}>{value}</div>
    </div>
  );
}

export { DISCLAIMER, pct, usd };
