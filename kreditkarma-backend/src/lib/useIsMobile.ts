"use client";
import { useEffect, useState } from "react";

/**
 * True on a device that can't scan its own screen — a phone (or a narrow
 * tablet). Capability-based: a coarse pointer with no hover, plus a small
 * viewport. Never user-agent sniffing (spoofable, and wrong for
 * touch-laptops / desktop-mode tablets). SSR-safe: false until mounted.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const check = () => {
      const touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
      setMobile(touch && window.innerWidth < 1024);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return mobile;
}
