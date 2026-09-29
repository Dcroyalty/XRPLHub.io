// src/lib/adminSession.ts
// Short-lived signed admin sessions, issued after a Xaman SignIn proves control of a wallet in
// ADMIN_WALLETS. Same "prove control" pattern as the free-key flow (src/lib/freeKey.ts) -- a SignIn
// challenge, resolved via Xaman or an injected wallet's signature -- just gated by an allowlist
// instead of minting a key.
//
// The session token is a plain HMAC-signed value (no new dependency): base64url(payload) + "." +
// HMAC-SHA256(payload, ADMIN_API_TOKEN). Reuses ADMIN_API_TOKEN as the signing key rather than adding
// a second secret -- it's already a server-only secret with the exact right blast radius (anyone who
// could forge a session already has the admin token, at which point they don't need to forge one).
// Sessions are stateless (nothing stored server-side to revoke early) and short: SESSION_TTL_MS.
//
// adminAuth.ts's isAdmin() checks this ALONGSIDE the existing Bearer/x-admin-token header check --
// additive, never a replacement. Scripts and crons keep using ADMIN_API_TOKEN exactly as before.

import { createHmac, timingSafeEqual } from "crypto";

export const ADMIN_SESSION_COOKIE = "xh_admin_session";
export const SESSION_TTL_MS = 60 * 60_000; // 1 hour

/** Wallets allowed to sign in as admin. Defaults to the treasury alone if unset. */
export function adminWallets(): string[] {
  const raw = process.env.ADMIN_WALLETS?.trim();
  if (raw) return raw.split(",").map((w) => w.trim()).filter(Boolean);
  return ["rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF"]; // treasury
}

interface SessionPayload {
  wallet: string;
  iat: number; // issued-at, ms epoch
  exp: number; // expiry, ms epoch
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
function fromB64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function hmac(payload: string): string | null {
  const key = process.env.ADMIN_API_TOKEN;
  if (!key) return null; // fail closed -- same posture as adminAuth.ts's isAdmin()
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** Issue a signed session token for `wallet`. Returns null if ADMIN_API_TOKEN is unset (fail closed). */
export function signAdminSession(wallet: string): string | null {
  const now = Date.now();
  const payload: SessionPayload = { wallet, iat: now, exp: now + SESSION_TTL_MS };
  const encoded = b64url(JSON.stringify(payload));
  const sig = hmac(encoded);
  if (!sig) return null;
  return `${encoded}.${sig}`;
}

/** Verify a session token. Returns the wallet it was issued to, or null if invalid/expired/unsigned. */
export function verifyAdminSession(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = hmac(encoded);
  if (!expectedSig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromB64url(encoded)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.wallet !== "string" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  if (!adminWallets().includes(payload.wallet)) return null; // re-checked every request, not just at issuance
  return payload.wallet;
}

/** Pull the session cookie value out of a request's Cookie header. */
export function extractSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === ADMIN_SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
