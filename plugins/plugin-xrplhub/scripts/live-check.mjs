// MANUAL check against production (not part of `npm run verify`, which must stay offline).
//   npm run build && node scripts/live-check.mjs [wallet]
// Exercises every action through the real plugin object and the real https://www.xrplhub.io/api/mcp, then tries to
// build EVERY service with its documented example params, so an account-guard false positive would show up here.
// Nothing is signed or submitted: the plugin has no way to.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: plugin } = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);

const WALLET = process.argv[2] || "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const OTHERS = ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb"];
const act = (n) => plugin.actions.find((a) => a.name === n);
const call = async (name, text, parameters) => (await act(name).handler({}, { content: { text } }, undefined, parameters ? { parameters } : undefined, undefined)) ?? {};
const line = (s) => console.log(s);

line(`wallet: ${WALLET}\n`);
const score = await call("XRPLHUB_SCORE_WALLET", `score ${WALLET}`);
line(`SCORE   success=${score.success}  ${String(score.text ?? score.error).split("\n")[0]}`);
const screen = await call("XRPLHUB_SCREEN_ADDRESS", `ofac screen ${WALLET}`);
line(`SCREEN  success=${screen.success}  ${String(screen.text ?? screen.error).split("\n").slice(0, 2).join(" | ").slice(0, 200)}`);
const mpt = await call("XRPLHUB_MPT_RISK", "mpt 0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045");
line(`MPT     success=${mpt.success}  ${String(mpt.text ?? mpt.error).split("\n")[0]}`);
const list = await call("XRPLHUB_LIST_SERVICES", "what can xrplhub build?");
line(`LIST    success=${list.success}  count=${list.data?.count}\n`);

const results = { ok: 0, refused: [], failed: [] };
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
  const r = await call("XRPLHUB_BUILD_TRANSACTION", `build ${svc.id} for ${WALLET}`, { product_id: svc.id, wallet_address: WALLET, params });
  if (r.success) results.ok++;
  else if (r.error === "account_mismatch" || r.error === "bad_response") results.refused.push(`${svc.id}: ${r.error}`);
  else results.failed.push(`${svc.id} [${svc.tier}]: ${String(r.text).slice(0, 110)}`);
}
line(`BUILD   built=${results.ok}  guard-refused=${results.refused.length}  other-failures=${results.failed.length}  (of ${list.data?.count})`);
if (results.refused.length) line("GUARD REFUSALS (investigate):\n  " + results.refused.join("\n  "));
if (results.failed.length) line("Other failures (bad example params / blocked / paid-only?):\n  " + results.failed.join("\n  "));
