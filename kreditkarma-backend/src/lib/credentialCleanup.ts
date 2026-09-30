// src/lib/credentialCleanup.ts
// TS port of scripts/cleanup-unaccepted-credentials.mjs's --delete path, for the automatic cron. Reserve-
// recycling policy (unchanged from that script -- see its header for the full reasoning): delete an
// UNACCEPTED credential once it has been EXPIRED for more than GRACE_DAYS, across every io.xrplhub.*
// family. An ACCEPTED credential's reserve belongs to the subject, never touched here.
//
// Walks the issuer's OWN account_objects (authoritative and complete, independent of CredentialRequest --
// catches anything issued outside the normal flow too, exactly like the hand-run script did). Dormant
// (a clean no-op) whenever CREDENTIAL_ISSUER_SEED is unset.

import { Wallet, unixTimeToRippleTime } from "xrpl";
import { xrplRpc } from "./xrplNodes";
import { connectMainnetOrThrow, EXPECTED_ISSUER } from "./credentials";

export const DEFAULT_GRACE_DAYS = 7;
const LSF_ACCEPTED = 0x00010000;
const MAX_DELETES_PER_RUN = 10; // bounded like every other cron step

interface CredentialObjectNode {
  Subject: string;
  CredentialType: string;
  Expiration?: number;
  Flags?: number;
  index: string;
}

async function allIssuerCredentials(): Promise<CredentialObjectNode[]> {
  const out: CredentialObjectNode[] = [];
  let marker: unknown = undefined;
  for (let page = 0; page < 20; page++) {
    // bounded -- the issuer's own credential count is small (each one costs 0.2 XRP reserve), 20*200 is generous
    const r = await xrplRpc("account_objects", { account: EXPECTED_ISSUER, ledger_index: "validated", type: "credential", limit: 200, ...(marker ? { marker } : {}) });
    if (!r.ok) break;
    const result = (r.body.result ?? {}) as { account_objects?: CredentialObjectNode[]; marker?: unknown };
    out.push(...(result.account_objects ?? []));
    marker = result.marker;
    if (!marker) break;
  }
  return out;
}

export interface CleanupResult {
  ran: boolean;
  reason?: string;
  totalHeld: number;
  qualifying: number;
  deleted: number;
  failed: number;
}

export async function runExpiredCredentialCleanup(opts: { graceDays?: number; deadlineMs?: number } = {}): Promise<CleanupResult> {
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  if (!seed) {
    return { ran: false, reason: "CREDENTIAL_ISSUER_SEED is not set — reserve stays locked until a human runs scripts/cleanup-unaccepted-credentials.mjs, or this is set.", totalHeld: 0, qualifying: 0, deleted: 0, failed: 0 };
  }
  const deadline = opts.deadlineMs ?? Date.now() + 20_000;

  const nowRipple = unixTimeToRippleTime(Date.now());
  const graceSeconds = graceDays * 86_400;
  const all = await allIssuerCredentials();
  const qualifying = all.filter((n) => {
    const accepted = (Number(n.Flags || 0) & LSF_ACCEPTED) !== 0;
    const expiredSeconds = typeof n.Expiration === "number" ? nowRipple - n.Expiration : -Infinity; // no Expiration = never qualifies
    return !accepted && expiredSeconds > graceSeconds;
  });

  if (qualifying.length === 0) {
    return { ran: true, totalHeld: all.length, qualifying: 0, deleted: 0, failed: 0 };
  }

  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== EXPECTED_ISSUER) {
    throw new Error(`REFUSING: CREDENTIAL_ISSUER_SEED derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}.`);
  }

  const client = await connectMainnetOrThrow();
  let deleted = 0, failed = 0;
  try {
    for (const n of qualifying.slice(0, MAX_DELETES_PER_RUN)) {
      if (Date.now() > deadline) break;
      try {
        const tx = { TransactionType: "CredentialDelete" as const, Account: EXPECTED_ISSUER, Issuer: EXPECTED_ISSUER, Subject: n.Subject, CredentialType: n.CredentialType };
        const prepared = await client.autofill(tx);
        const signed = wallet.sign(prepared);
        const res = await client.submitAndWait(signed.tx_blob);
        const meta = res.result.meta;
        const result = meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
        if (result === "tesSUCCESS") deleted++;
        else failed++;
      } catch {
        failed++;
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }

  return { ran: true, totalHeld: all.length, qualifying: qualifying.length, deleted, failed };
}
