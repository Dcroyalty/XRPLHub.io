// src/lib/lendingPro.ts — who may use the Lending Pro routes. Lending Pro is a $49/mo plan sold on uxus.finance
// (same owner, Stripe there); the customer gets a uxus API key and sends it here as `Authorization: Bearer uxus_...`.
// We ask uxus what the key pays for (GET https://uxus.finance/api/billing/entitlement, read-only, never counts
// toward quota) and cache the answer for 5 minutes. The key itself is never stored — only its SHA-256.
import { createHash } from "crypto";

const ENTITLEMENT_URL = "https://uxus.finance/api/billing/entitlement";
const KEY = /^uxus_[0-9a-f]{48}$/;
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; ok: boolean }>();

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

export type ProAuth = { ok: true; keyHash: string } | { ok: false; status: number; message: string };

export async function lendingProAuth(req: Request): Promise<ProAuth> {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/);
  if (!m || !KEY.test(m[1])) return { ok: false, status: 401, message: "Send your Lending Pro key as Authorization: Bearer uxus_... (get one at https://uxus.finance/pricing#lending-pro)." };
  const h = keyHash(m[1]);
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok ? { ok: true, keyHash: h } : { ok: false, status: 403, message: "This key isn't an active Lending Pro subscription." };
  try {
    const r = await fetch(ENTITLEMENT_URL, { headers: { authorization: `Bearer ${m[1]}` }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (r.status === 404 || r.status === 401) {
      cache.set(h, { at: Date.now(), ok: false });
      return { ok: false, status: 403, message: "API key not recognized." };
    }
    if (!r.ok) return { ok: false, status: 503, message: "Couldn't check your subscription right now. Try again in a minute." };
    const e = (await r.json()) as { plan?: string; active?: boolean };
    const ok = e.plan === "lending_pro" && e.active === true;
    cache.set(h, { at: Date.now(), ok });
    return ok ? { ok: true, keyHash: h } : { ok: false, status: 403, message: "This key isn't an active Lending Pro subscription." };
  } catch {
    return { ok: false, status: 503, message: "Couldn't check your subscription right now. Try again in a minute." };
  }
}
