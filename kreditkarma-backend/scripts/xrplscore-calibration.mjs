// scripts/xrplscore-calibration.mjs
// Reproduce the XRPLScore v1.1 calibration distribution from a sample of real
// mainnet accounts, using the LIVE engine (src/lib/xrplscore.ts) — no separate
// prototype, no drift.
//
// The original Sep-2026 calibration ran over a 333-account sample assembled as:
//   - recent transactors (sampled from account_tx of active issuers)
//   - active DEX traders (accounts with live Offers)
//   - long-lived accounts (2 yr+)
//   - named exchange / issuer wallets (see docs/calibration-anchors.json)
// The per-account raw JSONL was a working artifact and was not archived. This
// script regenerates a comparable sample and recomputes every number the
// calibration doc publishes, so the methodology is reproducible even though the
// exact original rows are not.
//
// USAGE:
//   node scripts/xrplscore-calibration.mjs                 # score the committed anchor set
//   node scripts/xrplscore-calibration.mjs addrs.txt       # score a newline-delimited address file
//   node scripts/xrplscore-calibration.mjs --out sample.jsonl addrs.txt
//
// Rate limits: the public XRPL nodes throttle aggressively. This paces requests
// and retries slowDown/timeout. A 300+ account run takes a while — that is
// expected.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { scoreWallet, AccountNotFoundError, XrplUnavailableError } = await import(
  pathToFileURL(resolve(__dirname, "../src/lib/xrplscore.ts")).href
);

const args = process.argv.slice(2);
let outFile = null;
const outIdx = args.indexOf("--out");
if (outIdx !== -1) { outFile = args[outIdx + 1]; args.splice(outIdx, 2); }
const addrFile = args[0];

let addresses;
if (addrFile) {
  addresses = readFileSync(addrFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s));
} else {
  const anchorsPath = resolve(__dirname, "../docs/calibration-anchors.json");
  if (!existsSync(anchorsPath)) {
    console.error("No address file given and docs/calibration-anchors.json is missing.");
    process.exit(1);
  }
  const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));
  addresses = anchors.map((a) => a.address);
}

console.error(`Scoring ${addresses.length} account(s) with the live v1.1 engine…\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let notFound = 0, unavailable = 0;

for (let i = 0; i < addresses.length; i++) {
  const addr = addresses[i];
  let attempt = 0;
  for (;;) {
    try {
      const r = await scoreWallet(addr);
      rows.push({
        address: addr,
        score: r.ledgerScore,
        grade: r.grade,
        signals: r.signals,
        accountAgeDays: r.details.accountAgeDays,
        lifetimeTxEstimate: r.details.lifetimeTxEstimate,
      });
      process.stderr.write(`  ${String(i + 1).padStart(4)}/${addresses.length}  ${addr}  ${r.ledgerScore} ${r.grade}\n`);
      break;
    } catch (e) {
      if (e instanceof AccountNotFoundError) { notFound++; process.stderr.write(`  ${String(i + 1).padStart(4)}/${addresses.length}  ${addr}  (not found)\n`); break; }
      if (e instanceof XrplUnavailableError && attempt < 6) { attempt++; await sleep(4000 * attempt); continue; }
      if (e instanceof XrplUnavailableError) { unavailable++; process.stderr.write(`  ${String(i + 1).padStart(4)}/${addresses.length}  ${addr}  (unavailable after retries — skipped)\n`); break; }
      throw e;
    }
  }
  await sleep(1200);
}

if (outFile) {
  writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`\nWrote ${rows.length} rows to ${outFile}`);
}

// ── Distribution ────────────────────────────────────────────────────────────
const scores = rows.map((r) => r.score).sort((a, b) => a - b);
const q = (p) => scores.length ? scores[Math.min(scores.length - 1, Math.floor(p * scores.length))] : NaN;
const median = scores.length % 2 ? scores[(scores.length - 1) / 2] : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;

console.log("\n=== XRPLScore v1.1 — sample distribution ===");
console.log(`N scored           : ${rows.length}  (not-found ${notFound}, unavailable ${unavailable})`);
console.log(`median             : ${median}`);
console.log(`p90 / p95 / max    : ${q(0.9)} / ${q(0.95)} / ${scores[scores.length - 1] ?? "n/a"}`);
console.log(`min–max used       : ${scores[0] ?? "n/a"}–${scores[scores.length - 1] ?? "n/a"}`);

console.log("\n=== Tier qualification (% of THIS sample) ===");
for (const t of [600, 650, 700, 750]) {
  const pct = scores.length ? Math.round((scores.filter((s) => s >= t).length / scores.length) * 100) : 0;
  console.log(`  min${t} : ${pct}%`);
}

console.log("\n=== Named anchor wallets ===");
for (const r of rows) console.log(`  ${r.address}  ${String(r.score).padStart(4)}  ${r.grade}`);
