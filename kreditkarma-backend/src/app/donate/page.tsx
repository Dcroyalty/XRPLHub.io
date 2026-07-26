"use client";

import { useState, useEffect } from "react";

const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF"; // corrected — was pointing at the wrong wallet entirely

export default function DonatePage() {
  const [stats, setStats] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/treasury-stats") // corrected — was hitting the dead duplicate route
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  function copyTreasury() {
    navigator.clipboard.writeText(TREASURY)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => { alert('Could not copy automatically — long-press the address to copy it manually.'); });
  }

  return (
    <main>
      <section className="hero" style={{ paddingTop: 80, paddingBottom: 32 }}>
        <div className="container">
          <h1>Donate to the Treasury</h1>
          <p>Every donation funds micro-grants for people in need. 100% on-chain. Multi-sig protected.</p>
        </div>
      </section>

      <div className="container">
        <div className="stats-grid">
          <div className="stat">
            <div className="stat-value">{stats?.totalDonations ?? 0}</div>
            <div className="stat-label">Donors</div>
          </div>
          <div className="stat">
            <div className="stat-value">${stats?.totalRaised ?? 0}</div>
            <div className="stat-label">Raised</div>
          </div>
          <div className="stat">
            <div className="stat-value">{stats?.grantsApproved ?? 0}</div>
            <div className="stat-label">Grants Funded</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 32 }}>
          <h2 style={{ marginBottom: 16 }}>Send XRP or RLUSD to Treasury</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
            Multi-signature treasury wallet (2-of-3). Send any amount of XRP or RLUSD.
          </p>
          <div className="treasury-display">{TREASURY}</div>
          <button onClick={copyTreasury} className="btn btn-primary">
            {copied ? "✓ Copied!" : "Copy Treasury Address"}
          </button>

          <div style={{ marginTop: 32, padding: 24, background: 'var(--bg)', borderRadius: 8 }}>
            <h3 style={{ marginBottom: 12, fontSize: 18 }}>How to Donate</h3>
            <ol style={{ paddingLeft: 20, color: 'var(--text-muted)', lineHeight: 2 }}>
              <li>Open your XRPL wallet (Xumm, XRPL Wallet, etc.)</li>
              <li>Send XRP or RLUSD to the treasury address above</li>
              <li>Donations are recorded on-chain and visible in our admin panel</li>
              <li>Funds are deployed as micro-grants to verified applicants</li>
            </ol>
          </div>
        </div>

        <div className="cta" style={{ paddingTop: 64 }}>
          <div className="cta-card">
            <h2>Need a Grant?</h2>
            <p>Apply for up to $1,000 in micro-grants for rent, utilities, groceries, or medical expenses.</p>
            <a href="mailto:grants@kreditkarma.us" className="btn btn-primary">Apply Now</a>
          </div>
        </div>
      </div>
    </main>
  );
}