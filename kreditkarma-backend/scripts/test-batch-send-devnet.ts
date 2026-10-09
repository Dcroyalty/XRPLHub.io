// scripts/test-batch-send-devnet.ts — Batch Send end to end on XRPL DEVNET with faucet accounts.
// Why Devnet: Batch is enabled on mainnet and Devnet but NOT on Testnet (Testnet answers temDISABLED, 2026-10-09).
// Runs the exact production core (src/lib/batchSend.ts); the sender signs with an xrpl.js Wallet standing in for Xaman.
//
//   node scripts/test-batch-send-devnet.ts

import { Client, Wallet } from "xrpl";
import { BATCH_SEND_MAX, buildBatchSend, preflightBatch, validateRecipients, type Recipient, type Rpc } from "../src/lib/batchSend.ts";

const RPC = "https://s.devnet.rippletest.net:51234";
const rpc: Rpc = async (method, params) => {
  try { const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) }); return ((await r.json()) as { result?: Record<string, unknown> }).result ?? null; }
  catch { return null; }
};
let n = 0;
function ok(c: unknown, what: string) { if (!c) { console.error(`✗ ${what}`); process.exit(1); } n++; console.log(`✓ ${what}`); }
const client = new Client("wss://s.devnet.rippletest.net:51233");
const fund = async () => (await client.fundWallet()).wallet;
const send = async (w: Wallet, tx: Record<string, unknown>) => {
  const r = await client.submitAndWait({ ...tx, Account: w.classicAddress } as Parameters<Client["submitAndWait"]>[0], { wallet: w, autofill: true });
  return String((r.result.meta as { TransactionResult?: string }).TransactionResult);
};
const xrp = async (a: string) => Number(((await rpc("account_info", { account: a, ledger_index: "validated" }))?.account_data as { Balance?: string })?.Balance ?? 0) / 1e6;
const tok = async (a: string, issuer: string) => Number((((await rpc("account_lines", { account: a, peer: issuer, ledger_index: "validated" }))?.lines as { balance?: string }[]) ?? [])[0]?.balance ?? 0);
/** Sign (the Xaman step) and submit, then wait for the validated result of the outer Batch. */
async function signAndSubmit(w: Wallet, tx: Record<string, unknown>) {
  const signed = w.sign(tx as Parameters<Wallet["sign"]>[0]);
  const r = await rpc("submit", { tx_blob: signed.tx_blob });
  const prelim = String(r?.engine_result);
  for (let i = 0; i < 20 && !prelim.startsWith("tef") && !prelim.startsWith("tem"); i++) {
    await new Promise((s) => setTimeout(s, 1500));
    const t = await rpc("tx", { transaction: signed.hash });
    if (t?.validated) return { prelim, final: String((t.meta as { TransactionResult?: string }).TransactionResult) };
  }
  return { prelim, final: null as string | null };
}

async function main() {
  await client.connect();
  console.log("Funding Devnet accounts…");
  const [sender, a, b, c, issuer, gated] = [await fund(), await fund(), await fund(), await fund(), await fund(), await fund()];
  const fresh = Wallet.generate();
  const RLUSD = { issuer: issuer.classicAddress, hex: "524C555344000000000000000000000000000000" };

  // ── shape checks ────────────────────────────────────────────────────────────────────────────────────────────────
  ok(!validateRecipients(sender.classicAddress, [{ address: a.classicAddress, amount: "1" }]).ok, "one recipient is refused (use a normal payment)");
  ok(!validateRecipients(sender.classicAddress, Array.from({ length: BATCH_SEND_MAX + 1 }, () => ({ address: a.classicAddress, amount: "1" }))).ok, `more than ${BATCH_SEND_MAX} is refused`);
  ok(!validateRecipients(sender.classicAddress, [{ address: sender.classicAddress, amount: "1" }, { address: a.classicAddress, amount: "x" }]).ok, "own wallet and a bad amount are refused");

  // ── 1. XRP to three people, one approval ────────────────────────────────────────────────────────────────────────
  const before = await Promise.all([a, b, c].map((w) => xrp(w.classicAddress)));
  const v = validateRecipients(sender.classicAddress, [
    { address: a.classicAddress, amount: "1.5", currency: "XRP" },
    { address: b.classicAddress, amount: "2", currency: "XRP" },
    { address: fresh.classicAddress, amount: "10", currency: "XRP" }, // creates a new account
  ]);
  ok(v.ok, "3 recipients pass the shape checks");
  const recips = (v as { recipients: Recipient[] }).recipients;
  const pf = await preflightBatch(rpc, sender.classicAddress, recips, RLUSD);
  ok(pf.ok, `preflight OK: ${pf.totals?.xrp} XRP, fee ${pf.feeDrops} drops`);
  const tx = buildBatchSend(sender.classicAddress, recips, pf.sequence!, pf.feeDrops!, RLUSD);
  const r1 = await signAndSubmit(sender, tx);
  ok(r1.final === "tesSUCCESS", `one signature, Batch validated (${r1.prelim} → ${r1.final})`);
  ok(Math.abs((await xrp(a.classicAddress)) - before[0] - 1.5) < 1e-9 && Math.abs((await xrp(b.classicAddress)) - before[1] - 2) < 1e-9, "recipient 1 got 1.5 XRP, recipient 2 got 2 XRP");
  ok(Math.abs((await xrp(fresh.classicAddress)) - 10) < 1e-9, "a brand-new wallet was created with 10 XRP");

  // ── 2. All or nothing: one payment can't land → nobody is paid ──────────────────────────────────────────────────
  ok(await send(gated, { TransactionType: "AccountSet", SetFlag: 9 }) === "tesSUCCESS", "a recipient turns on Deposit Authorization");
  const pre2 = await validateRecipients(sender.classicAddress, [{ address: a.classicAddress, amount: "1" }, { address: gated.classicAddress, amount: "1" }]);
  const pf2 = await preflightBatch(rpc, sender.classicAddress, (pre2 as { recipients: Recipient[] }).recipients, RLUSD);
  ok(!pf2.ok && pf2.problems[0]?.address === gated.classicAddress, `preflight refuses it first: "${pf2.problems[0]?.error}"`);
  // Build it anyway (skipping preflight) to prove the ledger's all-or-nothing guarantee.
  const aBefore = await xrp(a.classicAddress);
  const tx2 = buildBatchSend(sender.classicAddress, (pre2 as { recipients: Recipient[] }).recipients, pf2.sequence!, pf2.feeDrops!, RLUSD);
  const r2 = await signAndSubmit(sender, tx2);
  ok(r2.final !== null, `forced batch with one impossible payment: outer ${r2.final}`);
  ok(Math.abs((await xrp(a.classicAddress)) - aBefore) < 1e-9, "ALL OR NOTHING: the payable recipient got nothing either");

  // ── 3. RLUSD (stand-in issuer with the same currency code) ──────────────────────────────────────────────────────
  ok(await send(issuer, { TransactionType: "AccountSet", SetFlag: 8 }) === "tesSUCCESS", "stand-in issuer enables rippling");
  for (const w of [sender, b, c]) await send(w, { TransactionType: "TrustSet", LimitAmount: { currency: RLUSD.hex, issuer: issuer.classicAddress, value: "1000" } });
  ok(await send(issuer, { TransactionType: "Payment", Destination: sender.classicAddress, Amount: { currency: RLUSD.hex, issuer: issuer.classicAddress, value: "100" } }) === "tesSUCCESS", "sender holds 100 RLUSD");
  const noLine = await preflightBatch(rpc, sender.classicAddress, [{ address: a.classicAddress, amount: "5", currency: "RLUSD" }, { address: b.classicAddress, amount: "5", currency: "RLUSD" }], RLUSD);
  ok(!noLine.ok && noLine.problems[0]?.address === a.classicAddress, `RLUSD to a wallet without the RLUSD line is refused: "${noLine.problems[0]?.error}"`);
  const rl: Recipient[] = [{ address: b.classicAddress, amount: "12.5", currency: "RLUSD" }, { address: c.classicAddress, amount: "7.5", currency: "RLUSD" }];
  const pf3 = await preflightBatch(rpc, sender.classicAddress, rl, RLUSD);
  ok(pf3.ok, "RLUSD batch preflight OK");
  const r3 = await signAndSubmit(sender, buildBatchSend(sender.classicAddress, rl, pf3.sequence!, pf3.feeDrops!, RLUSD));
  ok(r3.final === "tesSUCCESS" && Math.abs((await tok(b.classicAddress, issuer.classicAddress)) - 12.5) < 1e-9 && Math.abs((await tok(c.classicAddress, issuer.classicAddress)) - 7.5) < 1e-9, "RLUSD batch: 12.5 and 7.5 delivered with one signature");

  // ── 4. A stale request (sender sent something else first) pays nobody ───────────────────────────────────────────
  const pf4 = await preflightBatch(rpc, sender.classicAddress, [{ address: a.classicAddress, amount: "1", currency: "XRP" }, { address: b.classicAddress, amount: "1", currency: "XRP" }], RLUSD);
  const stale = buildBatchSend(sender.classicAddress, [{ address: a.classicAddress, amount: "1", currency: "XRP" }, { address: b.classicAddress, amount: "1", currency: "XRP" }], pf4.sequence!, pf4.feeDrops!, RLUSD);
  await send(sender, { TransactionType: "AccountSet" }); // any other transaction moves the sequence on
  const aB = await xrp(a.classicAddress);
  const r4 = await signAndSubmit(sender, stale);
  ok(r4.prelim === "tefPAST_SEQ" && Math.abs((await xrp(a.classicAddress)) - aB) < 1e-9, `stale request refused (${r4.prelim}); nobody paid`);

  await client.disconnect();
  console.log(`\nAll ${n} checks passed on XRPL Devnet.`);
}
main().catch(async (e) => { console.error(e); await client.disconnect().catch(() => {}); process.exit(1); });
