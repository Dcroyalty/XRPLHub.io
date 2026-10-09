// scripts/test-permissions-testnet.ts — Wallet Permissions Check against XRPL TESTNET with faucet accounts.
// Runs the exact production core (src/lib/walletPermissions.ts): sets up a regular key, a delegation, a check, a
// DEX offer and a ticket, checks the report, then signs the free fixes (revoke delegation, cancel check) and re-checks.
//
//   node scripts/test-permissions-testnet.ts

import { Client, Wallet } from "xrpl";
import { buildRevokeDelegation, checkWalletPermissions, describePermission, type Rpc } from "../src/lib/walletPermissions.ts";

const RPC_URL = "https://s.altnet.rippletest.net:51234";
const rpc: Rpc = async (method, params) => {
  try {
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
    return ((await r.json()) as { result?: Record<string, unknown> }).result ?? null;
  } catch { return null; }
};
let n = 0;
function ok(c: unknown, what: string) { if (!c) { console.error(`✗ ${what}`); process.exit(1); } n++; console.log(`✓ ${what}`); }

const client = new Client("wss://s.altnet.rippletest.net:51233");
const send = async (w: Wallet, tx: Record<string, unknown>) => {
  const r = await client.submitAndWait({ ...tx, Account: w.classicAddress } as Parameters<Client["submitAndWait"]>[0], { wallet: w, autofill: true });
  return String((r.result.meta as { TransactionResult?: string }).TransactionResult);
};

async function main() {
  await client.connect();
  const [owner, agent, payee, regKey] = [(await client.fundWallet()).wallet, (await client.fundWallet()).wallet, (await client.fundWallet()).wallet, Wallet.generate()];
  console.log(`owner ${owner.classicAddress} · agent ${agent.classicAddress} · payee ${payee.classicAddress}`);

  // 0. A fresh wallet: only its own key.
  const r0 = await checkWalletPermissions(rpc, owner.classicAddress);
  ok(r0.exists && r0.canMoveMoney.length === 0, `fresh wallet: "${r0.headline}"`);
  const missing = await checkWalletPermissions(rpc, Wallet.generate().classicAddress);
  ok(!missing.exists, `unfunded address: "${missing.headline}"`);

  // 1. Give it powers others can use.
  ok(await send(owner, { TransactionType: "SetRegularKey", RegularKey: regKey.classicAddress }) === "tesSUCCESS", "set a regular key");
  ok(await send(owner, { TransactionType: "DelegateSet", Authorize: agent.classicAddress, Permissions: [{ Permission: { PermissionValue: "Payment" } }, { Permission: { PermissionValue: "AccountDomainSet" } }] }) === "tesSUCCESS", "delegate Payment + AccountDomainSet to the agent");
  ok(await send(owner, { TransactionType: "CheckCreate", Destination: payee.classicAddress, SendMax: "5000000" }) === "tesSUCCESS", "write a 5 XRP check to the payee");
  ok(await send(owner, { TransactionType: "OfferCreate", TakerGets: "1000000", TakerPays: { currency: "USD", issuer: payee.classicAddress, value: "1" } }) === "tesSUCCESS", "place a DEX offer");
  ok(await send(owner, { TransactionType: "TicketCreate", TicketCount: 1 }) === "tesSUCCESS", "create a ticket");

  const r1 = await checkWalletPermissions(rpc, owner.classicAddress);
  const kinds = (k: string) => r1.findings.filter((f) => f.kind === k);
  ok(kinds("regular_key")[0]?.who === regKey.classicAddress, `regular key found: "${kinds("regular_key")[0]?.plain}"`);
  const dg = kinds("delegation_given")[0];
  ok(dg?.who === agent.classicAddress && dg.level === "danger" && JSON.stringify(dg.detail.permissions) === JSON.stringify(["Payment", "AccountDomainSet"]), `delegation found: "${dg?.plain}"`);
  ok(dg?.fix?.action === "revoke_delegation", "delegation offers a free revoke");
  const ck = kinds("check")[0];
  ok(ck?.who === payee.classicAddress && ck.fix?.action === "cancel_check", `check found: "${ck?.plain}"`);
  ok(kinds("dex_offer").length === 1 && kinds("tickets")[0]?.detail.tickets === 1, "offer and ticket found");
  ok(r1.canMoveMoney.length === 3, `headline: "${r1.headline}" (${r1.canMoveMoney.map((m) => m.how).join(" | ")})`);

  // The agent sees the delegation from its side.
  const ra = await checkWalletPermissions(rpc, agent.classicAddress);
  const recv = ra.findings.find((f) => f.kind === "delegation_received");
  ok(!recv || recv.who === owner.classicAddress, recv ? `agent side: "${recv.plain}"` : "agent side: delegation is listed only under the owner (no DestinationNode copy in the agent's objects)");

  // 2. The free fixes.
  ok(await send(owner, buildRevokeDelegation(owner.classicAddress, agent.classicAddress)) === "tesSUCCESS", "revoke the delegation (DelegateSet, empty Permissions)");
  ok(await send(owner, { TransactionType: "CheckCancel", CheckID: String(ck!.detail.checkId) }) === "tesSUCCESS", "cancel the check");
  ok(await send(owner, { TransactionType: "SetRegularKey" }) === "tesSUCCESS", "remove the regular key (master key still on)");
  const r2 = await checkWalletPermissions(rpc, owner.classicAddress);
  ok(r2.canMoveMoney.length === 0 && !r2.findings.some((f) => ["delegation_given", "check", "regular_key"].includes(f.kind)), `after the fixes: "${r2.headline}"`);

  // 3. Decoding numeric permission values too.
  ok(describePermission(1).name === "Payment" && describePermission(65545).name === "PaymentMint", "numeric permission values decode");
  await client.disconnect();
  console.log(`\nAll ${n} checks passed on XRPL Testnet.`);
}
main().catch(async (e) => { console.error(e); await client.disconnect().catch(() => {}); process.exit(1); });
