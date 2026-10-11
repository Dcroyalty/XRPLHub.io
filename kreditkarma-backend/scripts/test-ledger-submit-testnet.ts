// scripts/test-ledger-submit-testnet.ts — the halt-safe submit (src/lib/ledgerSubmit.ts) used by every server-side
// ledger write (MPT / screening / lending / underwrite / monitoring anchors, credential issue / delete / cleanup).
// Real Testnet; a halt is simulated by making the node report a stale validated ledger.
//
//   node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/test-ledger-submit-testnet.ts

import { Client, Wallet } from "xrpl";
import { LedgerExpiredError, LedgerPausedError, LedgerPendingError, isLedgerRetry, submitValidated } from "@/lib/ledgerSubmit";

let n = 0;
function ok(c: unknown, what: string) { if (!c) { console.error(`✗ ${what}`); process.exit(1); } n++; console.log(`✓ ${what}`); }
const memo = (t: string) => [{ Memo: { MemoType: Buffer.from("xrplhub/halt-test").toString("hex").toUpperCase(), MemoData: Buffer.from(t).toString("hex").toUpperCase() } }];

async function main() {
  const client = new Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();
  const w = (await client.fundWallet()).wallet;
  const accountSet = (t: string) => ({ TransactionType: "AccountSet", Account: w.classicAddress, Memos: memo(t) });

  // 1. Normal: validated before "done".
  const r1 = await submitValidated(client, w, accountSet("normal"));
  ok(r1.result.validated && r1.result.meta.TransactionResult === "tesSUCCESS", `normal anchor-style write: validated ${r1.result.meta.TransactionResult} in ledger ${r1.result.ledger_index}`);

  // 2. HALT: the node's last validated ledger is 15 minutes old → paused, nothing submitted.
  const realRequest = client.request.bind(client);
  let submits = 0;
  (client as unknown as { request: unknown }).request = async (req: { command: string }) => {
    if (req.command === "submit") submits++;
    const res = await realRequest(req as Parameters<Client["request"]>[0]);
    if (req.command === "server_info") (res.result as { info: { validated_ledger: { age: number } } }).info.validated_ledger.age = 900;
    return res;
  };
  let e2: unknown = null;
  try { await submitValidated(client, w, accountSet("during halt")); } catch (e) { e2 = e; }
  ok(e2 instanceof LedgerPausedError && submits === 0 && isLedgerRetry(e2), `ledger halted → LedgerPausedError, ${submits} submissions, counts as "retry next run" (${(e2 as Error).message})`);
  (client as unknown as { request: unknown }).request = realRequest;

  // 3. Stuck in a halt, lands later: never marked done early, and never twice.
  //    Simulate: the tx is accepted but this run can't see it validated (tx lookups hidden) → LedgerPendingError.
  (client as unknown as { request: unknown }).request = async (req: { command: string }) => (req.command === "tx" ? { result: { validated: false } } : realRequest(req as Parameters<Client["request"]>[0]));
  let e3: unknown = null;
  try { await submitValidated(client, w, accountSet("stranded"), { waitMs: 4_000 }); } catch (e) { e3 = e; }
  (client as unknown as { request: unknown }).request = realRequest;
  ok(e3 instanceof LedgerPendingError && isLedgerRetry(e3), `submitted but not seen validated in time → LedgerPendingError (NOT marked done): ${(e3 as Error).message}`);
  const strandedHash = (e3 as LedgerPendingError).hash;

  // Let step 3's transaction settle first (it validates a few seconds after it was submitted).
  for (let i = 0; i < 15; i++) { const t = await client.request({ command: "tx", transaction: strandedHash }).catch(() => null); if ((t?.result as { validated?: boolean } | undefined)?.validated) break; await new Promise((s) => setTimeout(s, 1500)); }
  // 4. The validated-Sequence rule: a transaction stranded by a halt and the retry share one Sequence → at most one applies.
  const ai = await client.request({ command: "account_info", account: w.classicAddress, ledger_index: "validated" });
  const S = (ai.result.account_data as { Sequence: number }).Sequence;
  const strandedA = w.sign((await client.autofill({ ...accountSet("A: signed before a halt, never seen") , Sequence: S } as Parameters<Client["autofill"]>[0])) as Parameters<Wallet["sign"]>[0]);
  const rB = await submitValidated(client, w, accountSet("B: the retry"));
  ok(Number(rB.prepared.Sequence) === S, `the retry used the VALIDATED Sequence ${S} — the same one as the stranded transaction`);
  const lateA = await client.request({ command: "submit", tx_blob: strandedA.tx_blob });
  ok(lateA.result.engine_result === "tefPAST_SEQ", `the stranded transaction arriving after the resume can't also apply (${lateA.result.engine_result}) — no double submission`);

  // 5. The earlier "pending" one really landed — the next run would read it from the ledger, not resubmit blindly.
  const t = await client.request({ command: "tx", transaction: strandedHash });
  ok((t.result as { validated?: boolean }).validated, "the transaction reported as pending in step 3 did land; it is visible on the validated ledger for the next run");
  ok(isLedgerRetry(new LedgerExpiredError("x", "h")) && !isLedgerRetry(new Error("tecNO_PERMISSION")), "expired/halt/pending/connection errors are retries; a real ledger rejection is not");

  await client.disconnect();
  console.log(`\nAll ${n} checks passed on XRPL Testnet.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
