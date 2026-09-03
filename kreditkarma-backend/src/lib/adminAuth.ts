// src/lib/adminAuth.ts
// Shared admin authentication. ONE env var — ADMIN_API_TOKEN — gates every
// internal/admin endpoint (dashboard data, key issuance, grant approve/review,
// purchase writes). No hardcoded passwords, no client-trusted secrets.
//
// Accepts the token in either header:
//   Authorization: Bearer <token>
//   x-admin-token: <token>
//
// Fails CLOSED: if ADMIN_API_TOKEN is unset, no request is ever admin.

import { timingSafeEqual } from "crypto";

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

/** True only if the request carries the correct ADMIN_API_TOKEN. */
export function isAdmin(req: Request): boolean {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return false; // fail closed

  const provided = extractAdminToken(req);
  return provided.length > 0 && safeEqual(provided, token);
}

/** Standard 401 body for admin-gated routes. */
export function adminUnauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Valid admin token required." }),
    { status: 401, headers: { "content-type": "application/json" } }
  );
}
