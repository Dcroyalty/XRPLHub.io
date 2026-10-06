// src/lib/xappSession.ts
// The Spend Controls xApp's session: after the server resolves Xaman's one-time token (getXappOtt) it issues this
// short-lived, HMAC-signed token naming the account that opened the xApp. Routes that list a funder's plans require it,
// so nobody can enumerate another account's plans (a plan id is that plan's dashboard secret).
// Key: derived from XUMM_API_SECRET (already a server-only secret), so there is no new env var to manage.

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { isValidXrplAddress } from "./address";

const TTL_MS = 12 * 60 * 60 * 1000;

function key(): Buffer | null {
  const secret = process.env.XUMM_API_SECRET;
  return secret ? createHash("sha256").update(`xrplhub-xapp-session|${secret}`).digest() : null;
}

export function issueXappSession(account: string): string | null {
  const k = key();
  if (!k) return null;
  const body = Buffer.from(JSON.stringify({ a: account, exp: Date.now() + TTL_MS })).toString("base64url");
  const sig = createHmac("sha256", k).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** The account a valid, unexpired session names — or null. */
export function readXappSession(token: string | null | undefined): string | null {
  const k = key();
  if (!k || !token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", k).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { a, exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { a?: string; exp?: number };
    if (!a || !isValidXrplAddress(a) || typeof exp !== "number" || exp < Date.now()) return null;
    return a;
  } catch {
    return null;
  }
}

export function sessionFromRequest(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return readXappSession(h.startsWith("Bearer ") ? h.slice(7) : null);
}
