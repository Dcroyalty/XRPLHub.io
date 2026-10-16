// src/app/lending/GradePanel.tsx — the grade box shared by the vault and broker pages (server component).
import { RULES, DISCLAIMER } from "@/lib/lendingGrade";
import type { StoredGrade } from "./explorer";
import { GRADE_COLOR } from "./explorer";
import { L, C, fmtTime, fmtDate } from "./ui";

export default function GradePanel({ g, history }: { g: StoredGrade | null; history: { grade: string; takenAt: Date }[] }) {
  if (!g) return <div style={L.card}><p style={{ margin: 0 }}>Not graded yet — the next hourly run will grade it.</p></div>;
  const ruleText = (id: string) => RULES.find((r) => r.id === id)?.text ?? id;
  const changes = history.filter((h, i) => i === 0 || h.grade !== history[i - 1].grade);
  return (
    <div style={L.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ fontSize: 48, fontWeight: 900, lineHeight: 1, color: GRADE_COLOR[g.grade] ?? C.fg }} aria-label={`Risk grade ${g.grade}`}>{g.grade}</div>
        <div>
          <div style={{ fontWeight: 700 }}>Risk grade{g.score >= 0 ? ` · ${g.score}/100` : ""}</div>
          <div style={L.small}>Updated {fmtTime(g.takenAt.toISOString())} · <a href="/lending/method" style={L.link}>method</a></div>
        </div>
      </div>
      {g.adjustments.length > 0 && (
        <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 14 }}>
          {g.adjustments.map((a, i) => (
            <li key={i} style={{ margin: "5px 0" }} title={ruleText(a.rule)}>
              {a.points !== 0 && <strong style={{ color: C.no }}>{a.points} </strong>}
              {a.why}
            </li>
          ))}
        </ul>
      )}
      {changes.length > 1 && (
        <p style={{ ...L.small, marginTop: 10 }}>
          Last 30 days: {changes.map((c) => `${c.grade} (${fmtDate(c.takenAt.toISOString())})`).join(" → ")}
        </p>
      )}
      <p style={{ ...L.small, marginTop: 10 }}>{DISCLAIMER}</p>
    </div>
  );
}
