export const metadata = {
  title: "OFAC SDN Screening Attestation — Scope & Limits | XRPLHub",
  description:
    "What an XRPLHub OFAC SDN screening attestation is, what a result means and does not mean, and the limits of its use.",
};

export default function ScreeningLegalPage() {
  const H = {
    color: "#10b981",
    fontWeight: 800 as const,
    fontSize: 13,
    textTransform: "uppercase" as const,
    letterSpacing: ".04em",
    marginTop: 30,
    marginBottom: 8,
    display: "block" as const,
  };
  const P = { fontSize: 14, color: "rgba(255,255,255,.62)", lineHeight: 1.85 as const, marginBottom: 10 };
  const B = { color: "#eeeef5", fontWeight: 700 as const };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#030310",
        color: "#eeeef5",
        fontFamily: "'Syne',sans-serif",
        padding: "0 0 80px",
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box;margin:0;padding:0}`}</style>

      <nav
        style={{
          background: "rgba(3,4,14,.9)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(16,185,129,.18)",
          padding: "0 24px",
          height: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          position: "sticky",
          top: 0,
          zIndex: 100,
        }}
      >
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#fff" }}>
          <div
            style={{
              width: 32,
              height: 32,
              background: "linear-gradient(135deg,#10b981,#059669)",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: 15,
              color: "#000",
            }}
          >
            X
          </div>
          <span style={{ fontWeight: 900, fontSize: 17, letterSpacing: "-.5px" }}>XRPLHub</span>
        </a>
        <a href="/" style={{ fontSize: 13, color: "#10b981", textDecoration: "none", fontWeight: 600 }}>
          ← Back to Home
        </a>
      </nav>

      <div style={{ maxWidth: 780, margin: "0 auto", padding: "52px 24px 0" }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#10b981",
            letterSpacing: ".14em",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Legal
        </div>
        <h1 style={{ fontSize: "clamp(26px,5vw,40px)", fontWeight: 900, letterSpacing: "-1.5px", marginBottom: 8 }}>
          OFAC SDN Screening Attestation — Scope &amp; Limits
        </h1>
        <p
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,.28)",
            marginBottom: 36,
            fontFamily: "'IBM Plex Mono',monospace",
          }}
        >
          XRPLHub.io · canonVersion ofac-screen-v1 · engineVersion sanction-screen-v1
        </p>

        <span style={H}>What this is</span>
        <p style={P}>
          Each screening attestation records a single factual comparison performed at a stated time: one XRP Ledger
          address was compared against one snapshot of the U.S. Treasury Office of Foreign Assets Control Specially
          Designated Nationals and Blocked Persons (OFAC SDN) list, identified by its OFAC-published version and by the
          SHA-256 hash of the exact list file XRPLHub screened against. The attestation reports one of two outcomes: the
          address string appeared on that list snapshot (a &ldquo;match&rdquo;, with the OFAC entry identifier), or it did
          not appear on that list snapshot (a &ldquo;no match&rdquo;).
        </p>

        <span style={H}>What a result means — and does not mean</span>
        <p style={P}>
          A &ldquo;match&rdquo; means only that the address string is present on the identified OFAC SDN list snapshot. A
          &ldquo;no match&rdquo; means only that the address string was not present on that snapshot at the version named
          in the receipt. <span style={B}>A &ldquo;no match&rdquo; is not a statement</span> that the address, or any
          person or entity associated with it, is clean, safe, lawful, unsanctioned, or low-risk. This attestation does
          not identify the owner or controller of any address, does not assess risk, does not screen against any list
          other than the one named, does not perform transaction-graph or counterparty analysis, and draws no conclusion
          and makes no recommendation.
        </p>

        <span style={H}>Not advice, not a compliance function</span>
        <p style={P}>
          XRPLHub is not a bank, money services business, or other regulated financial institution, and performs no
          regulated screening, monitoring, reporting, or decision-making function on your behalf. Nothing provided by
          XRPLHub is legal, regulatory, or compliance advice. Obtaining or presenting an XRPLHub screening attestation
          does not satisfy, discharge, transfer, or reduce any obligation you may have under any sanctions,
          anti-money-laundering, counter-terrorist-financing, know-your-customer, or other law or regulation in any
          jurisdiction. You remain solely and fully responsible for your own compliance program, for every screening and
          transaction decision you make, and for independently confirming any result before you rely on it.
        </p>

        <span style={H}>Accuracy and timeliness</span>
        <p style={P}>
          The OFAC SDN list changes without notice. A result is accurate only as of the list version and the moment
          stated in the receipt. XRPLHub screens against the SDN list only; it does not screen against the OFAC
          Consolidated (non-SDN) list, sectoral sanctions identifications, the OFAC 50 Percent Rule, or the sanctions
          lists of the European Union, the United Kingdom, the United Nations, or any other authority. XRPLHub performs
          exact matching of the address string as published by OFAC only — no name, alias, vessel, aircraft, or fuzzy
          matching.
        </p>

        <span style={H}>No warranty, no liability</span>
        <p style={P}>
          The attestation is provided &ldquo;as is&rdquo;. To the fullest extent permitted by law, XRPLHub disclaims all
          warranties, express or implied, and all liability for any loss or damage arising from use of, or reliance on,
          any screening attestation.
        </p>

        <p style={{ ...P, marginTop: 32, fontSize: 12, color: "rgba(255,255,255,.34)" }}>
          Verify any receipt without trusting XRPLHub:{" "}
          <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>GET /api/attest/verify?queryId=&lt;uuid&gt;</span>.
          The frozen canonicalisation spec is published at{" "}
          <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>GET /api/attest/anchor</span>.
        </p>
      </div>
    </div>
  );
}
