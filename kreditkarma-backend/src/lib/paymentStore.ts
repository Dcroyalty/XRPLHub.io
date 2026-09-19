// src/lib/paymentStore.ts
// Prisma adapter for paymentGate's PurchaseStore. The payment hash is Purchase.txHash,
// which is UNIQUE in the schema — that constraint plus the compare-and-set updates below
// is what makes a payment single-use "in the database". No schema change is needed.

import { db } from "@/lib/db";
import type { PurchaseRow, PurchaseStore } from "./paymentGate";

const toRow = (r: { id: string; productId: string; wallet: string | null; status: string; serviceTxHash: string | null }): PurchaseRow => ({
  id: r.id,
  productId: r.productId,
  wallet: r.wallet,
  status: r.status,
  serviceTxHash: r.serviceTxHash,
});

export function prismaPurchaseStore(): PurchaseStore {
  return {
    async find(txHash) {
      const r = await db.purchase.findUnique({ where: { txHash } });
      return r ? toRow(r) : null;
    },
    async create(row) {
      try {
        const r = await db.purchase.create({
          data: { productId: row.productId, wallet: row.wallet, currency: row.currency, amount: row.amount, txHash: row.txHash, status: row.status },
        });
        return toRow(r);
      } catch (e) {
        if ((e as { code?: string })?.code === "P2002") return "exists"; // unique txHash: someone else won the insert
        throw e;
      }
    },
    async casStatus(id, from, to) {
      const r = await db.purchase.updateMany({ where: { id, status: from }, data: { status: to } });
      return r.count === 1;
    },
    async casProgress(id, from, to) {
      const r = await db.purchase.updateMany({
        where: { id, serviceTxHash: from },
        data: { serviceTxHash: to.serviceTxHash, status: to.status, ...(to.deliveredAt ? { deliveredAt: to.deliveredAt } : {}) },
      });
      return r.count === 1;
    },
  };
}
