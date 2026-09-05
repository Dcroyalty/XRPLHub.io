"use client";
// One Xaman prompt for every payment/sign surface. Desktop shows the QR to
// scan with Xaman on a phone; mobile shows the deeplink button (you can't
// scan your own screen). Never both. Amount and destination render as
// readable text beneath either one — the payload already carries them
// pre-filled, this is just so the buyer sees what they're about to sign.
import { useIsMobile } from "@/lib/useIsMobile";

function qrFallback(uuid: string): string {
  const url = `https://xumm.app/sign/${uuid}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&qzone=2&data=${encodeURIComponent(url)}`;
}

export interface XamanPayPromptProps {
  qrPng?: string | null;
  deepLink?: string | null;
  uuid?: string | null;
  /** "pay" shows the amount/destination block; "sign" is a bare tx signature; "signin" is a connect. */
  mode?: "pay" | "sign" | "signin";
  amount?: string | number;
  currency?: string;
  destination?: string;
  destinationTag?: string | number | null;
  theme?: "dark" | "light";
}

export default function XamanPayPrompt({
  qrPng, deepLink, uuid, mode = "pay", amount, currency, destination, destinationTag, theme = "dark",
}: XamanPayPromptProps) {
  const isMobile = useIsMobile();
  const dark = theme === "dark";
  const src = qrPng || (uuid ? qrFallback(uuid) : "");
  const href = deepLink || (uuid ? `https://xumm.app/sign/${uuid}` : "#");

  const muted = dark ? "rgba(255,255,255,.5)" : "#6b7280";
  const strong = dark ? "#fff" : "#111827";
  const cardBg = "#fff";
  const rowBorder = dark ? "rgba(255,255,255,.08)" : "#e5e7eb";

  const action = mode === "signin" ? "Connect" : "Sign";
  const caption =
    mode === "signin"
      ? "Scan with Xaman on your phone to connect."
      : mode === "sign"
      ? "Scan with Xaman on your phone, then review and slide to sign."
      : "Scan with Xaman on your phone. Amount, destination and tag are pre-filled — just slide to sign.";
  const mobileCaption =
    mode === "signin"
      ? "Opens straight to the connect screen."
      : "Opens straight to the sign screen — everything's pre-filled.";

  const details =
    mode === "pay" && (amount != null || destination) ? (
      <div style={{ maxWidth: 320, margin: "12px auto 0", textAlign: "left", fontSize: 13 }}>
        {amount != null && (
          <Row label="Amount" value={`${amount} ${currency ?? ""}`.trim()} strong={strong} muted={muted} border={rowBorder} />
        )}
        {destination && (
          <Row label="To" value={destination} mono muted={muted} strong={strong} border={rowBorder} />
        )}
        {destinationTag != null && destinationTag !== "" && (
          <Row label="Destination tag" value={String(destinationTag)} mono muted={muted} strong={strong} border={rowBorder} highlight />
        )}
      </div>
    ) : null;

  return (
    <div style={{ textAlign: "center" }}>
      {isMobile ? (
        <>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "#10b981", color: "#000", fontWeight: 800, fontSize: 15,
              padding: "14px 30px", borderRadius: 99, textDecoration: "none",
              boxShadow: "0 4px 20px rgba(16,185,129,.35)",
            }}
          >
            📱 Open in Xaman — {action} →
          </a>
          <p style={{ fontSize: 12, color: muted, marginTop: 10 }}>{mobileCaption}</p>
        </>
      ) : (
        <>
          <div
            style={{
              background: cardBg, borderRadius: 18, padding: 14, width: 210, height: 210,
              margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 30px rgba(16,185,129,.15)",
            }}
          >
            {src ? <img src={src} alt={`Scan with Xaman to ${action.toLowerCase()}`} style={{ width: "100%", height: "100%", borderRadius: 8 }} /> : null}
          </div>
          <p style={{ fontSize: 12, color: muted, maxWidth: 280, margin: "0 auto" }}>{caption}</p>
        </>
      )}
      {details}
    </div>
  );
}

function Row({
  label, value, mono, strong, muted, border, highlight,
}: {
  label: string; value: string; mono?: boolean; strong: string; muted: string; border: string; highlight?: boolean;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: `1px solid ${border}` }}>
      <span style={{ color: muted, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: highlight ? "#10b981" : strong,
          fontWeight: highlight || !mono ? 700 : 400,
          fontFamily: mono ? "ui-monospace, monospace" : "inherit",
          wordBreak: "break-all", textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}
