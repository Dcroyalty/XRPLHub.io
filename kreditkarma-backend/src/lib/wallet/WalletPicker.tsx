"use client";
// src/lib/wallet/WalletPicker.tsx
// Radio-style wallet chooser. Only providers that resolveProviderOptions()
// deemed usable are passed in; an unavailable one (rare fallback) shows an
// install link instead of a dead button. Xaman is index 0 and pre-selected.

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
  return (
    <div style={s.wrap}>
      {options.map(({ provider, available }) => {
        const isSel = selected === provider.id;
        if (!available) {
          return (
            <a
              key={provider.id}
              href={provider.installUrl}
              target="_blank"
              rel="noreferrer"
              style={{ ...s.row, ...s.rowInstall }}
            >
              <span>{provider.label}</span>
              <span style={s.installTag}>Install ↗</span>
            </a>
          );
        }
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
      })}
    </div>
  );
}

const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 } as React.CSSProperties,
  row: {
    display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
    padding: "12px 14px", borderRadius: 10, border: "1px solid #e0e0e0", background: "#fafafa",
    cursor: "pointer", fontSize: 14, fontFamily: "inherit", color: "#111", textDecoration: "none",
  } as React.CSSProperties,
  rowSel: { borderColor: "#111", background: "#fff", boxShadow: "0 0 0 1px #111 inset" } as React.CSSProperties,
  rowInstall: { opacity: 0.7 } as React.CSSProperties,
  tag: { marginLeft: "auto", fontSize: 11, color: "#888" } as React.CSSProperties,
  installTag: { marginLeft: "auto", fontSize: 12, color: "#0a7", fontWeight: 600 } as React.CSSProperties,
  dot: (on: boolean): React.CSSProperties => ({
    width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
    border: `2px solid ${on ? "#111" : "#bbb"}`, background: on ? "#111" : "transparent",
  }),
};
