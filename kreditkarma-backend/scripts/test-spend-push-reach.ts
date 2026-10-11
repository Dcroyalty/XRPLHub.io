// scripts/test-spend-push-reach.ts — can a Spend Controls payer still be reached, and does ending a plan stop everything?
// No database and no real Xaman: a fake Prisma and a fake Xaman API (global fetch) stand in for both.
//   1. promptSubscriptions reports every sign request Xaman did NOT deliver (expired push token), naming Autopay failures.
//   2. watchdog spend-push-tokens asks Xaman which payers' tokens are dead (POST /platform/user-tokens).
//   3. endPlan: status ended, push token dropped, unsent Autopay payments cancelled.
//
//   node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/test-spend-push-reach.ts

process.env.XUMM_API_KEY = "test-key";
process.env.XUMM_API_SECRET = "test-secret";
import type { PrismaClient } from "@prisma/client";
import { promptSubscriptions, periodWindow } from "@/lib/spendControls";
import { checkSpendPushTokens } from "@/lib/watchdog";
import { endPlan } from "@/lib/spendAutopay";

let n = 0;
function ok(c: unknown, what: string) { if (!c) { console.error(`✗ ${what}`); process.exit(1); } n++; console.log(`✓ ${what}`); }

const FUNDER = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const PAYEE = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f";
type Row = Record<string, unknown> & { id: string; status: string };
function fakePrisma(plans: Record<string, unknown>[]) {
  const checks: Row[] = [];
  const writes: { model: string; op: string; args: unknown }[] = [];
  const db = {
    spendPlan: {
      findMany: async () => plans,
      update: async (a: unknown) => { writes.push({ model: "plan", op: "update", args: a }); return {}; },
    },
    spendCheck: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        if (!checks.some((c) => c.invoiceId === create.invoiceId)) checks.push({ id: `c${checks.length}`, status: "unsigned", promptedAt: null, ...create });
        return {};
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        if ("OR" in where) return []; // syncPlanChecks: nothing on the ledger to sync
        const plan = plans.find((p) => p.id === where.planId) as { payees: Record<string, unknown>[] };
        return checks.filter((c) => c.planId === where.planId).map((c) => ({ ...c, payee: plan.payees.find((p) => p.id === c.payeeId) }));
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { Object.assign(checks.find((c) => c.id === where.id)!, data); return {}; },
    },
    spendAutopayPayment: {
      updateMany: async (a: { where: { status: { in: string[] } } }) => { writes.push({ model: "autopay", op: "updateMany", args: a }); return { count: 2 }; },
    },
  };
  return { db: db as unknown as PrismaClient, writes };
}
const plan = (id: string, name: string, token: string, autopayStatus = "off") => ({
  id, name, kind: "subscription", status: "active", period: "weekly", currency: "XRP", checkSize: "1", funder: FUNDER,
  xamanUserToken: token, autopayStatus, autopayTicketUuid: null, autopayPeriods: null,
  payees: [{ id: `${id}-p`, position: 0, label: "Issuer", address: PAYEE, budget: "1", destinationTag: null, category: "other" }],
});

async function main() {
  // ── 1. undelivered pushes are reported ──────────────────────────────────────────────────────────────────────────
  const plans = [plan("planok00000000000000a", "Gym", "tok-live"), plan("planfail000000000000b", "Rent", "tok-dead", "on"), plan("planrefused000000000c", "Phone", "tok-x")];
  const { db } = fakePrisma(plans);
  const delivery: Record<string, { uuid: string; pushed: boolean } | null> = {
    "tok-live": { uuid: "u1", pushed: true }, "tok-dead": { uuid: "u2", pushed: false }, "tok-x": null,
  };
  const r = await promptSubscriptions(db, async (_tx, _label, _id, token) => delivery[token], {
    autopay: async (planId) => ({ covered: false, failedReason: planId.startsWith("planfail") ? "Not enough XRP in the wallet." : null }),
  });
  ok(r.pushed === 1 && r.failed === 2, `3 payers: 1 delivered, 2 not (pushed ${r.pushed}, not delivered ${r.failed})`);
  ok(r.unreached.length === 2, `both undelivered requests are reported (${r.unreached.length} lines for the owner's RED alert)`);
  ok(r.unreached.some((l) => l.includes("planfail") && l.includes("AUTOPAY FAILED notice") && l.includes("token expired")), `an undelivered Autopay-failure notice is named as such:\n    ${r.unreached.find((l) => l.includes("planfail"))}`);
  ok(r.unreached.some((l) => l.includes("planrefused") && l.includes("Xaman refused")), "a request Xaman refused outright is reported too");
  ok(!r.unreached.some((l) => l.includes("planok")), "a delivered push is not reported");

  // ── 2. watchdog: which payers can Xaman still reach? ────────────────────────────────────────────────────────────
  const realFetch = globalThis.fetch;
  let asked: string[] = [];
  const xamanSays = (active: Record<string, boolean>) => {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== "https://xumm.app/api/v1/platform/user-tokens") return realFetch(url, init);
      asked = (JSON.parse(String(init?.body)) as { tokens: string[] }).tokens;
      return new Response(JSON.stringify({ tokens: asked.map((t) => ({ user_token: t, active: active[t] ?? false, issued: 1, expires: Math.floor(Date.now() / 1000) + (active[t] ? 20 * 86400 : -86400) })) }), { status: 200 });
    }) as typeof fetch;
  };
  xamanSays({ "tok-live": true, "tok-dead": false, "tok-x": true });
  const w1 = await checkSpendPushTokens(fakePrisma(plans).db);
  ok(w1.level === "warn" && w1.message.startsWith("1 of 3") && w1.message.includes("1 on Autopay") && asked.length === 3, `one dead token → WARN: ${w1.message}`);
  xamanSays({ "tok-live": true, "tok-dead": true, "tok-x": true });
  const w2 = await checkSpendPushTokens(fakePrisma(plans).db);
  ok(w2.level === "ok", `all tokens live → ok: ${w2.message}`);
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
  const w3 = await checkSpendPushTokens(fakePrisma(plans).db);
  ok(w3.level === "warn" && w3.message.includes("could not ask Xaman"), `Xaman down → WARN, never a false "ok": ${w3.message}`);
  globalThis.fetch = realFetch;

  // ── 3. ending a plan ────────────────────────────────────────────────────────────────────────────────────────────
  const live = plan("planend0000000000000d", "Test", "tok-live", "on");
  const e = fakePrisma([live]);
  const res = await endPlan(e.db, live as Parameters<typeof endPlan>[1]);
  const cancel = e.writes.find((w) => w.model === "autopay")?.args as { where: { planId: string; status: { in: string[] } }; data: { status: string } } | undefined;
  const upd = e.writes.find((w) => w.model === "plan")?.args as { data: Record<string, unknown> } | undefined;
  ok(res.ok && cancel?.where.status.in.join() === "unsigned,scheduled" && cancel.data.status === "cancelled", "ending cancels every Autopay payment not yet sent (unsigned + scheduled); a pending one is left to settle");
  ok(upd?.data.status === "ended" && upd.data.xamanUserToken === null && upd.data.autopayStatus === "ended", "the plan is marked ended, its push token dropped, Autopay ended");
  const again = await endPlan(fakePrisma([]).db, { ...live, status: "ended" } as Parameters<typeof endPlan>[1]);
  ok(again.already, "ending an already-ended plan changes nothing");
  void periodWindow;

  console.log(`\nAll ${n} checks passed.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
