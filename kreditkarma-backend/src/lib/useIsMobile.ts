"use client";
import { useEffect, useState } from "react";

/**
 * Which Xaman affordance to lead with, by device capability — never by
 * user-agent string (spoofable, wrong for touch-laptops and desktop-mode
 * tablets).
 *
 *   "desktop" — a real pointer / hover: show the QR to scan with a phone.
 *   "mobile"  — coarse pointer, no hover, narrow viewport: you can't scan
 *               your own screen, so show the deeplink button.
 *   "unknown" — pre-mount (SSR), or matchMedia unavailable/throwing: lead
 *               with the button (a deeplink degrades harmlessly on desktop)
 *               and let the user reveal the QR. Never render nothing.
 */
export type DeviceLead = "desktop" | "mobile" | "unknown";

export function useDeviceLead(): DeviceLead {
  const [lead, setLead] = useState<DeviceLead>("unknown");
  useEffect(() => {
    const check = () => {
      try {
        if (typeof window.matchMedia !== "function") {
          setLead("unknown");
          return;
        }
        const coarse = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
        setLead(coarse && window.innerWidth < 1024 ? "mobile" : "desktop");
      } catch {
        setLead("unknown");
      }
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return lead;
}

/** Back-compat: true only when we're confident it's a phone-class device. */
export function useIsMobile(): boolean {
  return useDeviceLead() === "mobile";
}
