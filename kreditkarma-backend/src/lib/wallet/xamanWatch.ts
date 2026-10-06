// src/lib/wallet/xamanWatch.ts
// Watch a Xaman sign request over Xaman's WEBSOCKET instead of polling its REST API (Xaman's docs: "No polling should be
// used: to retrieve the status of a payload, use the websocket"). Every payload has a status socket at
// wss://xumm.app/sign/<uuid> (the `refs.websocket_status` Xaman returns at creation). It pushes:
//   { expires_in_seconds }            — keep-alive countdown
//   { opened: true }                  — the user opened it in the app
//   { signed: true|false, txid?, … }  — resolved (false = rejected)
//   { expired: true }                 — expired
// Callers trigger their existing server check ONCE on resolution. Their REST fallback must use delay(): slow (45 s) while
// the socket is healthy, 15 s if it failed — so an open sign request costs ~1–2 Xaman API calls a minute, not 20.
// Browser-only; safe to import from client components.

export interface XamanResolution {
  signed?: boolean;
  txid?: string | null;
  expired?: boolean;
}

export interface XamanWatch {
  /** Stop listening (call from the effect cleanup). */
  stop: () => void;
  /** Milliseconds until the next REST fallback check: slow while the websocket is healthy. */
  delay: () => number;
  /** The resolution the websocket reported, if any. */
  resolution: () => XamanResolution | null;
}

export const XAMAN_FALLBACK_HEALTHY_MS = 45_000;
export const XAMAN_FALLBACK_NO_SOCKET_MS = 15_000;

export function xamanStatusSocketUrl(uuid: string, given?: string | null): string {
  if (given && /^wss:\/\/xumm\.app\/sign\/[0-9a-f-]{36}$/i.test(given)) return given;
  return `wss://xumm.app/sign/${encodeURIComponent(uuid)}`;
}

export function watchXaman(uuid: string, onResolved: (r: XamanResolution) => void, websocketUrl?: string | null): XamanWatch {
  let healthy = false;
  let done = false;
  let result: XamanResolution | null = null;
  let ws: WebSocket | null = null;
  const finish = (r: XamanResolution) => {
    if (done) return;
    done = true;
    result = r;
    try { ws?.close(); } catch { /* ignore */ }
    onResolved(r);
  };
  try {
    if (typeof WebSocket !== "undefined") {
      ws = new WebSocket(xamanStatusSocketUrl(uuid, websocketUrl));
      ws.onopen = () => { healthy = true; };
      ws.onerror = () => { healthy = false; };
      ws.onclose = () => { healthy = false; };
      ws.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (typeof m.signed === "boolean") finish({ signed: m.signed, txid: typeof m.txid === "string" ? m.txid : null });
        else if (m.expired === true || (typeof m.expires_in_seconds === "number" && m.expires_in_seconds <= 0)) finish({ expired: true });
      };
    }
  } catch {
    healthy = false;
  }
  return {
    stop: () => { done = true; try { ws?.close(); } catch { /* ignore */ } },
    delay: () => (healthy ? XAMAN_FALLBACK_HEALTHY_MS : XAMAN_FALLBACK_NO_SOCKET_MS),
    resolution: () => result,
  };
}
