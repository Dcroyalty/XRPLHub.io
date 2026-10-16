"use client";
// Counts one visit to this /yield page (POST /api/yield/visit). No cookies, nothing personal sent or stored.
import { useEffect } from "react";
import { analyticsDisabled } from "@/components/AnalyticsClient";

export default function VisitBeacon({ path }: { path: string }) {
  useEffect(() => {
    if (analyticsDisabled()) return; // our own browsers and automated monitors aren't counted
    try {
      const body = JSON.stringify({ path });
      if (!navigator.sendBeacon?.("/api/yield/visit", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/yield/visit", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
      }
    } catch { /* never break the page */ }
  }, [path]);
  return null;
}
