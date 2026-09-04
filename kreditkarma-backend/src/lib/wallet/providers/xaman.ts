// src/lib/wallet/providers/xaman.ts
// Xaman as a WalletProvider. Server-mediated: it delegates to the existing
// endpoints (/api/free-key/start already ran; /api/checkout/xaman and
// /api/create-payment build the payload). The behaviour is exactly the
// working Xaman path — this file just gives it the provider shape.

import type {
  WalletProvider,
  ProveContext,
  ProveHandle,
  PaymentContext,
  PaymentHandle,
} from "../types";
import { WalletError } from "../types";

export const xamanProvider: WalletProvider = {
  id: "xaman",
  label: "Xaman",
  kind: "remote",
  installUrl: "https://xaman.app",

  // Availability is really "is Xaman configured on the server" — the flow
  // learns that from /api/free-key/start (xamanAvailable) and from whether a
  // payload came back. Default true so Xaman stays the default option.
  async isAvailable() {
    return true;
  },

  proveControl(ctx: ProveContext): ProveHandle {
    if (!ctx.xamanUuid) {
      return {
        qrPng: null,
        deepLink: null,
        body: Promise.reject(new WalletError("Xaman is not available right now.")),
      };
    }
    return {
      qrPng: ctx.xamanQrPng ?? null,
      deepLink: ctx.xamanDeepLink ?? null,
      // The flow polls /api/free-key/claim with this body (unchanged).
      body: Promise.resolve({ uuid: ctx.xamanUuid }),
    };
  },

  submitPayment(ctx: PaymentContext): PaymentHandle {
    const run = async (): Promise<{ via: "xaman"; uuid: string }> => {
      let res: Response;
      if (ctx.invoiceId) {
        res = await fetch("/api/checkout/xaman", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceId: ctx.invoiceId }),
        });
        const data = await res.json();
        if (!res.ok || !data.uuid) throw new WalletError(data.message ?? "Could not open Xaman.");
        handle.qrPng = data.qrPng ?? null;
        handle.deepLink = data.deepLink ?? null;
        return { via: "xaman", uuid: data.uuid };
      }
      // one of the 35 products
      res = await fetch("/api/create-payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: ctx.productId, currency: ctx.currency, amount: ctx.amount }),
      });
      const data = await res.json();
      if (!res.ok || !data.uuid) throw new WalletError(data.error ?? "Could not open Xaman.");
      handle.qrPng = data.qr_png ?? null;
      handle.deepLink = data.deep_link ?? null;
      return { via: "xaman", uuid: data.uuid };
    };

    const handle: PaymentHandle = { qrPng: null, deepLink: null, result: run() };
    return handle;
  },
};
