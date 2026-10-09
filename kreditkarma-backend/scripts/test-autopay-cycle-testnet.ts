// scripts/test-autopay-cycle-testnet.ts — the FULL Autopay cycle on XRPL TESTNET, in real time, through the production
// glue (spendAutopay.ts, promptSubscriptions, the share-link route, the healthchecks.io ping), with 3-minute periods.
// TESTNET ONLY: short periods exist only here (rows are made with createAutopayRows); production is weekly / monthly.
//
//   DATABASE_URL=<a Neon BRANCH, never production> SPEND_AUTOPAY_KEY=<any 32+ chars> \
//     node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/test-autopay-cycle-testnet.ts
//
// Stand-ins, because faucet accounts have no Xaman: the payer signs with an xrpl.js Wallet (Xaman's signing behaviour
// was proven on mainnet, probe 427afc24); the payer's Xaman push and the healthchecks.io ping are captured instead of
// sent. Everything else is the code production runs.

import { Client, Wallet } from "xrpl";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/xrplscore-db";
import { autopayTxFor, autopaySecret, cancelAutopay, createAutopayRows, releasableTickets, runAutopayDue, storeApproved, autopayCovers } from "@/lib/spendAutopay";
import { promptSubscriptions } from "@/lib/spendControls";
import { pingHealthcheckForRun } from "@/lib/watchdog";
import { buildTicketBurn, buildTicketCreate, ticketsFromTx, ticketsOnLedger, decryptBlob, type Rpc } from "@/lib/autopay";
import { GET as shareLink } from "@/app/api/spend/s/[token]/route";

if (!/neon\.tech/.test(process.env.DATABASE_URL ?? "") || !/ep-floral-star/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be the autopay-testnet-cycle Neon branch, never production.");
  process.exit(2);
}

const RPC_URL = "https://s.altnet.rippletest.net:51234";
const PERIOD_MS = 3 * 60_000;
const rpc: Rpc = async (method, params) => {
  try {
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }) });
    return ((await r.json()) as { result?: Record<string, unknown> }).result ?? null;
  } catch { return null; }
};
const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
const t = () => new Date().toISOString().slice(11, 19) + "Z";
let checks = 0;
function ok(cond: unknown, what: string) { if (!cond) { console.error(`  ✗ ${what}`); throw new Error(what); } checks++; console.log(`  ✓ ${what}`); }
async function waitUntil(d: Date, why: string) { const ms = d.getTime() - Date.now(); if (ms > 0) { console.log(`  … waiting ${Math.round(ms / 1000)} s for ${why}`); await sleep(ms); } }

// Captured outward notices.
const hcPings: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
process.env.HEALTHCHECK_PING_URL = "https://hc-ping.capture.test/xrplhub";
delete process.env.ERROR_WEBHOOK_URL;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://hc-ping.capture.test/")) { hcPings.push({ url, body: String(init?.body ?? "") }); return new Response("OK"); }
  return realFetch(input, init);
}) as typeof fetch;
const pushes: { label: string; txjson: Record<string, unknown> }[] = [];
const push = async (txjson: Record<string, unknown>, label: string) => { pushes.push({ label, txjson }); return { uuid: `captured-${pushes.length}`, pushed: true }; };

async function fund(): Promise<Wallet> {
  const w = Wallet.generate();
  for (let i = 0; i < 5; i++) { const r = await fetch("https://faucet.altnet.rippletest.net/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination: w.classicAddress }) }); if (r.ok) break; await sleep(3000); }
  for (let i = 0; i < 20; i++) { const a = await rpc("account_info", { account: w.classicAddress, ledger_index: "validated" }); if (a && !a.error) return w; await sleep(2000); }
  throw new Error("faucet did not fund " + w.classicAddress);
}
const client = new Client("wss://s.altnet.rippletest.net:51233");
async function send(w: Wallet, tx: Record<string, unknown>) {
  const r = await client.submitAndWait({ ...tx, Account: w.classicAddress } as Parameters<Client["submitAndWait"]>[0], { wallet: w, autofill: true });
  return { hash: String(r.result.hash), code: String((r.result.meta as { TransactionResult?: string }).TransactionResult) };
}
async function acct(a: string) {
  const r = await rpc("account_info", { account: a, ledger_index: "validated" });
  const d = r?.account_data as { Balance?: string; OwnerCount?: number };
  return { xrp: Number(d?.Balance ?? 0) / 1e6, owners: Number(d?.OwnerCount ?? 0) };
}
const loadPlan = (id: string) => prisma.spendPlan.findUniqueOrThrow({ where: { id }, include: { payees: { orderBy: { position: "asc" } } } });
const rowsOf = (planId: string) => prisma.spendAutopayPayment.findMany({ where: { planId }, orderBy: { periodStart: "asc" } });
/** The daily cron's three Autopay-related calls, in the cron's order. */
async function cronTick(label: string) {
  console.log(`\n[${t()}] Scheduler triggered by hand — ${label}`);
  const a = await runAutopayDue(prisma, { rpc, settleWaitMs: 25_000 });
  const before = pushes.length;
  await promptSubscriptions(prisma, push, { autopay: (planId, window) => autopayCovers(prisma, planId, window) });
  await pingHealthcheckForRun(prisma, "cron/index-mpts", { findings: [] } as unknown as Parameters<typeof pingHealthcheckForRun>[2], a.notices);
  return { ...a, newPushes: pushes.slice(before).filter((p) => p.label.includes("TESTNET autopay cycle")) };
}

async function main() {
  ok(!!autopaySecret(), "SPEND_AUTOPAY_KEY is set for this run");
  await client.connect();
  console.log(`[${t()}] Funding faucet accounts (payer, payee, sink)…`);
  const [payer, payee, sink] = [await fund(), await fund(), await fund()];
  console.log(`  payer ${payer.classicAddress} · payee ${payee.classicAddress}`);

  // A subscription plan exactly as /spend creates it (5 XRP to one payee).
  const plan0 = await prisma.spendPlan.create({
    data: {
      funder: payer.classicAddress, name: "TESTNET autopay cycle", period: "weekly", currency: "XRP", checkSize: "5", kind: "subscription",
      status: "active", shareToken: randomBytes(18).toString("base64url"), xamanUserToken: "testnet-capture-only",
      payees: { create: [{ address: payee.classicAddress, label: "Testnet payee", category: "other", budget: "5", position: 0 }] },
    },
  });

  // ── 1. Setup: one TicketCreate, then pre-approve 3 payments ─────────────────────────────────────────────────────
  console.log(`\n[${t()}] STEP 1 — set up Autopay: 3 tickets, 3 pre-approved payments`);
  const a0 = await acct(payer.classicAddress);
  const tc = await send(payer, buildTicketCreate(payer.classicAddress, 3));
  const tk = await ticketsFromTx(rpc, tc.hash, payer.classicAddress);
  ok(tc.code === "tesSUCCESS" && tk.ok && tk.tickets.length === 3, `TicketCreate made 3 tickets: ${tk.ok ? tk.tickets.join(", ") : ""}`);
  const a1 = await acct(payer.classicAddress);
  ok(a1.owners - a0.owners === 3, `payer's wallet now holds 3 × 0.2 = 0.6 XRP for the 3 pre-approved payments (owner count ${a0.owners} → ${a1.owners})`);

  const T = Date.now() + 75_000;
  const periods = [0, 1, 2].map((k) => ({ start: new Date(T + k * PERIOD_MS), end: new Date(T + (k + 1) * PERIOD_MS) }));
  let plan = await loadPlan(plan0.id);
  ok(await createAutopayRows(prisma, plan, tk.ok ? tk.tickets : [], periods, rpc), "3 Autopay rows created (3-minute TEST periods)");
  for (const row of await rowsOf(plan.id)) {
    const signed = payer.sign(autopayTxFor(plan, row) as Parameters<Wallet["sign"]>[0]);
    const r = await storeApproved(prisma, plan, row, signed.tx_blob, autopaySecret()!);
    ok(r.ok, `payment for ${row.periodStart.toISOString().slice(11, 19)}Z pre-approved, checked and stored encrypted (ticket ${row.ticket})`);
  }
  plan = await loadPlan(plan.id);
  ok(plan.autopayStatus === "on", `plan Autopay status is "on"`);
  const [r1, r2, r3] = await rowsOf(plan.id);
  console.log(`  periods: P1 ${r1.periodStart.toISOString().slice(11, 19)}–${r1.periodEnd.toISOString().slice(11, 19)}, P2 → ${r2.periodEnd.toISOString().slice(11, 19)}, P3 → ${r3.periodEnd.toISOString().slice(11, 19)} (UTC)`);

  // ── 2. Never early ──────────────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n[${t()}] STEP 2 — before period 1 starts`);
  const payee0 = (await acct(payee.classicAddress)).xrp;
  const e = await cronTick("before P1");
  ok(e.sent.length === 0 && e.due === 0, "nothing sent before period 1 starts");
  ok((await rpc("tx", { transaction: r1.txHash }))?.error === "txnNotFound", "period 1's payment is not on the ledger");
  // Correct: Autopay starts with the NEXT period, so the current one is still paid by a check and gets pushed. In this
  // test the current week and the 3-minute periods share one check row, so clear that prompt mark, or the 3-day
  // re-prompt throttle would hide the failure push below. (In production the failed period's check was never prompted.)
  console.log(`  (current-week check pushed as usual: ${e.newPushes.length})`);
  await prisma.spendCheck.updateMany({ where: { planId: plan.id }, data: { promptedAt: null } });

  // ── 3. Period 1: exactly one payment ────────────────────────────────────────────────────────────────────────────
  await waitUntil(new Date(r1.periodStart.getTime() + 5_000), "period 1 to start");
  const p1 = await cronTick("during P1");
  let rows = await rowsOf(plan.id);
  ok(p1.sent.length === 1 && p1.sent[0] === r1.id && rows[0].status === "paid", `exactly one payment sent: period 1, validated (${rows[0].result})`);
  ok(rows[1].status === "scheduled" && rows[2].status === "scheduled", "periods 2 and 3 untouched");
  ok(p1.newPushes.length === 0, "no check pushed while Autopay covers the period");
  ok(Math.abs((await acct(payee.classicAddress)).xrp - payee0 - 5) < 1e-9, "payee received exactly 5 XRP");
  const p1b = await cronTick("again during P1");
  ok(p1b.sent.length === 0 && Math.abs((await acct(payee.classicAddress)).xrp - payee0 - 5) < 1e-9, "triggered again: nothing more sent, payee still +5 XRP");
  ok(!(await ticketsOnLedger(rpc, payer.classicAddress))!.includes(r1.ticket), "period 1's ticket is used up (its 0.2 XRP is back)");

  // ── 4. Empty the payer; period 2 fails; everyone told; no retry ─────────────────────────────────────────────────
  console.log(`\n[${t()}] STEP 4 — empty the payer before period 2`);
  const a2 = await acct(payer.classicAddress);
  const spendable = a2.xrp - (1 + 0.2 * a2.owners);
  await send(payer, { TransactionType: "Payment", Destination: sink.classicAddress, Amount: String(Math.floor((spendable - 1) * 1e6)) });
  console.log(`  payer now has ~1 XRP spendable (needs 5)`);
  await waitUntil(new Date(r2.periodStart.getTime() + 5_000), "period 2 to start");
  const p2 = await cronTick("during P2");
  rows = await rowsOf(plan.id);
  ok(rows[1].status === "failed" && rows[1].result === "tecUNFUNDED_PAYMENT", `period 2 failed on the ledger: ${rows[1].result} — "${rows[1].reason}"`);
  ok(p2.notices.length === 1 && rows[1].notifiedAt, "one failure notice recorded");
  // Owner: the healthchecks.io ping (the channel that emails the owner).
  const ping = hcPings[hcPings.length - 1];
  ok(ping?.url.endsWith("/fail") && ping.body.includes("autopay failed") && ping.body.includes(plan.id), `OWNER: healthchecks.io pinged /fail with: "${ping?.body.split("\n").find((l) => l.includes("autopay"))?.slice(0, 160)}…"`);
  // Payer: a normal check pushed to their Xaman app, carrying the reason.
  ok(p2.newPushes.length === 1 && p2.newPushes[0].label.startsWith("Autopay didn't go through") && p2.newPushes[0].txjson.TransactionType === "CheckCreate",
    `PAYER: check pushed to Xaman — "${p2.newPushes[0]?.label.slice(0, 140)}…"`);
  // Payee: their share link.
  const res = await shareLink(new Request(`http://localhost/api/spend/s/${plan.shareToken}`, { headers: { "x-forwarded-for": "10.0.0.1" } }), { params: Promise.resolve({ token: plan.shareToken }) });
  const view = (await res.json()) as { thisPeriod?: { state?: string; autopay?: { reason?: string } } };
  ok(view.thisPeriod?.state === "autopay_failed" && view.thisPeriod.autopay?.reason === rows[1].reason, `PAYEE: share link shows "Autopay payment didn't go through" — "${view.thisPeriod?.autopay?.reason}"`);
  // No retry.
  const att = rows[1].attempts;
  const payeeAfter1 = (await acct(payee.classicAddress)).xrp;
  const p2b = await cronTick("again during P2 (payer still empty)");
  rows = await rowsOf(plan.id);
  ok(p2b.sent.length === 0 && p2b.due === 0 && rows[1].attempts === att && rows[1].status === "failed", "triggered again: the failed payment is NOT retried");
  ok(p2b.notices.length === 0, "and the failure is not reported twice");
  ok(Math.abs((await acct(payee.classicAddress)).xrp - payeeAfter1) < 1e-9, "payee balance unchanged");

  // ── 5. Cancel, then release the last ticket ─────────────────────────────────────────────────────────────────────
  console.log(`\n[${t()}] STEP 5 — cancel Autopay (still in period 2) and release the remaining ticket`);
  const c = await cancelAutopay(prisma, await loadPlan(plan.id));
  rows = await rowsOf(plan.id);
  ok(c.cancelled === 1 && rows[2].status === "cancelled", "Cancel: period 3 marked cancelled at once (server stops)");
  const rel = await releasableTickets(prisma, await loadPlan(plan.id), rpc);
  ok(JSON.stringify(rel) === JSON.stringify([r3.ticket]), `releasable: ticket ${r3.ticket} (period 3)`);
  const b5 = await acct(payer.classicAddress);
  const burn = await send(payer, buildTicketBurn(payer.classicAddress, r3.ticket));
  const a5 = await acct(payer.classicAddress);
  ok(burn.code === "tesSUCCESS" && a5.owners === b5.owners - 1, `release signed: owner count ${b5.owners} → ${a5.owners}, so 0.2 XRP is free again (fee ${(b5.xrp - a5.xrp).toFixed(6)} XRP)`);
  ok((await ticketsOnLedger(rpc, payer.classicAddress))!.length === 0 && a5.owners === a0.owners, "no tickets left: all 0.6 XRP returned (owner count back to where it started)");
  const leaked = await rpc("submit", { tx_blob: decryptBlob(r3.blobEnc!, autopaySecret()!, r3.id) });
  ok(leaked?.engine_result === "tefNO_TICKET", `period 3's pre-approved payment is now impossible, even submitted directly (${leaked?.engine_result})`);

  await waitUntil(new Date(r3.periodStart.getTime() + 5_000), "period 3 to start");
  const p3 = await cronTick("during P3 (after cancel)");
  ok(p3.sent.length === 0 && p3.due === 0, "nothing sent in period 3");
  ok(Math.abs((await acct(payee.classicAddress)).xrp - payee0 - 5) < 1e-9, "payee received exactly one payment in total (5 XRP)");

  console.log(`\n[${t()}] All ${checks} checks passed. Plan ${plan.id} on the test branch; payer ${payer.classicAddress}, payee ${payee.classicAddress}.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await client.disconnect().catch(() => {}); await prisma.$disconnect().catch(() => {}); });
