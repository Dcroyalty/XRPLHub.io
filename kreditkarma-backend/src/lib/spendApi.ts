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
  "XRPLHub is not a bank and not a money transmitter. It never holds your funds or your keys.",
  "You sign everything: the funder signs each check, and the merchant signs to cash it, each in their own wallet.",
  "Checks do not lock funds. Keep your allowance in your wallet — a check can only be cashed while the money is there.",
  "Each open check holds 0.2 XRP of the funder's reserve; it comes back when the check is cashed or cancelled.",
  "RLUSD can't be held in escrow yet (its issuer hasn't enabled token escrow), which is why this uses checks.",
  "Subscriptions are one check per period, created only when that period starts — never ahead, because a check can be cashed as soon as it exists. Unsigned means unpaid.",
];
