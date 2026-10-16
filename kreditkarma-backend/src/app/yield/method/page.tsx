// src/app/yield/method/page.tsx — the published risk-grade method for the XRP Yield Desk. Rendered from RULES in
// src/lib/yieldGrade.ts, the same table the grading code applies, so the two can't drift apart.
import type { Metadata } from "next";
import { RULES, METHOD_VERSION } from "@/lib/yieldGrade";
import { L, C } from "../../lending/ui";
import VisitBeacon from "../VisitBeacon";
import { Disclaimer, YieldNav } from "../parts";

export const metadata: Metadata = {
  title: "How XRPLHub Grades XRP and RLUSD Yield (A–F Risk Grade Method) | XRPLHub",
  description: "The published method behind the XRP Yield Desk's A–F risk grades: custody, contract and bridge risk, size, age, audits, track record, concentration — every rule and point value.",
  alternates: { canonical: "https://www.xrplhub.io/yield/method" },
};

export default function YieldMethodPage() {
  const factors = [...new Set(RULES.filter((r) => r.id !== "BANDS").map((r) => r.factor))];
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <YieldNav back={{ href: "/yield", label: "Yield Desk" }} />
        <VisitBeacon path="/yield/method" />
        <h1 style={L.h1}>How we grade ways to earn on XRP and RLUSD</h1>
        <p style={L.sub}>
          Every option on the Yield Desk gets a risk grade from A to F. The grade counts how many things stand between you and
          your money, judged only from public data: who holds the keys, how many contracts and bridges are involved, how big and
          how old it is, whether it has been audited, how its rate and size have behaved, and how concentrated it is.
        </p>
        <Disclaimer />

        <div style={{ ...L.card, background: C.warnBg, borderColor: C.warnBorder }}>
          <p style={{ ...L.h2, fontSize: 15 }}>What a risk grade is not</p>
          <p style={{ margin: 0, fontSize: 14 }}>
            It is not advice, a recommendation or a credit rating, and it does not say whether a rate is worth it for you. A high
            grade means fewer visible risks, not no risk. Nobody pays for a grade, we take no commission on deposits, and every
            product is graded with the same rules.
          </p>
        </div>

        <div style={L.card}>
          <p style={L.h2}>The scale</p>
          <p style={{ margin: 0, fontSize: 15 }}>{RULES.find((r) => r.id === "BANDS")?.text}</p>
        </div>

        {factors.map((f) => (
          <div key={f} style={L.card}>
            <p style={L.h2}>{f}</p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15 }}>
              {RULES.filter((r) => r.factor === f).map((r) => (
                <li key={r.id} style={{ margin: "7px 0" }}>{r.text} <span style={{ ...L.mono, color: C.small }}>[{r.id}]</span></li>
              ))}
            </ul>
          </div>
        ))}

        <div style={L.card}>
          <p style={L.h2}>Where the numbers come from</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
            <li style={{ margin: "5px 0" }}><strong>XRPL AMM pools:</strong> the pool&apos;s size from the ledger (amm_info); fee income by adding up the trading fee on every trade through the pool over the last 7 days.</li>
            <li style={{ margin: "5px 0" }}><strong>Doppler Finance:</strong> its public API — vault balances and the rate it paid each week.</li>
            <li style={{ margin: "5px 0" }}><strong>Firelight stXRP:</strong> the vault contract on Flare, read directly. The rate is how much one stXRP share has grown, per year.</li>
            <li style={{ margin: "5px 0" }}><strong>Other DeFi:</strong> DefiLlama&apos;s public yields API (rates, size, reward share) and protocol list (audits, age).</li>
            <li style={{ margin: "5px 0" }}><strong>Exchanges:</strong> their public rate pages. Exchanges don&apos;t publish per-product size, so we use the exchange&apos;s total on-chain reserves.</li>
            <li style={{ margin: "5px 0" }}><strong>XRPL lending vaults</strong> (once live): graded with the <a href="/lending/method" style={L.link}>XRPL Lending method</a>, which looks at the loans themselves.</li>
          </ul>
          <p style={{ ...L.small, marginTop: 10 }}>Everything refreshes every hour. Track-record rules start applying once we have 14 days of our own readings.</p>
        </div>

        <p style={L.small}>Method version {METHOD_VERSION}; any change to a rule or a point value gets a new version number.</p>
      </div>
    </div>
  );
}
