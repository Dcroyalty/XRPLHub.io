// src/lib/anchorMemo.ts
// Shared on-ledger memo-anchoring primitive: an AccountSet with NO settings,
// signed by the DEDICATED anchor wallet (ANCHOR_WALLET_SEED ->
// r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb), carrying one JSON Memo. Nothing moves;
// it costs the base fee (~10 drops).
//
// The MPT registry anchor (src/lib/mptAnchor.ts) keeps its own submit path
// unchanged. This module is used by the OFAC screening-receipt anchor
// (src/lib/screenAnchor.ts) — different memo type, different batch, SAME wallet.
// connectMainnetOrThrow still applies: a testnet/devnet endpoint throws.

import { Wallet } from "xrpl";
import { connectMainnetOrThrow } from "./credentials";
import { ANCHOR_ACCOUNT, anchorSigningKeyPresent } from "./mptAnchor";

export { ANCHOR_ACCOUNT, anchorSigningKeyPresent };

const RIPPLE_EPOCH_OFFSET = 946_684_800;
const toHexUpper = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

export interface MemoAnchorResult {
  txHash: string;
  ledgerIndex: number;
  account: string;
  feeDrops: string;
  validated: boolean;
  engineResult: string;
  closeTimeIso: string | null;
}

/**
 * Submit one memo anchor. `memoType` is the human MemoType string (hex-encoded
 * on-ledger); `memoDataJson` is the exact UTF-8 JSON payload (hex-encoded as
 * MemoData). Throws if ANCHOR_WALLET_SEED is absent or derives the wrong account.
 */
export async function submitMemoAnchor(memoType: string, memoDataJson: string): Promise<MemoAnchorResult> {
  const seed = process.env.ANCHOR_WALLET_SEED;
  if (!seed) throw new Error("ANCHOR_WALLET_SEED not set — cannot sign the anchor.");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== ANCHOR_ACCOUNT) {
    throw new Error(`REFUSING: ANCHOR_WALLET_SEED derives ${wallet.classicAddress}, expected ${ANCHOR_ACCOUNT}.`);
  }

  const Memos = [
    {
      Memo: {
        MemoType: toHexUpper(memoType),
        MemoFormat: toHexUpper("application/json"),
        MemoData: toHexUpper(memoDataJson),
      },
    },
  ];

  const client = await connectMainnetOrThrow();
  try {
    const prepared = await client.autofill({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Memos,
    } as unknown as Parameters<typeof client.autofill>[0]);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

    const meta = res.result.meta;
    const engineResult =
      meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";

    const dateVal = (res.result as { date?: number }).date;
    const closeIso = (res.result as { close_time_iso?: string }).close_time_iso ?? null;
    const closeTimeIso =
      typeof dateVal === "number" ? new Date((dateVal + RIPPLE_EPOCH_OFFSET) * 1000).toISOString() : closeIso;

    return {
      txHash: res.result.hash,
      ledgerIndex: res.result.ledger_index ?? 0,
      account: wallet.classicAddress,
      feeDrops: (prepared as { Fee?: string }).Fee ?? "",
      validated: res.result.validated ?? false,
      engineResult,
      closeTimeIso,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}
