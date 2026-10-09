// src/lib/spendApi.ts
// Small shared pieces for the Spend Controls routes (src/app/api/spend/**).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { createPayload, safeIdentifier, xummConfigured } from "@/lib/xumm";

export const spendJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export const spendErr = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => spendJson({ error, message, ...extra }, status);

export async function loadPlan(id: string) {
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return null;
  return prisma.spendPlan.findUnique({ where: { id }, include: { payees: { orderBy: { position: "asc" } } } });
}

/** A Xaman sign request for an unsigned transaction. Null when Xaman isn't configured or refuses — the caller still
 *  returns the txjson, which any wallet (Crossmark / GemWallet / manual) can sign. XRPLHub never signs. */
export async function signRequest(txjson: Record<string, unknown>, label: string, tag: string) {
  if (!xummConfigured()) return null;
  try {
    const p = await createPayload({ txjson, identifier: safeIdentifier("xrplhub_spend_", tag.slice(0, 16), `_${Date.now()}`), instruction: `XRPLHub Spend Controls — ${label}` });
    return { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, websocket: p.websocket ?? null };
  } catch {
    return null;
  }
}

/** Push a sign request straight to the funder's Xaman app (subscriptions: the daily job). Open for 24 h. */
export async function pushSignRequest(txjson: Record<string, unknown>, label: string, tag: string, userToken: string) {
  if (!xummConfigured()) return null;
  try {
    const p = await createPayload({ txjson, userToken, expireMinutes: 1440, identifier: safeIdentifier("xrplhub_spend_", tag.slice(0, 16), `_${Date.now()}`), instruction: `XRPLHub Spend Controls — ${label}` });
    return { uuid: p.uuid, pushed: p.pushed === true };
  } catch {
    return null;
  }
}

/** Shown on every Spend Controls surface (owner copy rules, 2026-10-05). */
export const SPEND_DISCLOSURE = [
  "XRPLHub is not a bank and doesn't send money for you. We never hold your money or your keys.",
  "You approve everything in your own wallet: the payer approves each check, and the person being paid approves cashing it.",
  "A check doesn't set money aside. Keep enough in your wallet — a check can only be cashed while the money is there.",
  "Each open check sets aside 0.2 XRP in the payer's wallet (the XRP Ledger's reserve). You get it back when the check is cashed or cancelled.",
  "We use checks because RLUSD can't be locked up in advance on the XRP Ledger yet.",
  "Monthly or weekly payments are one check per period, made only when that period starts — never ahead, because a check can be cashed as soon as it exists. If you don't approve it, it isn't paid.",
];
