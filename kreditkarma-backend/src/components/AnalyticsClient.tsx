"use client";
// src/components/AnalyticsClient.tsx — Vercel Web Analytics, minus our own traffic.
//
// Vercel's supported way to exclude visits is a beforeSend filter (vercel.com/docs/analytics/redacting-sensitive-data):
// we drop every event when localStorage has "va-disable", and from automated browsers (navigator.webdriver: Playwright,
// Puppeteer, Selenium monitors). Our curl/GitHub Actions monitors never run JavaScript, so they are never counted.
// To exclude a browser (do this once on each of your phones/laptops): open https://www.xrplhub.io/?va-disable=1 .
// To count it again: https://www.xrplhub.io/?va-disable=0 . The same flag also stops the /yield visit counter.
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { useEffect } from "react";

export function analyticsDisabled(): boolean {
  try {
    if (typeof navigator !== "undefined" && navigator.webdriver) return true;
    return typeof localStorage !== "undefined" && !!localStorage.getItem("va-disable");
  } catch {
    return false;
  }
}

export default function AnalyticsClient() {
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get("va-disable");
      if (v === "1") localStorage.setItem("va-disable", "true");
      if (v === "0") localStorage.removeItem("va-disable");
    } catch { /* storage blocked: nothing to remember */ }
  }, []);
  return <Analytics beforeSend={(e: BeforeSendEvent) => (analyticsDisabled() || e.url.includes("va-disable=") ? null : e)} />;
}
