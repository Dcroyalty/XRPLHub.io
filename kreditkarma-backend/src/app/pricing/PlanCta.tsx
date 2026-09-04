"use client";
// app/pricing/PlanCta.tsx
// "Get <plan>" button that opens the checkout in a modal (fewer clicks than a
// page hop). Same <CheckoutFlow> the /checkout page renders.

import { useEffect, useState } from "react";
import CheckoutFlow from "../checkout/CheckoutFlow";

export default function PlanCta({ planId, planName }: { planId: string; planName: string }) {
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
      <button onClick={() => setOpen(true)} style={s.cta}>
        Get {planName}
      </button>

      {open && (
        <div style={s.overlay} onClick={() => setOpen(false)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.head}>
              <strong style={{ fontSize: 16 }}>Get {planName}</strong>
              <button onClick={() => setOpen(false)} style={s.x} aria-label="Close">×</button>
            </div>
            <CheckoutFlow plan={planId} />
          </div>
        </div>
      )}
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  cta: { display: "block", width: "100%", textAlign: "center", padding: "12px 16px", borderRadius: 10, background: "#111", color: "#fff", border: "none", fontWeight: 600, fontSize: 15, cursor: "pointer", fontFamily: "inherit" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", zIndex: 1000, overflowY: "auto" },
  modal: { background: "#fff", color: "#1a1a1a", borderRadius: 16, padding: 22, maxWidth: 480, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,.3)", fontFamily: "system-ui, sans-serif" },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  x: { background: "none", border: "none", fontSize: 26, lineHeight: 1, cursor: "pointer", color: "#888" },
};
