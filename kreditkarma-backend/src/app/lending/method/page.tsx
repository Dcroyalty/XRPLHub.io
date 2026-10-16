// src/app/lending/method/page.tsx — the published risk-grade method. Rendered from RULES in
// src/lib/lendingGrade.ts, the same table the grading code applies, so the two can't drift apart.
import BrandLogo from "@/components/BrandLogo";
import type { Metadata } from "next";
import { RULES, METHOD_VERSION, DISCLAIMER } from "@/lib/lendingGrade";
import { L, C } from "../ui";

export const metadata: Metadata = {
  title: "How XRPLHub Grades XRPL Lending Vaults and Brokers (A–F Risk Grade Method) | XRPLHub",
  description: "The published method behind XRPLHub's A–F risk grades for XRP Ledger lending vaults and loan brokers: on-ledger data only, every rule and point value.",
  alternates: { canonical: "https://www.xrplhub.io/lending/method" },
};

export default function MethodPage() {
  const section = (applies: "broker" | "vault") => RULES.filter((r) => r.applies === applies);
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <nav style={{ ...L.nav, flexWrap: "wrap" }}>
          <BrandLogo />
          <span style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <a href="/lending" style={L.link}>← Lending tracker</a>
            <span style={L.small}>{METHOD_VERSION}</span>
            </span>
        </nav>
        <h1 style={L.h1}>How we grade lending vaults and loan brokers</h1>
        <p style={L.sub}>
          Every vault and loan broker on the XRP Ledger gets a risk grade from A to F. We use only what is public on the
          ledger — the vault, the broker, its loans and their payment status. Nothing is self-reported and nobody pays for a grade.
        </p>

        <div style={{ ...L.card, background: C.warnBg, borderColor: C.warnBorder }}>
          <p style={{ ...L.h2, fontSize: 15 }}>What a risk grade is not</p>
          <p style={{ margin: 0, fontSize: 14 }}>
            It is not a credit rating and says nothing about any borrower: XRPL loans have no collateral and the decision to lend
            is made off the ledger. It is not investment advice. A good grade can go bad quickly if borrowers stop paying.
          </p>
        </div>

        <div style={L.card}>
          <p style={L.h2}>The scale</p>
          <p style={{ margin: 0, fontSize: 15 }}>{RULES.find((r) => r.id === "BANDS")?.text}</p>
        </div>

        {(["broker", "vault"] as const).map((k) => (
          <div key={k} style={L.card}>
            <p style={L.h2}>{k === "broker" ? "Loan brokers (the managers who make the loans)" : "Vaults (where depositors' money sits)"}</p>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 15 }}>
              {section(k).map((r) => (
                <li key={r.id} style={{ margin: "8px 0" }}>
                  {r.text} <span style={{ ...L.mono, color: C.small }}>[{r.id}]</span>
                </li>
              ))}
            </ol>
          </div>
        ))}

        <div style={L.card}>
          <p style={L.h2}>Words we use</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
            <li style={{ margin: "5px 0" }}><strong>Utilization</strong>: the share of a vault that is lent out (total value minus what is available, over total value).</li>
            <li style={{ margin: "5px 0" }}><strong>Cover ratio</strong>: the broker&apos;s first-loss cover against what it must hold — its debt × its own minimum cover rate. 1.0× is exactly the minimum.</li>
            <li style={{ margin: "5px 0" }}><strong>Late</strong>: past the next payment due date. <strong>Impaired</strong>: the broker has flagged the loan as at risk. <strong>Defaulted</strong>: the broker has declared the loan in default.</li>
            <li style={{ margin: "5px 0" }}><strong>Realized yield</strong>: how much one vault share has gained or lost in value, annualized, measured over up to the last 30 days.</li>
          </ul>
        </div>

        <p style={L.small}>{DISCLAIMER} Grades are recomputed every hour once XRPL lending is live. Method version {METHOD_VERSION}; any change gets a new version number.</p>
      </div>
    </div>
  );
}
