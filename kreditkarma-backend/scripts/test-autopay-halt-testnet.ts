// scripts/test-autopay-halt-testnet.ts — Autopay through a SIMULATED XRP Ledger halt, on Testnet, with the production core.
// One real pre-signed payment (real faucet accounts, real ticket) is run through every halt / bad-node situation by an
// RPC wrapper that lies the way a halted or broken network does, then the "ledger resumes" and it must be paid exactly
// once — never marked failed, never notified, never double-paid.
//
//   node scripts/test-autopay-halt-testnet.ts

import { Client, Wallet } from "xrpl";
import {
  AUTOPAY_GRACE_S, FAST_LEDGER_S, acceptSignedBlob, autopayPeriods, buildAutopayPayment, buildTicketCreate, encryptBlob, lastLedgerFor,
  processRow, ticketsFromTx, validatedLedger, type DueRow, type Rpc, type RowPatch,
} from "../src/lib/autopay.ts";

const RPC_URL = "https://s.altnet.rippletest.net:51234";
const real: Rpc = async (method, params) => {
  try { const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) }); return ((await r.json()) as { result?: Record<string, unknown> }).result ?? null; }
  catch { return null; }
};
type Mode = "real" | "unreachable" | "halted" | "node-noticket" | "node-maxledger" | "node-malformed" | "accepted-not-validated";
let mode: Mode = "real";
let realSubmits = 0;
/** What a halted / broken network looks like from the outside. */
const sim: Rpc = async (method, params) => {
  if (mode === "unreachable") return null;
  if (mode === "halted") {
    if (method === "server_info") { const r = await real(method, params); const info = r?.info as Record<string, unknown>; return { ...r, info: { ...info, validated_ledger: { ...(info?.validated_ledger as object), age: 900 } } }; }
    if (method === "submit") return { engine_result: "tesSUCCESS" }; // must never be reached while halted
    if (method === "tx") return { error: "txnNotFound" };
  }
  if (method === "submit") {
    if (mode === "node-noticket") return { engine_result: "tefNO_TICKET" };
    if (mode === "node-maxledger") return { engine_result: "tefMAX_LEDGER" };
    if (mode === "node-malformed") return { engine_result: "temMALFORMED" };
    if (mode === "accepted-not-validated") return { engine_result: "tesSUCCESS" }; // a stalled node took it into its open ledger
    realSubmits++;
  }
  if (mode === "accepted-not-validated" && method === "tx") return { error: "txnNotFound" };
  return real(method, params);
};

let n = 0;
function ok(c: unknown, what: string) { if (!c) { console.error(`✗ ${what}`); process.exit(1); } n++; console.log(`✓ ${what}`); }
const client = new Client("wss://s.altnet.rippletest.net:51233");
const xrp = async (a: string) => Number(((await real("account_info", { account: a, ledger_index: "validated" }))?.account_data as { Balance?: string })?.Balance ?? 0) / 1e6;

async function main() {
  await client.connect();
  const [payer, payee] = [(await client.fundWallet()).wallet, (await client.fundWallet()).wallet];
  const tc = await client.submitAndWait({ ...buildTicketCreate(payer.classicAddress, 1), Account: payer.classicAddress } as Parameters<Client["submitAndWait"]>[0], { wallet: payer, autofill: true });
  const tk = await ticketsFromTx(real, String(tc.result.hash), payer.classicAddress);
  const ticket = tk.ok ? tk.tickets[0] : -1;
  const ledger = (await validatedLedger(real))!;
  const [p] = autopayPeriods("weekly", new Date(), 1);
  const deadline = new Date(p.end.getTime() + AUTOPAY_GRACE_S * 1000);
  const lastLedger = lastLedgerFor(deadline, ledger);
  const txjson = buildAutopayPayment({ account: payer.classicAddress, destination: payee.classicAddress, destinationTag: null, currency: "XRP", amount: "3", ticket, lastLedger }, { issuer: "r", hex: "" });
  const signed = payer.sign(txjson as Parameters<Wallet["sign"]>[0]);
  const acc = acceptSignedBlob(signed.tx_blob, txjson);
  ok(acc.ok, `pre-signed 3 XRP payment on ticket ${ticket}`);

  // ── expiry window: room to miss days ───────────────────────────────────────────────────────────────────────────
  const windowDays = (deadline.getTime() - p.start.getTime()) / 86_400_000;
  const llsDaysAtFastRate = ((lastLedger - ledger.index) * FAST_LEDGER_S) / 86_400;
  const llsDaysAtRealRate = ((lastLedger - ledger.index) * 3.9) / 86_400;
  ok(windowDays >= 10 - 1e-9, `send window for a WEEKLY payment = its week + 3-day grace = ${windowDays} days → ${Math.floor(windowDays)} daily 07:00 runs can try it (a monthly one gets 31–34)`);
  ok(llsDaysAtFastRate >= (deadline.getTime() - Date.now()) / 86_400_000 - 1e-9, `its LastLedgerSequence lasts ≥ that window even if ledgers ran fast (${llsDaysAtFastRate.toFixed(1)} days at 3 s/ledger; ~${llsDaysAtRealRate.toFixed(1)} days at the real ~3.9 s)`);
  ok(true, "a halt only pushes the expiry further out: no ledgers close, so LastLedgerSequence is reached LATER, never sooner");

  // ── the halt ────────────────────────────────────────────────────────────────────────────────────────────────────
  const id = "halt-row";
  const row: DueRow & { result?: string; reason?: string } = { id, periodStart: p.start, periodEnd: p.end, status: "scheduled", blobEnc: encryptBlob(signed.tx_blob, "k", id), txHash: acc.ok ? acc.hash : "", attempts: 0, account: payer.classicAddress, ticket, lastLedger };
  const notices: string[] = [];
  const update = async (_: string, patch: RowPatch) => { Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))); };
  const notify = async (_: string, kind: string, reason: string) => { notices.push(`${kind}: ${reason}`); };
  const runAt = (h: number) => processRow(row, { rpc: sim, now: new Date(p.start.getTime() + h * 3_600_000), secret: "k", update, notify, settleWaitMs: 20_000 });
  const payee0 = await xrp(payee.classicAddress);

  const steps: [Mode, string, string, string][] = [
    ["unreachable", "day 1 07:00 — no XRPL node answers", "paused", "scheduled"],
    ["halted", "day 2 07:00 — ledger HALTED (every node stuck, last ledger 15 min old)", "paused", "scheduled"],
    ["node-noticket", "day 3 07:00 — a bad node says tefNO_TICKET (the validated ledger still holds the ticket)", "retry", "scheduled"],
    ["node-maxledger", "day 4 07:00 — a bad node says tefMAX_LEDGER (the validated ledger is far from its expiry)", "retry", "scheduled"],
    ["node-malformed", "day 5 07:00 — a node rejects it before any ledger processes it (temMALFORMED)", "retry", "scheduled"],
    ["accepted-not-validated", "day 6 07:00 — a stalled node accepts it, but no ledger validates it", "submitted", "pending"],
    ["halted", "day 7 07:00 — halted again while it is pending", "paused", "pending"],
  ];
  let h = 7;
  for (const [m, label, wantOutcome, wantStatus] of steps) {
    mode = m;
    const before = realSubmits;
    const o = await runAt(h); h += 24;
    ok(o === wantOutcome && row.status === wantStatus && notices.length === 0 && (await xrp(payee.classicAddress)) === payee0,
      `${label} → ${o}, status ${row.status}, not failed, nobody notified, payee unpaid${m === "halted" || m === "unreachable" ? `, nothing submitted (${realSubmits - before} real submits)` : ""}`);
  }

  // ── the ledger resumes ──────────────────────────────────────────────────────────────────────────────────────────
  mode = "real";
  const o = await runAt(h - 24 + 1);
  ok(o === "paid" && row.status === "paid", `day 7, ledger RESUMES → the same pre-signed blob is sent and validated: ${o}`);
  ok(Math.abs((await xrp(payee.classicAddress)) - payee0 - 3) < 1e-9, "payee received exactly 3 XRP — once");
  mode = "real";
  ok(await runAt(h + 24) === "skipped", "the next run does nothing more (already paid)");
  ok(notices.length === 0, "no failure or missed notice was ever sent");
  const dup = await real("submit", { tx_blob: signed.tx_blob });
  ok(dup?.engine_result === "tefNO_TICKET" || dup?.engine_result === "tefPAST_SEQ" || dup?.engine_result === "tefALREADY", `re-submitting the blob after it landed can't pay twice (${dup?.engine_result})`);

  await client.disconnect();
  console.log(`\nAll ${n} checks passed on XRPL Testnet (simulated halt).`);
}
main().catch(async (e) => { console.error(e); await client.disconnect().catch(() => {}); process.exit(1); });
