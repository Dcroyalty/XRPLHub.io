// src/app/verify/screening/[address]/page.tsx
// Public, no-login verification page for an io.xrplhub.screen.v2.nomatch credential.
//
// This URL is the `URI` on that on-ledger XLS-70 credential — it IS the evidence anyone can check. It shows:
//   • the on-ledger credential (issuer, expiry, accepted status) read live from the validated ledger
//   • the most recent screening receipts XRPLHub has on file for this address
//
// HARD LINE: this credential — and every receipt behind it — attests to a PROCESS, never a conclusion. "No match" is
// not a statement that the address, or anyone associated with it, is clean, safe, lawful, or unsanctioned.

import { readCredential, EXPECTED_ISSUER } from "@/lib/credentials";
import { SCREEN_NOMATCH_TYPE, SCREEN_NOMATCH_TYPE_HEX, SCREEN_CRED_STATEMENT_NOTE } from "@/lib/screenCredential";
import { isValidXrplAddress } from "@/lib/address";
import { prisma } from "@/lib/xrplscore-db";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const EXPLORER = (acct: string) => `https://livenet.xrpl.org/accounts/${acct}`;
const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#070b14", color: "#e8ecf3", fontFamily: "'Inter', system-ui, sans-serif", padding: "40px 20px" };
const shell: React.CSSProperties = { maxWidth: 760, margin: "0 auto" };
const card: React.CSSProperties = { background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 18, padding: 24, marginBottom: 18 };
const mono: React.CSSProperties = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 12.5, wordBreak: "break-all" };
const dim = "rgba(232,236,243,.55)";

export default async function VerifyScreeningPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  const address = decodeURIComponent(raw ?? "").trim();

  if (!isValidXrplAddress(address)) {
    return (
      <div style={wrap}>
        <div style={shell}>
          <div style={card}>Not a valid XRP Ledger address. (This credential is XRPL-only, even though screening itself covers EVM, Bitcoin and Tron.)</div>
        </div>
      </div>
    );
  }

  const [cred, receipts] = await Promise.all([
    readCredential({ issuer: EXPECTED_ISSUER, subject: address, type: SCREEN_NOMATCH_TYPE_HEX }).catch(() => null),
    prisma.screeningReceipt.findMany({ where: { subjectAddress: address }, orderBy: { screenedAt: "desc" }, take: 5 }),
  ]);

  return (
    <div style={wrap}>
      <div style={shell}>
        <p style={{ fontSize: 12, color: dim, marginBottom: 4 }}>io.xrplhub.screen.v2.nomatch — verification</p>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, ...mono }}>{address}</h1>
        <a href={EXPLORER(address)} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#7dd3fc" }}>view on the XRPL explorer →</a>

        <div style={{ ...card, marginTop: 20 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>On-ledger credential</p>
          {cred?.found ? (
            <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
              <div>Issuer: <span style={mono}>{cred.issuer}</span></div>
              <div>Status: <strong style={{ color: cred.accepted ? "#4ade80" : "#fbbf24" }}>{cred.accepted ? (cred.expired ? "accepted, expired" : "accepted") : "pending — not yet accepted"}</strong></div>
              <div>Expires: {cred.expirationISO ?? "unknown"}</div>
              <div>Credential type: <span style={mono}>{SCREEN_NOMATCH_TYPE}</span></div>
            </div>
          ) : (
            <p style={{ fontSize: 13.5, color: dim }}>No {SCREEN_NOMATCH_TYPE} credential found for this address from XRPLHub&rsquo;s issuer ({EXPECTED_ISSUER}). A credential is 30 days old at most when valid — check whether one has simply expired, or was never requested (POST /api/credentials/screen-request).</p>
          )}
        </div>

        <div style={{ ...card, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.25)" }}>
          <p style={{ fontSize: 13, lineHeight: 1.8, color: "#fcd34d" }}>{SCREEN_CRED_STATEMENT_NOTE}</p>
          <p style={{ fontSize: 12.5, lineHeight: 1.8, color: dim, marginTop: 8 }}>{SCREEN_DISCLAIMER_SHORT}</p>
        </div>

        <div style={card}>
          <p style={{ fontSize: 11, fontWeight: 700, color: dim, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>Most recent screening receipts</p>
          {receipts.length === 0 && <p style={{ fontSize: 13, color: dim }}>None on file for this address.</p>}
          {receipts.map((r) => {
            const result = r.resultJson as { listed: boolean };
            const lists = r.listsJson as Array<{ name: string; vintage: string }>;
            return (
              <div key={r.queryId} style={{ borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 12, marginTop: 12 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: result.listed ? "#f87171" : "#4ade80" }}>{result.listed ? "Appeared on a list" : "No match"} — {r.screenedAt.toISOString()}</div>
                <div style={{ fontSize: 12, color: dim, marginTop: 4 }}>Checked against: {lists.map((l) => `${l.name}@${l.vintage}`).join(", ")}</div>
                <a href={`${VERIFY_BASE}${r.queryId}`} style={{ fontSize: 11.5, color: "#7dd3fc" }}>full receipt + inclusion proof →</a>
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11.5, color: dim, marginTop: 20 }}>
          Verify without trusting XRPLHub: read this account&rsquo;s <span style={mono}>Credential</span> ledger object directly (ledger_entry, issuer {EXPECTED_ISSUER}, credential_type {SCREEN_NOMATCH_TYPE_HEX}), and every receipt above at its own verify link (Merkle inclusion proof + on-ledger anchor).
        </p>
      </div>
    </div>
  );
}
