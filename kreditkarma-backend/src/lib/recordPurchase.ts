// src/lib/recordPurchase.ts
// Records or upgrades a verified storefront purchase DIRECTLY in the database.
//
// WHY THIS EXISTS: purchases were previously written by having an API route make
// an INTERNAL HTTP call to /api/purchase using process.env.NEXT_PUBLIC_API_URL.
// On the Node runtime a relative fetch (base = "") THROWS, and the error was
// swallowed (Promise.allSettled(...).catch(() => {})). Net effect: a real, paid
// purchase could verify on-chain yet never be recorded â€” Purchase stays empty
// even with buyers. This helper runs in-process against Prisma: no HTTP hop, no
// env-var dependency, and it cannot silently drop a sale.

import { db } from "@/lib/db";
import { notifyError } from "@/lib/notify";

export interface RecordPurchaseInput {
  productId?: string;
  currency?: string;
  amount?: string;
  email?: string | null;
  sender?: string | null;        // payer / signer wallet
  txHash?: string | null;        // the PAYMENT transaction hash (unique key)
  serviceTxHash?: string | null; // the delivered service transaction hash
  status?: string;               // VERIFIED | DELIVERED | ...
  verifiedAt?: string | Date;
  deliveredAt?: string | Date | null;
}

// Never throws. Returns the row id on success, or null on failure (logged) â€”
// callers must still deliver to the paying customer regardless.
export async function recordPurchase(
  input: RecordPurchaseInput
): Promise<{ id: string } | null> {
  try {
    const {
      productId, currency, amount, email, sender,
      txHash, serviceTxHash, status, verifiedAt, deliveredAt,
    } = input;

    // If a row already exists for this payment tx, upgrade it in place (this is
    // the execute/verify step marking it DELIVERED with the service tx hash).
    if (txHash) {
      const existing = await db.purchase.findFirst({ where: { txHash } }).catch(() => null);
      if (existing) {
        const updated = await db.purchase.update({
          where: { id: existing.id },
          data: {
            serviceTxHash: serviceTxHash ?? existing.serviceTxHash,
            status: status ?? existing.status,
            deliveredAt: deliveredAt ? new Date(deliveredAt) : existing.deliveredAt,
          },
        });
        return { id: updated.id };
      }
    }

    const row = await db.purchase.create({
      data: {
        productId: String(productId ?? ""),
        currency: String(currency ?? "XRP"),
        amount: String(amount ?? "0"),
        email: email ?? null,
        wallet: sender ?? null,
        txHash: txHash ?? null,
        serviceTxHash: serviceTxHash ?? null,
        status: status ?? "VERIFIED",
        verifiedAt: verifiedAt ? new Date(verifiedAt) : new Date(),
        deliveredAt: deliveredAt ? new Date(deliveredAt) : null,
      },
    });
    return { id: row.id };
  } catch (err) {
    // A verified, paid-for purchase that we failed to record — the customer
    // paid and our books don't show it. This must be loud.
    void notifyError("lib/recordPurchase", err, {
      productId: input.productId ?? null,
      txHash: input.txHash ?? null,
      currency: input.currency ?? null,
      amount: input.amount ?? null,
      sender: input.sender ?? null,
    });
    console.error("[recordPurchase]", err instanceof Error ? err.message : "purchase write failed");
    return null;
  }
}
