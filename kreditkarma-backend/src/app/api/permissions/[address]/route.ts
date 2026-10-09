// src/app/api/permissions/[address]/route.ts
// GET /api/permissions/:address — the WALLET PERMISSIONS CHECK for people (the /permissions page): who can move money out
// of this wallet, in plain words, read live from the ledger (src/lib/walletPermissions.ts). FREE and rate-limited.
// Agents and businesses: the same report at GET /api/x402/permissions?address= ($0.02, x402 on Base or XRPL).

import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { isValidXrplAddress } from "@/lib/address";
import { checkWalletPermissions } from "@/lib/walletPermissions";
import { mainnetRpc } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, ctx: { params: Promise<{ address: string }> }) {
  const rl = rateLimit(req, "permissions-free", 12, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { address } = await ctx.params;
  if (!isValidXrplAddress(address)) return json({ error: "bad_request", message: "That isn't a valid XRP wallet address (it starts with r)." }, 400);
  try {
    return json(await checkWalletPermissions(mainnetRpc, address));
  } catch (e) {
    return json({ error: "ledger_unavailable", message: "Couldn't read the XRP Ledger just now. Try again in a minute.", detail: e instanceof Error ? e.message : null }, 503);
  }
}
