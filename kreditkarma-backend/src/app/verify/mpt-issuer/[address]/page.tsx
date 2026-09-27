// src/app/verify/mpt-issuer/[address]/page.tsx
// Public, no-login verification page for an io.xrplhub.mpt.v1.declared credential.
//
// This URL is the `URI` on that on-ledger XLS-70 credential — it IS the evidence anyone can check. It shows:
//   • the on-ledger credential (issuer, expiry, accepted status) read live from the validated ledger
//   • every MPT this account has issued, with its backing declaration, read from the registry index
//
// HARD LINE: the credential attests only that a declaration was RECORDED at issuance time — never that it is true,
// never "reviewed", never "verified". This page repeats that on every declaration it shows.

import { readCredential, EXPECTED_ISSUER } from "@/lib/credentials";
import { MPT_DECLARED_TYPE, MPT_DECLARED_TYPE_HEX } from "@/lib/mptCredential";
import { isValidXrplAddress } from "@/lib/address";
import { prisma } from "@/lib/xrplscore-db";
import { backingDeclarationView, BACKING_HARD_LINE } from "@/lib/mptBacking";
import { decodeMptFlags } from "@/lib/mptIndex";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EXPLORER = (acct: string) => `https://livenet.xrpl.org/accounts/${acct}`;

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#070b14", color: "#e8ecf3", fontFamily: "'Inter', system-ui, sans-serif", padding: "40px 20px" };
const shell: React.CSSProperties = { maxWidth: 760, margin: "0 auto" };
const card: React.CSSProperties = { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 18, padding: 24, marginBottom: 18 };
const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 12.5, wordBreak: "break-all" };
const dim = "rgba(232,236,243,.55)";

export default async function VerifyMptIssuerPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  const address = decodeURIComponent(raw ?? "").trim();

  if (!isValidXrplAddress(address)) {
    return (
      <div style={wrap}>
        <div style={shell}>
          <div style={card}>Not a valid XRPL address.</div>
        </div>
      </div>
    );
  }

  const [cred, rows] = await Promise.all([
    readCredential({ issuer: EXPECTED_ISSUER, subject: address, type: MPT_DECLARED_TYPE_HEX }).catch(() => null),
    prisma.indexedMPT.findMany({ where: { issuer: address }, orderBy: { lastSeenAt: "desc" } }),
  ]);

  return (
    <div style={wrap}>
      <div style={shell}>
        <p style={{ fontSize: 12, color: dim, marginBottom: 4 }}>io.xrplhub.mpt.v1.declared — verification</p>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, ...mono }}>{address}</h1>
        <a href={EXPLORER(address)} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#7dd3fc" }}>view on the XRPL explorer →</a>

        <div style={{ ...card, marginTop: 20 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>On-ledger credential</p>
          {cred?.found ? (
            <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
              <div>Issuer: <span style={mono}>{cred.issuer}</span></div>
              <div>Status: <strong style={{ color: cred.accepted ? "#4ade80" : "#fbbf24" }}>{cred.accepted ? (cred.expired ? "accepted, expired" : "accepted") : "pending — not yet accepted"}</strong></div>
              <div>Expires: {cred.expirationISO ?? "unknown"}</div>
              <div>Credential type: <span style={mono}>{MPT_DECLARED_TYPE}</span></div>
            </div>
          ) : (
            <p style={{ fontSize: 13.5, color: dim }}>No {MPT_DECLARED_TYPE} credential found for this account from XRPLHub&rsquo;s issuer ({EXPECTED_ISSUER}).</p>
          )}
        </div>

        <div style={{ ...card, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.25)" }}>
          <p style={{ fontSize: 13, lineHeight: 1.8, color: "#fcd34d" }}>{BACKING_HARD_LINE}</p>
          <p style={{ fontSize: 12.5, lineHeight: 1.8, color: dim, marginTop: 8 }}>
            This credential attests only that a declaration (and the issuer flags below) were <strong>recorded</strong> on-ledger through XRPLHub, at the time it was issued — never that any declaration is true, and never that every MPT this account has issued carries one. An issuer can mint further MPTs later with a different declaration, or none.
          </p>
        </div>

        <div style={card}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>MPTs issued by this account ({rows.length})</p>
          {rows.length === 0 && <p style={{ fontSize: 13, color: dim }}>None indexed yet.</p>}
          {rows.map((r) => {
            const bd = backingDeclarationView(r.metadata);
            const powers = decodeMptFlags(r.flagsRaw);
            return (
              <div key={r.issuanceId} style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 12, marginTop: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{r.name || r.ticker || r.issuanceId}</div>
                <div style={{ ...mono, fontSize: 11, color: dim, marginBottom: 6 }}>{r.issuanceId}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "rgba(232,236,243,.8)" }}>
                  {bd.declared ? (
                    <>
                      Backing type: <strong>{bd.declared.backingType}</strong> — &ldquo;{bd.declared.backingStatement}&rdquo;
                      {bd.declared.verifiedBy && <> · claims verification by: {bd.declared.verifiedBy}</>}
                      <br />
                      Redeemable: {bd.declared.redeemable} ·{" "}
                    </>
                  ) : (
                    <>No backing declaration in this issuance&rsquo;s metadata (not a statement about whether it is backed). </>
                  )}
                  Transferable: {String(powers.transferable)} · Clawback: {String(powers.clawback)} · Can freeze: {String(powers.canFreeze)} · Requires auth: {String(powers.requiresAuth)}
                </div>
                <a href={`/api/mpt/${r.issuanceId}`} style={{ fontSize: 11.5, color: "#7dd3fc" }}>full issuance detail →</a>
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11.5, color: dim, marginTop: 20 }}>
          Verify without trusting XRPLHub: read this account&rsquo;s <span style={mono}>Credential</span> ledger object directly (ledger_entry, issuer {EXPECTED_ISSUER}, credential_type {MPT_DECLARED_TYPE_HEX}), and every MPT&rsquo;s <span style={mono}>MPTokenMetadata</span> on the validated ledger.
        </p>
      </div>
    </div>
  );
}
