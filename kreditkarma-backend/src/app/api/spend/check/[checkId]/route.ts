// src/app/api/spend/check/[checkId]/route.ts
// The MERCHANT side of Spend Controls — free.
//   GET  -> the check, read live from the ledger: who wrote it, to whom, up to how much, until when, and whether the
//           writer's wallet holds enough right now (checks don't lock funds).
//   POST { amount } -> an unsigned CheckCash for that exact amount (at most the check's maximum), signed by the
//           merchant (the check's Destination) in their own wallet. No RLUSD trust line needed beforehand.
// Uses the same check builder as the storefront's Cash a Check service (src/lib/checks.ts).

import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { xrplRpc } from "@/lib/xrplNodes";
import { buildCheckCash, normalizeCheckId, RIPPLE_EPOCH } from "@/lib/checks";
import { RLUSD_HEX, RLUSD_ISSUER } from "@/lib/pricing";
import { rlusdBalance } from "@/lib/spendControls";
import { signRequest, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

type CheckNode = { Account: string; Destination: string; SendMax: string | { currency: string; issuer: string; value: string }; Expiration?: number; DestinationTag?: number; LedgerEntryType?: string };

async function readCheck(checkId: string) {
  const r = await xrplRpc("ledger_entry", { check: checkId, ledger_index: "validated" });
  if (!r.ok) return { error: "ledger" as const };
  const res = r.body.result as { node?: CheckNode; error?: string };
  if (res?.error === "entryNotFound") return { error: "gone" as const };
  if (!res?.node || res.node.LedgerEntryType !== "Check") return { error: "ledger" as const };
  return { node: res.node };
}

function describe(n: CheckNode) {
  const rlusd = typeof n.SendMax === "object" && n.SendMax.currency.toUpperCase() === RLUSD_HEX && n.SendMax.issuer === RLUSD_ISSUER;
  const xrp = typeof n.SendMax === "string";
  return {
    from: n.Account, to: n.Destination,
    currency: (rlusd ? "RLUSD" : xrp ? "XRP" : "OTHER") as "RLUSD" | "XRP" | "OTHER",
    upTo: xrp ? String(Number(n.SendMax) / 1e6) : (n.SendMax as { value: string }).value,
    expires: n.Expiration ? new Date((n.Expiration + RIPPLE_EPOCH) * 1000).toISOString() : null,
    expired: n.Expiration ? Date.now() / 1000 - RIPPLE_EPOCH >= n.Expiration : false,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ checkId: string }> }) {
  const rl = rateLimit(req, "spend-check", 40, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const checkId = normalizeCheckId((await ctx.params).checkId);
  if (!checkId) return spendErr(400, "bad_request", "A check ID is 64 hexadecimal characters.");
  const c = await readCheck(checkId);
  if ("error" in c) return c.error === "gone" ? spendErr(404, "gone", "This check no longer exists — it was already cashed or cancelled.") : spendErr(503, "ledger_unavailable", "Could not read the XRP Ledger just now — try again.");
  const d = describe(c.node);
  const balance = d.currency === "RLUSD" ? await rlusdBalance(d.from) : null;
  return spendJson({
    checkId, ...d,
    writerHolds: balance,
    coverable: balance === null ? null : balance + 1e-9 >= Number(d.upTo),
    notes: [
      "Only the account the check is written to can cash it, by signing with its own wallet. Cashing is free on XRPLHub.",
      "One check pays once: cashing for less than the maximum still closes it.",
      "No RLUSD trust line is needed beforehand — cashing creates it, using 0.2 XRP of your reserve the first time.",
    ],
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ checkId: string }> }) {
  const rl = rateLimit(req, "spend-cash", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const checkId = normalizeCheckId((await ctx.params).checkId);
  if (!checkId) return spendErr(400, "bad_request", "A check ID is 64 hexadecimal characters.");
  const body = (await req.json().catch(() => ({}))) as { amount?: unknown };
  const c = await readCheck(checkId);
  if ("error" in c) return c.error === "gone" ? spendErr(404, "gone", "This check no longer exists — it was already cashed or cancelled.") : spendErr(503, "ledger_unavailable", "Could not read the XRP Ledger just now — try again.");
  const d = describe(c.node);
  if (d.expired) return spendErr(409, "expired", "This check has expired and can no longer be cashed.");
  if (d.currency === "OTHER") return spendErr(400, "unsupported", "Only XRP and RLUSD checks can be cashed here.");
  const amount = String(body.amount ?? d.upTo).trim();
  if (!(Number(amount) > 0) || Number(amount) > Number(d.upTo) + 1e-12) return spendErr(400, "bad_amount", `Enter an amount up to ${d.upTo} ${d.currency}.`);
  // The ledger only lets the Destination cash it, so the merchant signs as the Destination.
  const b = buildCheckCash({ account: d.to, checkId, currency: d.currency, amount });
  if (!b.ok) return spendErr(400, "build_failed", b.error);
  const xaman = await signRequest(b.txjson, `cash ${amount} ${d.currency}`, checkId);
  return spendJson({ checkId, txjson: b.txjson, signWith: d.to, free: true, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null }) });
}
