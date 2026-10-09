// scripts/test-autopay-testnet.ts — end-to-end test of Spend Controls Autopay on XRPL TESTNET with faucet accounts.
// Runs the exact production core (src/lib/autopay.ts). Each payer signature is made with an xrpl.js Wallet standing in
// for Xaman; Xaman's own behaviour (keeps our LastLedgerSequence, Sequence 0 and TicketSequence; signs without
// submitting) was proven on mainnet with probe 427afc24 on 2026-10-09.
//
//   node scripts/test-autopay-testnet.ts
//
// Testnet only: no real money. Exits non-zero on the first failed assertion.

import { Client, Wallet } from "xrpl";
import {
  acceptSignedBlob, autopayPeriods, autopayPreflight, buildAutopayPayment, buildTicketBurn, buildTicketBurnBatch,
  buildTicketCreate, encryptBlob, decryptBlob, lastLedgerFor, processRow, ticketsFromTx, ticketsOnLedger, validatedLedger,
  AUTOPAY_GRACE_S, type DueRow, type Rpc, type RowPatch,
} from "../src/lib/autopay.ts";

const RPC_URL = "https://s.altnet.rippletest.net:51234";
const WS_URL = "wss://s.altnet.rippletest.net:51233";
const FAUCET = "https://faucet.altnet.rippletest.net/accounts";
const SECRET = "testnet-autopay-key";
const RLUSD = { issuer: "", hex: "524C555344000000000000000000000000000000" };

let passed = 0;
function ok(cond: unknown, what: string): void {
  if (!cond) { console.error(`✗ ${what}`); process.exit(1); }
  passed++; console.log(`✓ ${what}`);
}

const rpc: Rpc = async (method, params) => {
  try {
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
    return ((await r.json()) as { result?: Record<string, unknown> }).result ?? null;
  } catch { return null; }
};
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));

async function fund(): Promise<Wallet> {
  const w = Wallet.generate();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination: w.classicAddress }) });
    if (r.ok) break;
    await sleep(3000);
  }
  for (let i = 0; i < 20; i++) {
    const a = await rpc("account_info", { account: w.classicAddress, ledger_index: "validated" });
    if (a && !a.error) return w;
    await sleep(2000);
  }
  throw new Error("faucet did not fund " + w.classicAddress);
}

const client = new Client(WS_URL);
async function send(w: Wallet, tx: Record<string, unknown>): Promise<{ hash: string; code: string }> {
  const r = await client.submitAndWait({ ...tx, Account: w.classicAddress } as Parameters<Client["submitAndWait"]>[0], { wallet: w, autofill: true });
  return { hash: String(r.result.hash), code: String((r.result.meta as { TransactionResult?: string }).TransactionResult) };
}
async function xrp(account: string): Promise<number> {
  const a = await rpc("account_info", { account, ledger_index: "validated" });
  return Number((a?.account_data as { Balance?: string })?.Balance ?? 0) / 1e6;
}
async function rlusd(account: string): Promise<number> {
  const r = await rpc("account_lines", { account, peer: RLUSD.issuer, ledger_index: "validated" });
  return Number(((r?.lines as { balance?: string }[]) ?? [])[0]?.balance ?? 0);
}

// In-memory stand-in for the SpendAutopayPayment table.
type Row = DueRow & { ticket: number; amount: string; result?: string; reason?: string };
const rows = new Map<string, Row>();
const notices: { id: string; kind: string; reason: string }[] = [];
const update = async (id: string, p: RowPatch) => { const r = rows.get(id)!; Object.assign(r, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))); };
const notify = async (id: string, kind: "failed" | "missed", reason: string) => { notices.push({ id, kind, reason }); };
const run = (row: Row, now: Date) => processRow(row, { rpc, now, secret: SECRET, update, notify, settleWaitMs: 20_000 });

/** Payer pre-signs one payment per period (the Xaman step), we accept + encrypt it. */
async function presign(tag: string, payer: Wallet, payee: string, currency: "XRP" | "RLUSD", amount: string, period: "weekly" | "monthly", tickets: number[]): Promise<Row[]> {
  const ledger = (await validatedLedger(rpc))!;
  const periods = autopayPeriods(period, new Date(), tickets.length);
  return periods.map((p, k) => {
    const lastLedger = lastLedgerFor(new Date(p.end.getTime() + AUTOPAY_GRACE_S * 1000), ledger);
    const txjson = buildAutopayPayment({ account: payer.classicAddress, destination: payee, destinationTag: null, currency, amount, ticket: tickets[k], lastLedger }, RLUSD);
    const signed = payer.sign(txjson as Parameters<Wallet["sign"]>[0]);
    const acc = acceptSignedBlob(signed.tx_blob, txjson);
    if (!acc.ok) throw new Error(acc.error);
    const id = `${tag}-${k + 1}`;
    const row: Row = { id, periodStart: p.start, periodEnd: p.end, status: "scheduled", blobEnc: encryptBlob(signed.tx_blob, SECRET, id), txHash: acc.hash, attempts: 0, ticket: tickets[k], amount };
    rows.set(id, row);
    return row;
  });
}

async function main() {
  await client.connect();
  console.log("Funding faucet accounts…");
  const [payer, payee, sink, issuer, payer2, payee2, noLine] = [await fund(), await fund(), await fund(), await fund(), await fund(), await fund(), await fund()];
  RLUSD.issuer = issuer.classicAddress;

  // ── A. XRP subscription, weekly, 3 periods ──────────────────────────────────────────────────────────────────────
  console.log("\nA. XRP autopay, weekly × 3");
  const pre = await autopayPreflight(rpc, { funder: payer.classicAddress, payee: payee.classicAddress, destinationTag: null, currency: "XRP", amount: "5", periods: 3 }, RLUSD);
  ok(pre.ok, `preflight passes (reserve ${pre.ok ? pre.reserveXrp : "?"} XRP for 3 tickets)`);

  const tc = await send(payer, buildTicketCreate(payer.classicAddress, 3));
  ok(tc.code === "tesSUCCESS", "payer's one TicketCreate(3) succeeds");
  const tk = await ticketsFromTx(rpc, tc.hash, payer.classicAddress);
  ok(tk.ok && tk.tickets.length === 3, `3 tickets read from the TicketCreate: ${tk.ok ? tk.tickets.join(",") : ""}`);
  const tickets = tk.ok ? tk.tickets : [];
  ok(JSON.stringify(await ticketsOnLedger(rpc, payer.classicAddress)) === JSON.stringify(tickets), "the same 3 tickets are on the ledger");
  const wrongTk = await ticketsFromTx(rpc, tc.hash, payee.classicAddress);
  ok(!wrongTk.ok && !wrongTk.retry, "a TicketCreate from another account is refused");

  const [r1, r2, r3] = await presign("xrp", payer, payee.classicAddress, "XRP", "5", "weekly", tickets);
  const dec = (await import("xrpl")).decode(decryptBlob(r3.blobEnc!, SECRET, r3.id)) as Record<string, unknown>;
  const ledgerNow = (await validatedLedger(rpc))!.index;
  ok(dec.Sequence === 0 && dec.TicketSequence === tickets[2] && Number(dec.LastLedgerSequence) > ledgerNow + 500_000,
    `period 3's signed payment: Sequence 0, ticket ${tickets[2]}, LastLedgerSequence ${dec.LastLedgerSequence} (now ${ledgerNow})`);
  let threw = false; try { decryptBlob(r3.blobEnc!, SECRET, r1.id); } catch { threw = true; }
  ok(threw, "an encrypted payment can't be read under another row's id");
  threw = false; try { decryptBlob(r3.blobEnc!, "wrong-key", r3.id); } catch { threw = true; }
  ok(threw, "an encrypted payment can't be read with the wrong key");

  // Never early.
  const payeeStart = await xrp(payee.classicAddress);
  ok(await run(r1, new Date(r1.periodStart.getTime() - 1)) === "waiting", "1 ms before period 1 starts: nothing is sent");
  ok(await run(r2, new Date(r1.periodStart.getTime() + 3_600_000)) === "waiting", "during period 1, period 2's payment is not sent");
  ok((await rpc("tx", { transaction: r1.txHash }))?.error === "txnNotFound", "period 1's payment is not on the ledger yet");

  // Period 1: paid.
  const o1 = await run(r1, new Date(r1.periodStart.getTime() + 3_600_000));
  ok(o1 === "paid" && r1.status === "paid", `period 1 starts: payment sent and validated (${o1})`);
  ok(Math.abs((await xrp(payee.classicAddress)) - payeeStart - 5) < 1e-9, "payee received exactly 5 XRP");
  ok(await run(r1, new Date(r1.periodStart.getTime() + 7_200_000)) === "skipped", "running again does not send period 1 twice");

  // Period 2: the payer's wallet is short → fails on the ledger, both sides told, never retried.
  const info = await rpc("account_info", { account: payer.classicAddress, ledger_index: "validated" });
  const owner = Number((info?.account_data as { OwnerCount?: number }).OwnerCount);
  const spendable = (await xrp(payer.classicAddress)) - (1 + 0.2 * owner);
  await send(payer, { TransactionType: "Payment", Destination: sink.classicAddress, Amount: String(Math.floor((spendable - 2) * 1e6)) });
  const n0 = notices.length;
  const o2 = await run(r2, new Date(r2.periodStart.getTime() + 3_600_000));
  ok(o2 === "failed" && r2.status === "failed" && r2.result === "tecUNFUNDED_PAYMENT", `period 2 with too little XRP: failed (${r2.result}) — "${r2.reason}"`);
  ok(notices.length === n0 + 1 && notices[n0].id === r2.id, "the failure was reported once (the glue tells payer and payee)");
  const att = r2.attempts;
  ok(await run(r2, new Date(r2.periodStart.getTime() + 7_200_000)) === "skipped" && r2.attempts === att, "a failed payment is never retried");
  ok(!(await ticketsOnLedger(rpc, payer.classicAddress))!.includes(tickets[1]), "the failed payment still used up its ticket (reserve returned)");

  // Period 3: the payer cancels by using up the ticket → the payment can never be sent, by anyone.
  const burn = await send(payer, buildTicketBurn(payer.classicAddress, tickets[2]));
  ok(burn.code === "tesSUCCESS", "payer's ticket-burn (no-op AccountSet on ticket 3) succeeds");
  const leaked = await rpc("submit", { tx_blob: decryptBlob(r3.blobEnc!, SECRET, r3.id) });
  ok(leaked?.engine_result === "tefNO_TICKET", `the signed period-3 payment is now dead even if submitted directly (${leaked?.engine_result})`);
  const o3 = await run(r3, new Date(r3.periodStart.getTime() + 3_600_000));
  ok(o3 === "cancelled" && r3.status === "cancelled", "the scheduler marks period 3 cancelled, no failure notice");
  ok((await ticketsOnLedger(rpc, payer.classicAddress))!.length === 0, "no tickets left: all reserve returned");

  // Missed: a row whose window closed without being sent is never sent late.
  const late: Row = { ...r1, id: "late", status: "scheduled", attempts: 0 };
  rows.set("late", late);
  ok(await run(late, new Date(r1.periodEnd.getTime() + AUTOPAY_GRACE_S * 1000 + 1)) === "paid", "a row already paid on the ledger settles as paid, even late");
  const missed: Row = { ...r2, id: "missed", status: "scheduled", txHash: "0".repeat(64), blobEnc: r2.blobEnc, attempts: 0 };
  rows.set("missed", missed);
  ok(await run(missed, new Date(r2.periodEnd.getTime() + AUTOPAY_GRACE_S * 1000 + 1)) === "missed", "after the period's end + grace, an unsent payment is marked missed, not sent");

  // ── B. Tampering: we only store exactly the payment we asked for ───────────────────────────────────────────────
  console.log("\nB. Signed-payment checks");
  const lg = (await validatedLedger(rpc))!;
  const want = buildAutopayPayment({ account: payer2.classicAddress, destination: payee2.classicAddress, destinationTag: null, currency: "XRP", amount: "1", ticket: 99, lastLedger: lg.index + 1000 }, RLUSD);
  const sig = (t: Record<string, unknown>) => payer2.sign(t as Parameters<Wallet["sign"]>[0]).tx_blob;
  ok(acceptSignedBlob(sig(want), want).ok, "the requested payment is accepted");
  ok(!acceptSignedBlob(sig({ ...want, Amount: "2000000" }), want).ok, "a different amount is refused");
  ok(!acceptSignedBlob(sig({ ...want, Destination: sink.classicAddress }), want).ok, "a different payee is refused");
  ok(!acceptSignedBlob(sig({ ...want, LastLedgerSequence: lg.index + 5 }), want).ok, "a changed expiry (LastLedgerSequence) is refused");
  ok(!acceptSignedBlob(sig({ ...want, Flags: 0x00020000 }), want).ok, "a partial-payment flag is refused");
  ok(!acceptSignedBlob(sig({ ...want, Fee: "5000" }), want).ok, "a raised fee above the cap is refused");
  const { decode, encode } = await import("xrpl");
  const good = decode(sig(want)) as Record<string, unknown>;
  const otherSig = (decode(sig({ ...want, Amount: "3" })) as Record<string, unknown>).TxnSignature;
  ok(!acceptSignedBlob(encode({ ...good, TxnSignature: otherSig } as Parameters<typeof encode>[0]), want).ok, "a payment whose signature doesn't match is refused");

  // ── C. RLUSD (stand-in issuer), monthly × 2, cancel via Batch when Testnet has it ──────────────────────────────
  console.log("\nC. RLUSD autopay (stand-in issuer), monthly × 2");
  ok((await send(issuer, { TransactionType: "AccountSet", SetFlag: 8 })).code === "tesSUCCESS", "stand-in issuer enables rippling");
  for (const w of [payer2, payee2]) ok((await send(w, { TransactionType: "TrustSet", LimitAmount: { currency: RLUSD.hex, issuer: issuer.classicAddress, value: "1000" } })).code === "tesSUCCESS", `${w === payer2 ? "payer" : "payee"} adds the RLUSD line`);
  ok((await send(issuer, { TransactionType: "Payment", Destination: payer2.classicAddress, Amount: { currency: RLUSD.hex, issuer: issuer.classicAddress, value: "50" } })).code === "tesSUCCESS", "payer receives 50 RLUSD");
  const noLinePre = await autopayPreflight(rpc, { funder: payer2.classicAddress, payee: noLine.classicAddress, destinationTag: null, currency: "RLUSD", amount: "10", periods: 2 }, RLUSD);
  ok(!noLinePre.ok, `preflight refuses a payee with no RLUSD line: "${noLinePre.ok ? "" : noLinePre.error}"`);
  const pre2 = await autopayPreflight(rpc, { funder: payer2.classicAddress, payee: payee2.classicAddress, destinationTag: null, currency: "RLUSD", amount: "10", periods: 2 }, RLUSD);
  ok(pre2.ok, "preflight passes for a payee with the RLUSD line");
  const tc2 = await send(payer2, buildTicketCreate(payer2.classicAddress, 2));
  const tk2 = await ticketsFromTx(rpc, tc2.hash, payer2.classicAddress);
  ok(tk2.ok && tk2.tickets.length === 2, "2 tickets created");
  const [s1, s2] = await presign("rl", payer2, payee2.classicAddress, "RLUSD", "10", "monthly", tk2.ok ? tk2.tickets : []);
  ok(await run(s1, new Date(s1.periodStart.getTime() - 60_000)) === "waiting", "a minute before month 1: nothing sent");
  ok(await run(s1, new Date(s1.periodStart.getTime() + 60_000)) === "paid", "month 1 starts: RLUSD payment sent and validated");
  ok(Math.abs((await rlusd(payee2.classicAddress)) - 10) < 1e-9, "payee holds exactly 10 RLUSD");

  const seq = Number(((await rpc("account_info", { account: payer2.classicAddress, ledger_index: "validated" }))?.account_data as { Sequence?: number }).Sequence);
  let batchCode = "";
  try { batchCode = (await send(payer2, buildTicketBurnBatch(payer2.classicAddress, seq, [s2.ticket]))).code; } catch (e) { batchCode = `error: ${e instanceof Error ? e.message : e}`; }
  if (batchCode === "tesSUCCESS") {
    ok(!(await ticketsOnLedger(rpc, payer2.classicAddress))!.includes(s2.ticket), "cancel in ONE Batch signature: ticket used up");
  } else {
    console.log(`  (Batch not usable on Testnet right now: ${batchCode}; cancelling with a single ticket-burn instead)`);
    ok((await send(payer2, buildTicketBurn(payer2.classicAddress, s2.ticket))).code === "tesSUCCESS", "cancel with a single ticket-burn");
  }
  ok(await run(s2, new Date(s2.periodStart.getTime() + 60_000)) === "cancelled", "month 2 is cancelled; nothing sent");
  ok(Math.abs((await rlusd(payee2.classicAddress)) - 10) < 1e-9, "payee still holds exactly 10 RLUSD");

  await client.disconnect();
  console.log(`\nAll ${passed} checks passed on XRPL Testnet.`);
  console.log(`Accounts: payer ${payer.classicAddress} · payee ${payee.classicAddress} · RLUSD payer ${payer2.classicAddress} · RLUSD payee ${payee2.classicAddress}`);
}

main().catch(async (e) => { console.error(e); await client.disconnect().catch(() => {}); process.exit(1); });
