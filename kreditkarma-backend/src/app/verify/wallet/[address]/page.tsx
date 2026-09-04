// src/app/verify/wallet/[address]/page.tsx
// Public, no-login verification page for an XRPLScore credential.
//
// This URL is the `URI` on the on-ledger XLS-70 credential — it IS the evidence
// anyone can check. It shows:
//   • the on-ledger credential (tier, CredentialType, issuer, issued, expires,
//     accepted status, tx) read live from the validated ledger
//   • the LIVE score right now, with the full 8-signal breakdown and the
//     methodology version
//
// The on-ledger (issuer, CredentialType, Expiration) is the authoritative
// attestation. The live score is shown so a reader can see how the wallet is
// scoring today vs the tier the credential guarantees.

import { scoreWallet, AccountNotFoundError, isValidXrplAddress, METHODOLOGY } from "@/lib/xrplscore";
import {
  readCredential,
  eligibleTier,
  credentialType,
  EXPECTED_ISSUER,
  type ScoreTier,
} from "@/lib/credentials";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TIERS: ScoreTier[] = ["min750", "min700", "min650", "min600"];
const EXPLORER = (acct: string) => `https://livenet.xrpl.org/accounts/${acct}`;

const wrap: React.CSSProperties = {
  minHeight: "100vh", background: "#070b14", color: "#e8ecf3",
  fontFamily: "'Inter', system-ui, sans-serif", padding: "40px 20px",
};
const shell: React.CSSProperties = { maxWidth: 720, margin: "0 auto" };
const card: React.CSSProperties = {
  background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)",
  borderRadius: 18, padding: 24, marginBottom: 18,
};
const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 12.5, wordBreak: "break-all" };
const dim = "rgba(232,236,243,.55)";

export default async function VerifyWalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  const address = decodeURIComponent(raw || "").trim();

  if (!isValidXrplAddress(address)) {
    return (
      <main style={wrap}><div style={shell}><div style={card}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Invalid address</h1>
        <p style={{ color: dim }}><code style={mono}>{address || "(none)"}</code> is not a valid XRPL classic address.</p>
      </div></div></main>
    );
  }

  // Live score
  let score: number | null = null;
  let grade = "";
  let breakdown: { label: string; score: number; weight: string; desc: string }[] = [];
  let scannedAt = new Date().toISOString();
  try {
    const s = await scoreWallet(address);
    score = s.ledgerScore;
    grade = s.grade;
    breakdown = s.breakdown;
  } catch (e) {
    if (!(e instanceof AccountNotFoundError)) throw e;
  }

  // On-ledger credential — find whichever tier exists from our issuer
  let cred: Awaited<ReturnType<typeof readCredential>> | null = null;
  for (const tier of TIERS) {
    try {
      const r = await readCredential({ issuer: EXPECTED_ISSUER, subject: address, type: credentialType(tier) });
      if (r.found) { cred = r; break; }
    } catch { /* try next tier */ }
  }

  const liveTier = eligibleTier(score);

  return (
    <main style={wrap}>
      <div style={shell}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: ".14em", textTransform: "uppercase", color: "#4ade80" }}>
            XRPLScore Credential · Verification
          </div>
          <a href="https://www.xrplhub.io" style={{ color: dim, fontSize: 12, textDecoration: "none" }}>XRPLHub.io ↗</a>
        </div>

        {/* ── The on-ledger attestation ── */}
        <div style={card}>
          <div style={{ fontSize: 12, color: dim, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 10 }}>
            On-ledger credential
          </div>
          {cred?.found ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 26, fontWeight: 900, color: "#4ade80" }}>{cred.credentialType.split(".").pop()}</span>
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                  background: cred.expired ? "rgba(248,113,113,.15)" : "rgba(74,222,128,.15)",
                  color: cred.expired ? "#f87171" : "#4ade80",
                }}>
                  {cred.expired ? "EXPIRED" : cred.accepted ? "ACCEPTED · CURRENT" : "ISSUED · not yet accepted by subject"}
                </span>
              </div>
              <Row k="CredentialType" v={cred.credentialType} m />
              <Row k="Issuer" v={<a href={EXPLORER(cred.issuer)} style={{ color: "#7dd3fc" }}>{cred.issuer}</a>} m />
              <Row k="Subject" v={<a href={EXPLORER(cred.subject)} style={{ color: "#7dd3fc" }}>{cred.subject}</a>} m />
              <Row k="Guarantee" v={`XRPLScore was ≥ ${cred.credentialType.replace(/.*min/, "")} at issuance`} />
              {cred.issuedApproxISO && <Row k="Issued" v={cred.issuedApproxISO.slice(0, 10)} />}
              {cred.expirationISO && <Row k="Expires" v={cred.expirationISO.slice(0, 10) + "  (90-day validity)"} />}
              {cred.uriDecoded && <Row k="URI" v={cred.uriDecoded} m />}
              <Row k="Read from" v={`validated ledger #${cred.ledgerIndex.toLocaleString()}`} />
              <p style={{ color: dim, fontSize: 12.5, lineHeight: 1.6, marginTop: 12, marginBottom: 0 }}>{cred.reason}</p>
              <p style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
                <a href={`https://livenet.xrpl.org/accounts/${cred.issuer}`} style={{ color: "#7dd3fc" }}>
                  Inspect the issuer on livenet.xrpl.org ↗
                </a>
              </p>
            </>
          ) : (
            <p style={{ color: dim, fontSize: 14, lineHeight: 1.6, margin: 0 }}>
              No XRPLScore credential has been issued to this wallet by{" "}
              <span style={mono}>{EXPECTED_ISSUER}</span>.
              {liveTier
                ? ` It currently scores in the ${liveTier} band.`
                : score == null
                ? " It is not an activated XRPL mainnet account."
                : ` It currently scores ${score}, below the 600 issuance floor.`}
            </p>
          )}
        </div>

        {/* ── The live score ── */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 }}>
            <div style={{ fontSize: 12, color: dim, textTransform: "uppercase", letterSpacing: ".1em" }}>Live score — right now</div>
            <div style={{ fontSize: 11, color: dim }}>{scannedAt.slice(0, 19).replace("T", " ")} UTC</div>
          </div>
          {score == null ? (
            <p style={{ color: dim, margin: "8px 0 0" }}>Not an activated XRPL mainnet account.</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "6px 0 16px" }}>
                <span style={{ fontSize: 44, fontWeight: 900, color: "#4ade80" }}>{score}</span>
                <span style={{ fontSize: 15, color: dim }}>/ 850 · {grade}</span>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {breakdown.map((b) => (
                  <div key={b.label} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", padding: "8px 0", borderTop: "1px solid rgba(255,255,255,.06)" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{b.label} <span style={{ color: dim, fontWeight: 400 }}>· {b.weight}</span></div>
                      <div style={{ fontSize: 11.5, color: dim, marginTop: 2 }}>{b.desc}</div>
                    </div>
                    <div style={{ minWidth: 92, textAlign: "right" }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{b.score}</span>
                      <span style={{ fontSize: 11, color: dim }}> / 100</span>
                      <div style={{ height: 4, background: "rgba(255,255,255,.08)", borderRadius: 3, marginTop: 3 }}>
                        <div style={{ height: "100%", width: `${b.score}%`, background: "#4ade80", borderRadius: 3 }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <p style={{ color: dim, fontSize: 11.5, lineHeight: 1.6, marginTop: 14, marginBottom: 0 }}>
            Methodology: <strong style={{ color: "#e8ecf3" }}>{METHODOLOGY}</strong>. Weights and formulas are
            published in the repository (<code style={mono}>src/lib/xrplscore.ts</code>) and{" "}
            <code style={mono}>docs/XRPLSCORE-CALIBRATION.md</code>. The credential above encodes a threshold
            guarantee frozen at issuance; this live score can drift and is corrected by the 90-day expiry.
          </p>
        </div>

        <p style={{ color: dim, fontSize: 11.5, textAlign: "center", marginTop: 8 }}>
          Anyone can independently verify: <code style={mono}>ledger_entry</code> on{" "}
          <code style={mono}>{"{ credential: { subject, issuer, credential_type } }"}</code> against the validated ledger.
        </p>
      </div>
    </main>
  );
}

function Row({ k, v, m }: { k: string; v: React.ReactNode; m?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12, padding: "5px 0", fontSize: 13 }}>
      <div style={{ color: dim }}>{k}</div>
      <div style={m ? mono : undefined}>{v}</div>
    </div>
  );
}
