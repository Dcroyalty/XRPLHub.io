// src/app/verify/domain/[address]/page.tsx
// Public, no-login verification page for an io.xrplhub.domain.v1.verified credential.
//
// This URL is the `URI` on that on-ledger XLS-70 credential — it IS the evidence anyone can check. It shows:
//   • the on-ledger credential (issuer, expiry, accepted status) read live from the validated ledger
//   • the LIVE two-way check RIGHT NOW (the credential's guarantee is only as of issuance — this shows whether the
//     link still holds today, the same way the score verification page shows the live score next to a score credential)

import { readCredential, EXPECTED_ISSUER } from "@/lib/credentials";
import { DOMAIN_VERIFIED_TYPE, DOMAIN_VERIFIED_TYPE_HEX, DOMAIN_CRED_STATEMENT_NOTE, currentDeclaredDomain, verifySubjectDomainNow, NoDomainDeclaredError, DomainNotVerifiedError } from "@/lib/domainCredential";
import { isValidXrplAddress } from "@/lib/address";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EXPLORER = (acct: string) => `https://livenet.xrpl.org/accounts/${acct}`;

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#070b14", color: "#e8ecf3", fontFamily: "'Inter', system-ui, sans-serif", padding: "40px 20px" };
const shell: React.CSSProperties = { maxWidth: 760, margin: "0 auto" };
const card: React.CSSProperties = { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 18, padding: 24, marginBottom: 18 };
const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 12.5, wordBreak: "break-all" };
const dim = "rgba(232,236,243,.55)";

export default async function VerifyDomainPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  const address = decodeURIComponent(raw ?? "").trim();

  if (!isValidXrplAddress(address)) {
    return (
      <div style={wrap}>
        <div style={shell}>
          <div style={card}>Not a valid XRP Ledger address.</div>
        </div>
      </div>
    );
  }

  const [cred, live] = await Promise.all([
    readCredential({ issuer: EXPECTED_ISSUER, subject: address, type: DOMAIN_VERIFIED_TYPE_HEX }).catch(() => null),
    verifySubjectDomainNow(address)
      .then((r) => ({ ok: true as const, domain: r.domain, accountsListed: r.check.accountsListed }))
      .catch(async (e) => {
        const domain = await currentDeclaredDomain(address).catch(() => null);
        if (e instanceof NoDomainDeclaredError) return { ok: false as const, domain: null, reason: "No Domain field set on this account." };
        if (e instanceof DomainNotVerifiedError) return { ok: false as const, domain: e.domain, reason: e.check.reason };
        return { ok: false as const, domain, reason: "Could not complete the check right now." };
      }),
  ]);

  return (
    <div style={wrap}>
      <div style={shell}>
        <p style={{ fontSize: 12, color: dim, marginBottom: 4 }}>io.xrplhub.domain.v1.verified — verification</p>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, ...mono }}>{address}</h1>
        <a href={EXPLORER(address)} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#7dd3fc" }}>view on the XRPL explorer →</a>

        <div style={{ ...card, marginTop: 20 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>On-ledger credential</p>
          {cred?.found ? (
            <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
              <div>Issuer: <span style={mono}>{cred.issuer}</span></div>
              <div>Status: <strong style={{ color: cred.accepted ? "#4ade80" : "#fbbf24" }}>{cred.accepted ? (cred.expired ? "accepted, expired" : "accepted") : "pending — not yet accepted"}</strong></div>
              <div>Expires: {cred.expirationISO ?? "unknown"}</div>
              <div>Credential type: <span style={mono}>{DOMAIN_VERIFIED_TYPE}</span></div>
            </div>
          ) : (
            <p style={{ fontSize: 13.5, color: dim }}>No {DOMAIN_VERIFIED_TYPE} credential found for this account from XRPLHub&rsquo;s issuer ({EXPECTED_ISSUER}).</p>
          )}
        </div>

        <div style={card}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Live check, right now</p>
          {live.ok ? (
            <p style={{ fontSize: 13.5, lineHeight: 1.8 }}>
              <strong style={{ color: "#4ade80" }}>Verified today</strong> — this account&rsquo;s Domain field is <span style={mono}>{live.domain}</span>, and that domain&rsquo;s xrp-ledger.toml lists this exact account under <span style={mono}>[[ACCOUNTS]]</span> (alongside {live.accountsListed.length} other account(s)).
            </p>
          ) : (
            <p style={{ fontSize: 13.5, lineHeight: 1.8, color: "#fbbf24" }}>
              <strong>Not verified right now.</strong>{live.domain ? <> Declared domain: <span style={mono}>{live.domain}</span>.</> : null} {live.reason}
              {cred?.found && <> This may mean the link held at issuance but has since changed — the on-ledger credential above only guarantees the moment it was issued.</>}
            </p>
          )}
        </div>

        <div style={{ ...card, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.25)" }}>
          <p style={{ fontSize: 12.5, lineHeight: 1.8, color: dim }}>{DOMAIN_CRED_STATEMENT_NOTE}</p>
        </div>

        <p style={{ fontSize: 11.5, color: dim, marginTop: 20 }}>
          Verify without trusting XRPLHub: read this account&rsquo;s <span style={mono}>Domain</span> field and its <span style={mono}>Credential</span> ledger object directly (ledger_entry, issuer {EXPECTED_ISSUER}, credential_type {DOMAIN_VERIFIED_TYPE_HEX}), and fetch <span style={mono}>https://&lt;domain&gt;/.well-known/xrp-ledger.toml</span> yourself.
        </p>
      </div>
    </div>
  );
}
