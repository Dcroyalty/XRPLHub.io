export const metadata = {
  title: "Sanctions Screening Attestation — Scope & Limits | XRPLHub",
  description:
    "Which sanctions lists XRPLHub screens (OFAC SDN, EU, UK), what each really contains, what a result means and does not mean, retention, and the limits of use.",
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
          Sanctions Screening Attestation — Scope &amp; Limits
        </h1>
        <p
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,.28)",
            marginBottom: 36,
            fontFamily: "'IBM Plex Mono',monospace",
          }}
        >
          XRPLHub.io · canonVersion sanctions-screen-v2 · engineVersion sanction-screen-v2 · earlier receipts: ofac-screen-v1 / sanction-screen-v1 (OFAC only, retained unchanged)
        </p>

        <span style={H}>What this is</span>
        <p style={P}>
          Each screening attestation records a factual comparison performed at a stated time: one blockchain address
          (XRP Ledger, EVM, Bitcoin or Tron) was compared, by exact address-string match on its own chain, against a
          named snapshot of each of the sanctions lists listed below. Every receipt names <span style={B}>every list it
          used</span>, that list&rsquo;s published version (vintage), the SHA-256 hash of the exact content screened, and
          how many addresses that list names on the subject&rsquo;s chain. The attestation reports, per list, whether the
          address string appeared (a &ldquo;match&rdquo;, with the entry identifier) or did not. Receipts are recorded in
          a Merkle tree whose root is written to the XRP Ledger, so anyone can verify a receipt without trusting XRPLHub.
        </p>

        <span style={H}>The lists — and what each really contains</span>
        <p style={P}>
          <span style={B}>OFAC SDN</span> (U.S. Treasury) — digital-currency addresses are structured identifiers on SDN
          entries, for about 20 currencies. Screened here on the XRP Ledger, EVM, Bitcoin and Tron; addresses on other
          chains are kept in the archive but a query on those chains is refused.
        </p>
        <p style={P}>
          <span style={B}>EU consolidated financial sanctions list</span> (European Commission, FISMA) — a name/entity
          list. It names crypto addresses only as free text in a few designations&rsquo; remarks. Screening against it is
          therefore partial by nature: it covers only the addresses the Council chose to write down.
        </p>
        <p style={P}>
          <span style={B}>UK Sanctions List</span> (Foreign, Commonwealth &amp; Development Office; the OFSI Consolidated
          List was closed on 28 January 2026) — likewise name/entity-based, with a few addresses in free text. Partial by
          nature.
        </p>
        <p style={P}>
          <span style={B}>Not screened:</span> the United Nations Security Council consolidated list, which names no
          crypto addresses. We do not claim address screening against it. The live state of every list (vintage, hash,
          addresses per chain, when last confirmed) is published at <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>GET /api/screen/lists</span>.
        </p>

        <span style={H}>What a result means — and does not mean</span>
        <p style={P}>
          A &ldquo;match&rdquo; means only that the address string is present on the identified list snapshot. A
          &ldquo;no match&rdquo; means only that the address string was not present on those snapshots at the versions
          named in the receipt. <span style={B}>A &ldquo;no match&rdquo; is not a statement</span> that the address, or any
          person or entity associated with it, is clean, safe, lawful, unsanctioned, or low-risk. The attestation
          attests to a process, not to ground truth. It does not identify the owner or controller of any address, does
          not assess risk, does not screen any list other than those named, does not match names, aliases or partial
          addresses, does not perform transaction-graph or counterparty analysis, and draws no conclusion and makes no
          recommendation. A list can name a person without naming any address; such a person is invisible to address
          screening.
        </p>

        <span style={H}>Not advice, not a compliance function</span>
        <p style={P}>
          XRPLHub is not a bank, money services business, crypto-asset service provider or other regulated financial
          institution, and performs no regulated screening, monitoring, reporting, or decision-making function on your
          behalf. Nothing provided by XRPLHub is legal, regulatory, or compliance advice. <span style={B}>XRPLHub does not
          state that any use of this service is compliant with MiCA, the Travel Rule (Regulation (EU) 2023/1113), any
          sanctions regime or any other law, and using it does not satisfy, discharge, transfer, or reduce any
          obligation you have.</span> If you are a regulated firm, using a tool like this is an outsourcing or
          tooling decision that remains your responsibility; you keep ultimate responsibility for your compliance
          programme, for every screening and transaction decision, and for independently confirming any result before
          relying on it.
        </p>

        <span style={H}>Accuracy, timeliness and failure behaviour</span>
        <p style={P}>
          Lists change without notice. XRPLHub refreshes each list once a day (about 06:00 UTC). A designation
          published in between is not reflected until the next refresh; a result is accurate only as of the list
          versions and the moment stated in the receipt. Continuous monitoring re-screens watched addresses on the same
          daily cycle. Screening <span style={B}>fails closed</span>: if any list has no snapshot, or a supplied address
          is not valid on a supported chain, the request is refused (HTTP 503 / 400) — it is never answered by
          silently checking fewer lists or by reporting an unsupported address as &ldquo;not listed&rdquo;. A new list
          snapshot that looks broken (far smaller than the previous one, or empty) is refused and an operator is
          alerted; the previous snapshot stays in force and its age is visible.
        </p>

        <span style={H} id="retention">Retention</span>
        <p style={P}>
          XRPLHub retains every screening receipt, its canonical leaf, the data needed to rebuild its Merkle inclusion
          proof, its on-ledger anchor record, and the archive of every list snapshot a receipt refers to, for{" "}
          <span style={B}>at least 10 years</span> from the date of the screening. No process at XRPLHub prunes, edits or
          deletes a receipt or a list snapshot; the retention code <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>retain-10y-no-prune/v1</span>{" "}
          is written into every receipt. This is XRPLHub&rsquo;s storage commitment only. It does not discharge your own
          record-keeping duty (for example five years under Article 68(9) of Regulation (EU) 2023/1114 and the EU AML
          record-keeping rules, which can be extended by the authority). Export your receipts with{" "}
          <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>GET /api/attest/export</span> (JSON or CSV, with
          inclusion proofs and anchor transactions) and keep your own copy. Personal data is not requested: the optional{" "}
          <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>reference</span> field is for an opaque identifier
          (for example a transfer id) — do not put names or other personal data in it.
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
          The frozen canonicalisation specs are published at{" "}
          <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>GET /api/attest/anchor</span>.
        </p>
      </div>
    </div>
  );
}
