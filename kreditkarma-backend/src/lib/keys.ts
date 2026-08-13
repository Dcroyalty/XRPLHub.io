// lib/keys.ts
// API key generation, hashing, and verification.
//
// Design decision (push back if you disagree): keys are stored HASHED and
// looked up by a short indexed PREFIX. We never store the raw key. If your
// database leaks, the keys in it are useless. The tradeoff: a lost key
// can't be recovered, only rotated — which is the correct behavior.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/xrplscore-db";
import { getPlan, type Plan } from "@/lib/plans";

const LIVE_PREFIX = "xrs_live_";
const PREFIX_LOOKUP_LEN = 16; // stored + indexed for O(1) lookup

export interface GeneratedKey {
  full: string;      // show ONCE to the user, never stored
  keyPrefix: string; // stored + indexed
  keyHash: string;   // stored
}

export function generateApiKey(): GeneratedKey {
  const secret = randomBytes(24).toString("base64url"); // ~32 chars, url-safe
  const full = LIVE_PREFIX + secret;
  return {
    full,
    keyPrefix: full.slice(0, PREFIX_LOOKUP_LEN),
    keyHash: sha256(full),
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface ResolvedKey {
  id: string;
  plan: Plan;
  planId: string;
  name: string | null;
}

/**
 * Resolve a raw API key from an incoming request to its DB record.
 * Returns null if the key is malformed, unknown, or disabled.
 */
export async function resolveApiKey(raw: string | null): Promise<ResolvedKey | null> {
  if (!raw || !raw.startsWith(LIVE_PREFIX)) return null;

  const keyPrefix = raw.slice(0, PREFIX_LOOKUP_LEN);
  const record = await prisma.apiKey.findUnique({ where: { keyPrefix } });
  if (!record || !record.active) return null;

  if (!hashesEqual(sha256(raw), record.keyHash)) return null;

  // touch lastUsedAt without blocking the request path
  prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    id: record.id,
    plan: getPlan(record.plan),
    planId: record.plan,
    name: record.name,
  };
}

/** Pull the key out of Authorization: Bearer xxx  OR  x-api-key: xxx */
export function extractKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key");
}
