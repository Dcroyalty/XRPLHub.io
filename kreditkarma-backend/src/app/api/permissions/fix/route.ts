// src/app/api/permissions/fix/route.ts
// POST { action: "revoke_delegation", account, delegate }  → a DelegateSet with an empty Permissions list
// POST { action: "cancel_check", account, checkId }         → a CheckCancel
// The free fixes the Wallet Permissions Check offers. Each is re-verified against the live ledger first (the delegation
// or check must exist and belong to `account`), then returned as an unsigned transaction plus a Xaman sign request.
// FREE. XRPLHub never signs; the wallet owner approves it in their own wallet.

import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { isValidXrplAddress } from "@/lib/address";
import { buildCheckCancel, normalizeCheckId } from "@/lib/checks";
import { buildRevokeDelegation, checkWalletPermissions } from "@/lib/walletPermissions";
import { mainnetRpc } from "@/lib/spendAutopay";
import { createPayload, safeIdentifier, xummConfigured } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const rl = rateLimit(req, "permissions-fix", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; account?: unknown; delegate?: unknown; checkId?: unknown };
  const account = String(b.account ?? "");
  if (!isValidXrplAddress(account)) return json({ error: "bad_request", message: "account must be a valid XRP wallet address." }, 400);

  let report;
  try { report = await checkWalletPermissions(mainnetRpc, account); } catch { return json({ error: "ledger_unavailable", message: "Couldn't read the XRP Ledger just now. Try again in a minute." }, 503); }

  let txjson: Record<string, unknown>, label: string;
  if (b.action === "revoke_delegation") {
    const delegate = String(b.delegate ?? "");
    if (!report.findings.some((f) => f.kind === "delegation_given" && f.who === delegate)) return json({ error: "not_found", message: "This wallet has no delegation to that account (it may already be revoked)." }, 404);
    txjson = buildRevokeDelegation(account, delegate);
    label = `remove every permission you gave ${delegate.slice(0, 8)}…`;
  } else if (b.action === "cancel_check") {
    const checkId = normalizeCheckId(b.checkId);
    if (!checkId || !report.findings.some((f) => f.kind === "check" && String(f.detail.checkId).toUpperCase() === checkId)) return json({ error: "not_found", message: "This wallet has no open check with that ID (it may already be cashed or cancelled)." }, 404);
    const built = buildCheckCancel({ account, checkId });
    if (!built.ok) return json({ error: "build_failed", message: built.error }, 400);
    txjson = built.txjson;
    label = "cancel a check this wallet wrote";
  } else {
    return json({ error: "bad_request", message: "action must be revoke_delegation or cancel_check." }, 400);
  }

  let xaman: { uuid: string; qr_png: string | null; deep_link: string | null; websocket: string | null } | null = null;
  if (xummConfigured()) {
    try {
      const p = await createPayload({ txjson, identifier: safeIdentifier("xrplhub_perm_", account.slice(0, 12), `_${Date.now()}`), instruction: `XRPLHub Wallet Permissions — ${label}. Free.` });
      xaman = { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, websocket: p.websocket ?? null };
    } catch { /* the txjson still works in any wallet */ }
  }
  return json({ txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null, websocket: null }), free: true, note: "Sign it in the wallet that owns this account. XRPLHub never signs." });
}
