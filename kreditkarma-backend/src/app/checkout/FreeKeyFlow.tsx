"use client";
// app/checkout/FreeKeyFlow.tsx
// Self-serve free tier: prove wallet control -> one free API key per wallet.
// Shared by the /pricing "Start free" modal and /checkout?plan=free.
//
//   1. POST /api/free-key/start -> { challenge, xaman payload?, xamanAvailable }
//   2. pick a wallet (Xaman default; Crossmark / GemWallet if detected)
//   3a. Xaman  -> show QR, poll POST /api/free-key/claim { uuid }
//   3b. ext    -> provider.proveControl(challenge) -> POST /api/free-key/claim { proof }
//   4. issued -> show the key ONCE

import { useCallback, useEffect, useRef, useState } from "react";
import WalletPicker from "@/lib/wallet/WalletPicker";
import XamanPayPrompt from "@/components/XamanPayPrompt";
import {
  getProvider,
  resolveProviderOptions,
  WalletCancelled,
  type ProviderOption,
  type ProveContext,
} from "@/lib/wallet";

type Phase =
  | "idle" | "loading" | "picker" | "xaman-wait" | "ext-wait" | "issued"
  | "already_claimed" | "revoked" | "rejected" | "expired" | "rate_limited"
  | "bad_signature" | "inactive_wallet" | "error";

type StartData = {
  challenge: { id: string; hex: string };
  uuid: string | null;
  qrPng: string | null;
  deepLink: string | null;
  xamanAvailable: boolean;
};

export default function FreeKeyFlow() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);

  const [options, setOptions] = useState<ProviderOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const startData = useRef<StartData | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const applyStatus = (status: string, key?: string) => {
    if (status === "issued") {
      setApiKey(key ?? null);
      setPhase("issued");
    } else if (
      ["already_claimed", "revoked", "rejected", "expired", "rate_limited", "bad_signature", "inactive_wallet"].includes(status)
    ) {
      setPhase(status as Phase);
    }
  };

  const start = useCallback(async () => {
    setPhase("loading");
    setMsg("");
    try {
      const res = await fetch("/api/free-key/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.challenge) {
        setPhase(res.status === 429 ? "rate_limited" : "error");
        setMsg(data.message ?? "Could not start. Try again shortly.");
        return;
      }
      startData.current = data as StartData;
      const xamanAvailable = !!data.xamanAvailable;
      // Show the picker immediately with Xaman; extensions pop in when detected
      // (their globals inject asynchronously — polling takes up to ~1.5s).
      const xamanProv = getProvider("xaman")!;
      setOptions([{ provider: xamanProv, available: xamanAvailable }]);
      setSelected(xamanAvailable ? "xaman" : null);
      setPhase("picker");
      resolveProviderOptions({ xamanAvailable }).then((opts) => {
        setOptions(opts);
        setSelected((cur) => cur ?? opts.find((o) => o.available)?.provider.id ?? null);
      });
    } catch {
      setPhase("error");
      setMsg("Could not reach the server. Try again shortly.");
    }
  }, []);

  const pick = useCallback(async (id: string) => {
    const sd = startData.current;
    const provider = getProvider(id);
    if (!sd || !provider) return;

    const ctx: ProveContext = {
      challengeId: sd.challenge.id,
      challengeHex: sd.challenge.hex,
      xamanUuid: sd.uuid,
      xamanQrPng: sd.qrPng,
      xamanDeepLink: sd.deepLink,
    };
    const handle = provider.proveControl(ctx);

    if (provider.id === "xaman") {
      setQr(handle.qrPng);
      setLink(handle.deepLink);
      // (no UA-sniff auto-redirect — the mobile button in XamanPayPrompt handles it)
      setPhase("xaman-wait");
      return;
    }

    // extension: run the SDK, then one claim POST
    setPhase("ext-wait");
    setMsg(`Approve the request in ${provider.label}…`);
    try {
      const body = await handle.body;
      const res = await fetch("/api/free-key/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      applyStatus(data.status, data.key);
      if (!data.status || data.status === "pending") {
        setPhase("error");
        setMsg("Unexpected response. Try again.");
      }
    } catch (e) {
      if (e instanceof WalletCancelled) {
        setPhase("rejected");
      } else {
        setPhase("error");
        setMsg(e instanceof Error ? e.message : "Signing failed. Try again.");
      }
    }
  }, []);

  // Xaman poll (unchanged behaviour)
  useEffect(() => {
    if (phase !== "xaman-wait" || !startData.current?.uuid) return;
    const id = startData.current.uuid;
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/free-key/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uuid: id }),
        });
        const data = await res.json();
        if (data.status === "pending") return;
        applyStatus(data.status, data.key);
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [phase]);

  // ---- terminal screens ----
  if (phase === "issued") {
    return (
      <div>
        <p style={s.p}>Wallet verified. Your free API key (200 calls / mo, 10 rpm):</p>
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
  if (phase === "bad_signature") {
    return (
      <div>
        <p style={s.p}>That signature couldn’t be verified. Try again, or use a different wallet.</p>
        <button onClick={start} style={s.btn}>Try again</button>
      </div>
    );
  }
  if (phase === "rejected" || phase === "expired") {
    return (
      <div>
        <p style={s.p}>{phase === "rejected" ? "You declined the request." : "The request expired."}</p>
        <button onClick={start} style={s.btn}>Try again</button>
      </div>
    );
  }

  // ---- active ----
  if (phase === "picker") {
    return (
      <div>
        <p style={s.p}>
          Connect a wallet to claim a free key — 200 scored calls/month, 10 requests/minute.
          You sign a one-tap request; no transaction, no funds move, no signup.
        </p>
        <WalletPicker options={options} selected={selected} onSelect={setSelected} />
        <button
          onClick={() => selected && pick(selected)}
          disabled={!selected}
          style={s.btn}
        >
          {selected ? `Continue with ${getProvider(selected)?.label}` : "Pick a wallet"}
        </button>
      </div>
    );
  }
  if (phase === "xaman-wait") {
    return (
      <div style={s.box}>
        <p style={s.h}>Approve the sign-in in Xaman</p>
        <XamanPayPrompt theme="light" mode="signin" qrPng={qr} deepLink={link} />
        <p style={s.polling}>Waiting… this updates itself once you sign.</p>
      </div>
    );
  }
  if (phase === "ext-wait") {
    return <p style={s.polling}>{msg || "Waiting for your wallet…"}</p>;
  }

  // idle / loading / error
  return (
    <div>
      <p style={s.p}>
        Connect a wallet to claim a free key — 200 scored calls/month, 10 requests/minute.
        No transaction, no funds move, no signup.
      </p>
      <button onClick={start} disabled={phase === "loading"} style={s.btn}>
        {phase === "loading" ? "Loading…" : "Connect a wallet"}
      </button>
      {phase === "error" && <p style={s.err}>{msg}</p>}
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
