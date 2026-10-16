"use client";
// The free grade-change alerts form. Posts to /api/yield/signup. `slug` limits alerts to one option.
import React, { useState } from "react";
import { C } from "../lending/ui";

export default function YieldSignupForm({ consent, slug }: { consent: string; slug?: string }) {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — hidden from people
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/yield/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, website, slug }) });
      const j = await r.json().catch(() => ({}));
      setMsg({ ok: r.ok && j.ok, text: j.message ?? (r.ok ? "You're on the list." : "Something went wrong. Try again.") });
      if (r.ok && j.ok) setEmail("");
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <label htmlFor="yield-email" style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Your email</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          id="yield-email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 0, padding: "11px 12px", border: "1px solid #ccc", borderRadius: 8, fontSize: 16, background: "#fff", color: C.fg }}
        />
        <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }} />
        <button type="submit" disabled={busy} style={{ flex: "0 0 auto", padding: "11px 18px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", fontWeight: 700, fontSize: 15, cursor: busy ? "default" : "pointer" }}>
          {busy ? "Adding…" : "Alert me"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: C.small, margin: "8px 0 0" }}>
        {consent} See our <a href="/privacy#yield-alerts" style={{ color: C.accent }}>privacy policy</a>.
      </p>
      {msg && <p role="status" style={{ fontSize: 14, margin: "10px 0 0", color: msg.ok ? C.yes : C.no, fontWeight: 600 }}>{msg.text}</p>}
    </form>
  );
}
