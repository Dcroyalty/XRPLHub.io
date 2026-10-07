// MANUAL check against production (not part of `npm run verify`, which must stay offline).
//   npm run build && node scripts/live-check.mjs [wallet]
// Exercises the three read-only actions through the real plugin object and the real https://www.xrplhub.io/api/mcp, and
// asserts that no output contains a signable transaction. Nothing is paid, signed or submitted: the plugin cannot.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: plugin } = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);

const WALLET = process.argv[2] || "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
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
audit("score", score);
line(`SCORE    success=${score.success}  ${String(score.text ?? score.error).split("\n")[0]}`);
const screen = await call("XRPLHUB_SCREEN_ADDRESS", `ofac screen ${WALLET}`);
audit("screen", screen);
line(`SCREEN   success=${screen.success}`);
const mpt = await call("XRPLHUB_MPT_RISK", "mpt 0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045");
audit("mpt", mpt);
line(`MPT      success=${mpt.success}`);
line(`\nSIGNABLE TRANSACTION LEAKS: ${leaks.length}${leaks.length ? "  <-- " + leaks.join(", ") : "  (none in any output)"}`);
process.exit(leaks.length || !score.success || !screen.success || !mpt.success ? 1 : 0);
