"use client";
// src/lib/wallet/WalletPicker.tsx
// Wallet chooser. Detected providers are selectable rows (Xaman is index 0 and
// pre-selected). Any extension that isn't installed is named below with an
// install link — so a user on Xaman-only knows the alternatives exist.

import type { ProviderOption } from "./index";

export default function WalletPicker({
  options,
  selected,
  onSelect,
  disabled,
}: {
  options: ProviderOption[];
  selected: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const available = options.filter((o) => o.available);
  const missing = options.filter((o) => !o.available && o.provider.kind === "extension");

  return (
    <div style={s.wrap}>
      {available.length > 1
        ? available.map(({ provider }) => {
            const isSel = selected === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(provider.id)}
                style={{ ...s.row, ...(isSel ? s.rowSel : {}) }}
              >
                <span style={s.dot(isSel)} />
                <span style={{ fontWeight: 600 }}>{provider.label}</span>
                {provider.id === "xaman" && <span style={s.tag}>mobile · default</span>}
                {provider.kind === "extension" && <span style={s.tag}>extension · detected</span>}
              </button>
            );
          })
        : available.length === 1 && (
            <div style={{ ...s.row, ...s.rowSel }}>
              <span style={s.dot(true)} />
              <span style={{ fontWeight: 600 }}>{available[0].provider.label}</span>
              <span style={s.tag}>
                {available[0].provider.id === "xaman" ? "mobile" : "extension"}
              </span>
            </div>
          )}

      {missing.length > 0 && (
        <p style={s.hint}>
          Also works with{" "}
          {missing.map((o, i) => (
            <span key={o.provider.id}>
              {i > 0 && (i === missing.length - 1 ? " and " : ", ")}
              <a href={o.provider.installUrl} target="_blank" rel="noreferrer" style={s.hintLink}>
                {o.provider.label}
              </a>
            </span>
          ))}{" "}
          — install one to pay from a browser extension.
        </p>
      )}
    </div>
  );
}

const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 } as React.CSSProperties,
  row: {
    display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
    padding: "12px 14px", borderRadius: 10, border: "1px solid #e0e0e0", background: "#fafafa",
    cursor: "pointer", fontSize: 14, fontFamily: "inherit", color: "#111",
  } as React.CSSProperties,
  rowSel: { borderColor: "#111", background: "#fff", boxShadow: "0 0 0 1px #111 inset", cursor: "default" } as React.CSSProperties,
  tag: { marginLeft: "auto", fontSize: 11, color: "#888" } as React.CSSProperties,
  hint: { fontSize: 12.5, color: "#666", lineHeight: 1.5, margin: "2px 2px 0" } as React.CSSProperties,
  hintLink: { color: "#0a7", fontWeight: 600 } as React.CSSProperties,
  dot: (on: boolean): React.CSSProperties => ({
    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
    border: `2px solid ${on ? "#111" : "#bbb"}`, background: on ? "#111" : "transparent",
  }),
};
