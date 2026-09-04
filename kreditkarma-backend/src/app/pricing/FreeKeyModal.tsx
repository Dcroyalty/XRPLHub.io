"use client";
// app/pricing/FreeKeyModal.tsx
// "Start free" CTA -> modal running the self-serve free-key flow (Xaman SignIn).

import { useEffect, useState } from "react";
import FreeKeyFlow from "../checkout/FreeKeyFlow";

export default function FreeKeyModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} style={s.cta}>Start free</button>

      {open && (
        <div style={s.overlay} onClick={() => setOpen(false)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.head}>
              <strong style={{ fontSize: 16 }}>Claim your free API key</strong>
              <button onClick={() => setOpen(false)} style={s.x} aria-label="Close">×</button>
            </div>
            <FreeKeyFlow />
          </div>
        </div>
      )}
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  cta: { display: "block", width: "100%", textAlign: "center", padding: "12px 16px", borderRadius: 10, border: "1px solid #111", background: "#fff", color: "#111", fontWeight: 600, fontSize: 15, cursor: "pointer", fontFamily: "inherit" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 1000, overflowY: "auto" },
  modal: { background: "#fff", color: "#1a1a1a", borderRadius: 16, padding: 22, maxWidth: 480, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,.3)", fontFamily: "system-ui, sans-serif" },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  x: { background: "none", border: "none", fontSize: 26, lineHeight: 1, cursor: "pointer", color: "#888" },
};
