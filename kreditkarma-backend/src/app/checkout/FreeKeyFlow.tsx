"use client";
// app/checkout/FreeKeyFlow.tsx
// Self-serve free tier: connect Xaman (SignIn — proves wallet control, no funds
// move) -> one free API key per wallet. Shared by the /pricing "Start free"
// modal and /checkout?plan=free.
//
//   1. POST /api/free-key/start  -> Xaman SignIn payload (QR + deeplink)
//   2. poll POST /api/free-key/claim { uuid } every 3s
//        pending -> keep polling
//        issued  -> show the key ONCE
//        already_claimed / rejected / expired / rate_limited -> explain

import { useCallback, useEffect, useRef, useState } from "react";

type Phase =
  | "idle" | "opening" | "waiting" | "issued"
  | "already_claimed" | "revoked" | "rejected" | "expired" | "rate_limited"
  | "inactive_wallet" | "error";

export default function FreeKeyFlow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const uuid = useRef<string | null>(null);

  const start = useCallback(async () => {
    setPhase("opening");
    setMsg("");
    try {
      const res = await fetch("/api/free-key/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.uuid) {
        setPhase(res.status === 429 ? "rate_limited" : "error");
        setMsg(data.message ?? "Could not start. Try again shortly.");
        return;
      }
      uuid.current = data.uuid;
      setQr(data.qrPng ?? null);
      setLink(data.deepLink ?? null);
      setPhase("waiting");
      if (data.deepLink && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        window.location.href = data.deepLink;
      }
    } catch {
      setPhase("error");
      setMsg("Could not reach Xaman. Try again shortly.");
    }
  }, []);

  // poll claim
  useEffect(() => {
    if (phase !== "waiting" || !uuid.current) return;
    const id = uuid.current;
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/free-key/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uuid: id }),
        });
        const data = await res.json();
        switch (data.status) {
          case "pending": return;
          case "issued":
            setApiKey(data.key);
            setPhase("issued");
            return;
          case "already_claimed":
          case "revoked":
          case "rejected":
          case "expired":
          case "rate_limited":
          case "inactive_wallet":
            setPhase(data.status);
            return;
          default:
            return; // transient — keep polling
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [phase]);

  // ---- terminal / status screens ----

  if (phase === "issued") {
    return (
      <div>
        <p style={s.p}>Wallet verified. Here is your free API key ({"200 calls / mo, 10 rpm"}):</p>
        <pre style={s.key}>{apiKey}</pre>
        <p style={s.warn}>Store it now — it cannot be shown again.</p>
        <pre style={s.code}>{`curl -H "authorization: Bearer ${apiKey ?? "xrs_live_..."}" \\
  "https://www.xrplhub.io/api/v1/score?wallet=rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De"`}</pre>
      </div>
    );
  }
  if (phase === "already_claimed") {
    return (
      <p style={s.p}>
        This wallet already has a free key. Keys can’t be re-shown — email{" "}
        <a href="mailto:support@xrplhub.io" style={s.link}>support@xrplhub.io</a> to rotate it,
        or pick a paid plan for more volume.
      </p>
    );
  }
  if (phase === "revoked") {
    return (
      <p style={s.p}>
        This wallet’s free key was revoked. Email{" "}
        <a href="mailto:support@xrplhub.io" style={s.link}>support@xrplhub.io</a>.
      </p>
    );
  }
  if (phase === "rate_limited") {
    return <p style={s.p}>{msg || "Too many free keys from this network today. Try again tomorrow, or pick a paid plan."}</p>;
  }
  if (phase === "inactive_wallet") {
    return (
      <div>
        <p style={s.p}>
          That wallet isn’t activated on the XRP Ledger yet (it needs the ~1 XRP base reserve).
          Fund it, then try again — or connect a different wallet.
        </p>
        <button onClick={start} style={s.btn}>Try again</button>
      </div>
    );
  }
  if (phase === "rejected" || phase === "expired") {
    return (
      <div>
        <p style={s.p}>{phase === "rejected" ? "You declined the sign-in request." : "The sign-in request expired."}</p>
        <button onClick={start} style={s.btn}>Try again</button>
      </div>
    );
  }

  // ---- active ----
  return (
    <div>
      {phase === "idle" || phase === "opening" || phase === "error" ? (
        <>
          <p style={s.p}>
            Connect your Xaman wallet to claim a free key — 200 scored calls/month, 10 requests/minute.
            You sign a one-tap sign-in request; no transaction, no funds move, no signup.
          </p>
          <button onClick={start} disabled={phase === "opening"} style={s.btn}>
            {phase === "opening" ? "Opening Xaman…" : "Connect with Xaman"}
          </button>
          {phase === "error" && <p style={s.err}>{msg}</p>}
        </>
      ) : (
        <div style={s.box}>
          <p style={s.h}>Approve the sign-in in Xaman</p>
          {qr && <img alt="Scan with Xaman" style={s.qr} src={qr} />}
          {link && (
            <a href={link} target="_blank" rel="noreferrer" style={s.btn}>Open in Xaman</a>
          )}
          <p style={s.polling}>Waiting… this updates itself once you sign.</p>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  p: { color: "#444", lineHeight: 1.55, marginBottom: 14 },
  err: { color: "#b00020", marginTop: 10 },
  btn: { display: "block", width: "100%", textAlign: "center", padding: "13px 16px", borderRadius: 12, background: "#111", color: "#fff", border: "none", fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "inherit", textDecoration: "none" },
  box: { border: "1px solid #e0e0e0", borderRadius: 12, padding: 16, textAlign: "center" },
  h: { fontWeight: 700, margin: "0 0 10px" },
  qr: { width: 190, height: 190, margin: "0 auto 12px", display: "block" },
  polling: { textAlign: "center", color: "#888", marginTop: 14, fontSize: 14 },
  key: { background: "#111", color: "#0f0", padding: 16, borderRadius: 10, wordBreak: "break-all", whiteSpace: "pre-wrap", fontSize: 14 },
  warn: { color: "#8a6d00", background: "#fff7d6", padding: "10px 12px", borderRadius: 8, fontSize: 13, margin: "12px 0" },
  code: { background: "#111", color: "#e6e6e6", padding: 12, borderRadius: 10, fontSize: 12, overflowX: "auto", lineHeight: 1.6, whiteSpace: "pre" },
  link: { color: "#0a7", fontWeight: 600 },
};
