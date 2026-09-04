// src/lib/wallet/detect.ts
// Extension wallets inject their globals asynchronously — often after
// DOMContentLoaded, sometimes a beat after the page's own scripts run. A
// one-shot check at mount misses them. Poll for a short window instead.

/** Resolve true as soon as `pred()` is truthy; false after `timeoutMs`. */
export function pollFor(
  pred: () => boolean,
  timeoutMs = 2500,
  intervalMs = 150
): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (pred()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const id = window.setInterval(() => {
      if (pred()) {
        window.clearInterval(id);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        window.clearInterval(id);
        resolve(false);
      }
    }, intervalMs);
  });
}
