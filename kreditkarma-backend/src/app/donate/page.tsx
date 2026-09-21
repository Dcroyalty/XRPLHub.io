"use client";

import { useState, useEffect } from "react";
import { GRANT_APPLICATIONS_OPEN, GRANTS_PAUSED_TITLE, GRANTS_PAUSED_MESSAGE } from "@/lib/grantsStatus";

const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";

// Shape of GET /api/treasury-stats (only the fields shown here). Every figure comes from the live ledger.
interface TreasuryStats {
  totalXRP?: number;
  spendableXRP?: number;
  grantsPaid?: number;
  grantsAwaitingFunds?: number;
}

export default function DonatePage() {
  const [stats, setStats] = useState<TreasuryStats | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/treasury-stats")
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  function copyTreasury() {
    navigator.clipboard.writeText(TREASURY)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => { alert('Could not copy automatically — long-press the address to copy it manually.'); });
  }

  const num = (v: number | undefined) => (typeof v === "number" ? String(v) : "—");

  return (
    <main>
      <section className="hero" style={{ paddingTop: 80, paddingBottom: 32 }}>
        <div className="container">
          <h1>Donate to the Treasury</h1>
          <p>Donations go to the public treasury address below. Every payment is a public XRPL transaction you can check yourself.</p>
        </div>
      </section>

      <div className="container">
        <div className="stats-grid">
          <div className="stat">
            <div className="stat-value">{stats ? `${num(stats.spendableXRP)} XRP` : '—'}</div>
            <div className="stat-label">Spendable now</div>
          </div>
          <div className="stat">
            <div className="stat-value">{stats ? num(stats.grantsPaid) : '—'}</div>
            <div className="stat-label">Grants paid</div>
          </div>
          <div className="stat">
            <div className="stat-value">{stats ? num(stats.grantsAwaitingFunds) : '—'}</div>
            <div className="stat-label">Approved, waiting for funds</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 32 }}>
          <h2 style={{ marginBottom: 16 }}>Send XRP or RLUSD to the Treasury</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
            Send any amount of XRP or RLUSD to this XRPL address. Its balance and every payment are public.
          </p>
          <div className="treasury-display">{TREASURY}</div>
          <button onClick={copyTreasury} className="btn btn-primary">
            {copied ? "✓ Copied!" : "Copy Treasury Address"}
          </button>
          <p style={{ marginTop: 12, fontSize: 13 }}>
            <a href={`https://xrpscan.com/account/${TREASURY}`} target="_blank" rel="noopener noreferrer">View the treasury on XRPScan ↗</a>
          </p>

          <div style={{ marginTop: 32, padding: 24, background: 'var(--bg)', borderRadius: 8 }}>
            <h3 style={{ marginBottom: 12, fontSize: 18 }}>How to Donate</h3>
            <ol style={{ paddingLeft: 20, color: 'var(--text-muted)', lineHeight: 2 }}>
              <li>Open your XRPL wallet (Xaman, or any XRPL wallet)</li>
              <li>Send XRP or RLUSD to the treasury address above</li>
              <li>Your payment shows up on the public ledger — you can see it on XRPScan</li>
              <li>Grants are approved by a person and paid from the treasury when it holds enough to pay them</li>
            </ol>
          </div>
        </div>

        <div className="cta" style={{ paddingTop: 64 }}>
          <div className="cta-card">
            {GRANT_APPLICATIONS_OPEN ? (
              <>
                <h2>Need a Grant?</h2>
                <p>Apply for a $25–$100 micro-grant for rent, utilities, groceries, or medical expenses. A person reviews every application.</p>
                <a href="/#grants" className="btn btn-primary">Apply Now</a>
              </>
            ) : (
              <>
                <h2>{GRANTS_PAUSED_TITLE}</h2>
                <p>{GRANTS_PAUSED_MESSAGE}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
