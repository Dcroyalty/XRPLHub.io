// MANUAL check against production (not part of `npm run verify`, which must stay offline).
//   npm run build && node scripts/live-check.mjs [wallet]
// Exercises every action through the real plugin object and the real https://www.xrplhub.io/api/mcp, then previews AND
// tries to "buy" EVERY service, asserting that no output anywhere contains a signable transaction. Nothing is paid,
// signed or submitted: the plugin has no way to do any of those.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: plugin } = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);

const WALLET = process.argv[2] || "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const OTHERS = ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb"];
const act = (n) => plugin.actions.find((a) => a.name === n);
const call = async (name, text, parameters) => (await act(name).handler({}, { content: { text } }, undefined, parameters ? { parameters } : undefined, undefined)) ?? {};
const line = (s) => console.log(s);
const leaks = [];
const audit = (label, r) => {
  const blob = `${r.text ?? ""}${JSON.stringify(r.data ?? {})}${JSON.stringify(r.values ?? {})}`;
  if (/"TransactionType"|TransactionType:/.test(blob)) leaks.push(label);
};

line(`wallet: ${WALLET}\n`);
const score = await call("XRPLHUB_SCORE_WALLET", `score ${WALLET}`);
line(`SCORE    success=${score.success}  ${String(score.text ?? score.error).split("\n")[0]}`);
const screen = await call("XRPLHUB_SCREEN_ADDRESS", `ofac screen ${WALLET}`);
line(`SCREEN   success=${screen.success}`);
const mpt = await call("XRPLHUB_MPT_RISK", "mpt 0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045");
line(`MPT      success=${mpt.success}`);
const list = await call("XRPLHUB_LIST_SERVICES", "what can xrplhub build?");
line(`LIST     success=${list.success}  count=${list.data?.count}  sample: ${String(list.text).split("\n")[1]}\n`);
audit("list", list);

const out = { previewOk: 0, previewFail: [], resource: 0, confirm: 0, other: [], prices: new Set() };
for (const svc of list.data?.services ?? []) {
  const params = {};
  for (const p of svc.params) {
    const ex = p.example ?? "";
    if (/^r[A-Za-z]{3,}\.\.\./.test(ex) && ex.includes(",")) params[p.name] = OTHERS.join(",");
    else if (/^r[A-Za-z]{3,}\.\.\./.test(ex)) params[p.name] = OTHERS[0];
    else if (ex === "true" || ex === "false") params[p.name] = ex === "true";
    else if (ex !== "" && !Number.isNaN(Number(ex))) params[p.name] = Number(ex);
    else params[p.name] = ex;
  }
  const pv = await call("XRPLHUB_PREVIEW_TRANSACTION", `preview ${svc.id}`, { product_id: svc.id, params });
  audit(`preview:${svc.id}`, pv);
  if (pv.success) {
    out.previewOk++;
    if (pv.data.priceUsd != null && pv.data.priceUsd !== svc.priceUsd) out.previewFail.push(`${svc.id}: preview price ${pv.data.priceUsd} != list price ${svc.priceUsd}`);
  } else out.previewFail.push(`${svc.id}: ${String(pv.text).slice(0, 90)}`);

  const b = await call("XRPLHUB_BUILD_TRANSACTION", `buy ${svc.id} for ${WALLET}`, { product_id: svc.id, wallet_address: WALLET, params });
  audit(`build:${svc.id}`, b);
  if (b.success && b.data?.resource) {
    out.resource++;
    out.prices.add(`${svc.id}=$${b.data.priceUsd}`);
    if (b.data.priceUsd !== svc.priceUsd) out.other.push(`${svc.id}: resource price ${b.data.priceUsd} != list price ${svc.priceUsd}`);
  } else if (b.error === "confirmation_required") out.confirm++;
  else out.other.push(`${svc.id} [${svc.tier}]: ${b.error}: ${String(b.text).slice(0, 100)}`);
}
line(`PREVIEW  ok=${out.previewOk}/${list.data?.count}${out.previewFail.length ? "  problems:\n  " + out.previewFail.join("\n  ") : ""}`);
line(`BUILD    payment-resources=${out.resource}  withheld-for-confirmation=${out.confirm}  other=${out.other.length}${out.other.length ? "\n  " + out.other.join("\n  ") : ""}`);
line(`\nSIGNABLE TRANSACTION LEAKS: ${leaks.length}${leaks.length ? "  <-- " + leaks.join(", ") : "  (none in any output)"}`);
process.exit(leaks.length ? 1 : 0);
