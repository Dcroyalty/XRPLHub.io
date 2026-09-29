// src/lib/adminAuth.ts
// Shared admin authentication. Two ways in, both gating the same endpoints:
//   1. ADMIN_API_TOKEN, in either header (unchanged -- scripts and crons use this):
//        Authorization: Bearer <token>
//        x-admin-token: <token>
//   2. A short-lived signed session cookie (adminSession.ts), issued after a Xaman
//      SignIn proves control of a wallet in ADMIN_WALLETS -- see /admin and
//      /api/admin/auth/*. Additive: nothing about (1) changed.
//
// Fails CLOSED: if ADMIN_API_TOKEN is unset, neither path can ever be admin (the
// session token is HMAC-signed with ADMIN_API_TOKEN, so an unset token blocks both).

import { timingSafeEqual } from "crypto";
import { extractSessionCookie, verifyAdminSession } from "./adminSession";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Pull the admin token out of the Authorization or x-admin-token header. */
export function extractAdminToken(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-admin-token")?.trim() ?? "";
}

/** True if the request carries the correct ADMIN_API_TOKEN, OR a valid admin session cookie. */
export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return false; // fail closed

  const provided = extractAdminToken(req);
  if (provided.length > 0 && safeEqual(provided, token)) return true;

  return verifyAdminSession(extractSessionCookie(req)) !== null;
}

/** The wallet a request's admin session belongs to, or null (no session, or token-auth'd instead). */
export function adminSessionWallet(req: Request): string | null {
  return verifyAdminSession(extractSessionCookie(req));
}

/** Standard 401 body for admin-gated routes. */
export function adminUnauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Valid admin token required." }),
    { status: 401, headers: { "content-type": "application/json" } }
  );
}
