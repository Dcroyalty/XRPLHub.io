// src/lib/freeKey.ts
// Shared bits for the self-serve free-tier signup:
//   /pricing "Start free" -> Xaman SignIn (proves wallet control) -> one free key.
//
// Abuse controls, in layers:
//   1. one free key per XRPL wallet   (ApiKey.ownerWallet @unique)
//   2. per-IP cap on SignIn requests  (START_PER_IP_PER_HOUR)
//   3. per-IP cap on issued keys      (CLAIM_PER_IP_PER_DAY)
//   4. Xaman SignIn itself — the wallet cryptographically signs our payload

import { verify as verifySignature, deriveAddress } from "ripple-keypairs";

export const FREE_KEY_IDENTIFIER_PREFIX = "xrplhub_freekey_";

// A SignIn challenge older than this can't be claimed. Matches the Xaman
// payload expiry so both paths behave the same.
export const CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * Verify an injected-wallet (Crossmark / GemWallet) proof of control.
 *
 * Gate on free-key issuance — must be strict:
 *   1. the public key must derive to the address the client claims (bind key <-> address)
 *   2. the signature must verify against `challengeHex` under that public key
 *      (bind signature <-> our single-use challenge)
 *
 * Wallets differ on whether `signMessage` signs the raw hex or the hex of the
 * challenge's UTF-8 bytes, so we accept a signature that verifies against
 * either encoding — the security properties (right key, right challenge) hold
 * regardless of which byte string was signed.
 */
export function verifyInjectedProof(input: {
  address: string;
  publicKey: string;
  signature: string;
  challengeHex: string;
}): { ok: true } | { ok: false; reason: string } {
  const { address, publicKey, signature, challengeHex } = input;

  if (!/^[0-9A-Fa-f]{2,}$/.test(publicKey) || !/^[0-9A-Fa-f]{2,}$/.test(signature)) {
    return { ok: false, reason: "malformed publicKey or signature" };
  }

  let derived: string;
  try {
    derived = deriveAddress(publicKey);
  } catch {
    return { ok: false, reason: "publicKey does not derive to an address" };
  }
  if (derived !== address) {
    return { ok: false, reason: "signature does not recover to the claimed address" };
  }

  const candidates = [
    challengeHex.toUpperCase(),
    challengeHex.toLowerCase(),
    Buffer.from(challengeHex, "utf8").toString("hex").toUpperCase(),
  ];
  const good = candidates.some((msg) => {
    try {
      return verifySignature(msg, signature, publicKey);
    } catch {
      return false;
    }
  });
  if (!good) return { ok: false, reason: "signature does not verify over the challenge" };

  return { ok: true };
}

// Rolling-window IP limits (counted in Postgres via FreeKeySignup rows).
export const START_PER_IP_PER_HOUR = 8;
export const CLAIM_PER_IP_PER_DAY = 3;

export const SIGNIN_EXPIRE_MINUTES = 10;

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return (
    req.headers.get("x-real-ip") ??
    req.headers.get("x-vercel-forwarded-for") ??
    "unknown"
  );
}

const XRPL_NODES = [
  "https://xrplcluster.com",
  "https://s1.ripple.com:51234",
  "https://s2.ripple.com:51234",
];

/**
 * True only if `address` is an ACTIVATED mainnet account (account_info returns
 * account_data, i.e. it holds the base reserve). This is the anti-farming
 * gate: a throwaway keypair can sign a Xaman SignIn for free, but an activated
 * account costs the ~1 XRP base reserve — enough to make farming 200 free
 * lookups per wallet uneconomical. Fails OPEN on network error so a node
 * outage doesn't block real users (the per-IP + per-wallet caps still hold).
 */
export async function walletIsActivated(address: string): Promise<boolean> {
  for (const url of XRPL_NODES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "account_info",
          params: [{ account: address, ledger_index: "validated" }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => null)) as
        | { result?: { account_data?: unknown; error?: string } }
        | null;
      if (!data?.result) continue;
      if (data.result.error === "actNotFound") return false;
      if (data.result.account_data) return true;
      // any other explicit error from a responding node -> not activated
      if (data.result.error) return false;
    } catch {
      /* try next node */
    }
  }
  return true; // all nodes unreachable — fail open
}
