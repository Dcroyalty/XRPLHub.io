// scripts/check-service-parity.mjs
// Build-time guard: fails `npm run build` when the storefront's surfaces disagree about what it sells.
//
//   1. The service ids on the homepage, in the catalog (minus blocked ones), in the server price
//      table, and in the builders are the SAME set — and every product on the page is placed by
//      TOP_ORDER (an unplaced product silently sorts to the wrong place).
//   2. Every hard-coded "N services/actions" claim in source, READMEs, CLAUDE.md and server.json
//      equals the real count (BUILDABLE_SERVICE_IDS.length). Counts built from SERVICE_COUNT /
//      PRODUCTS.length aren't typed by hand and are skipped.
//   3. No public copy claims an AI/LLM does anything — there is none in the shipped code.
//
// Plain regex over source text (no TS toolchain needed), so it runs in a second.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const problems = [];
const fail = (m) => problems.push(m);

const set = (a) => new Set(a);
const diff = (a, b) => [...a].filter((x) => !b.has(x));
const same = (label, a, b, an, bn) => {
  const d1 = diff(a, b), d2 = diff(b, a);
  if (d1.length) fail(`${label}: in ${an} but not in ${bn}: ${d1.join(", ")}`);
  if (d2.length) fail(`${label}: in ${bn} but not in ${an}: ${d2.join(", ")}`);
};

// ── extract the id sets ──────────────────────────────────────────────────────
const page = read("src/app/page.tsx");
const ps = page.indexOf("const RAW_PRODUCTS = [");
const pe = page.indexOf("] as const;", ps);
if (ps < 0 || pe < 0) fail("page.tsx: could not find the RAW_PRODUCTS block");
const pageIds = [...page.slice(ps, pe).matchAll(/\{ id:'([a-z0-9]+)'/g)].map((m) => m[1]);
if (new Set(pageIds).size !== pageIds.length) fail("page.tsx: duplicate product ids on the page");

// featured products render in their own grid above the ordered one, so they are not in TOP_ORDER
const featuredIds = page.slice(ps, pe).split("\n  { id:'").slice(1)
  .filter((b) => /featured:true/.test(b.slice(0, 300)))
  .map((b) => b.slice(0, b.indexOf("'")));
const to = page.indexOf("const TOP_ORDER = [");
const toEnd = page.indexOf("];", to);
const topOrder = to < 0 ? [] : [...page.slice(to, toEnd).matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);

const catalog = read("src/app/api/execute/serviceCatalog.ts");
const entries = catalog.split(/\n  \{ id: "/).slice(1);
const catalogAll = [], blocked = [];
for (const e of entries) {
  const id = e.slice(0, e.indexOf('"'));
  catalogAll.push(id);
  if (/tier: "blocked"/.test(e.slice(0, 400))) blocked.push(id);
}
const buildable = catalogAll.filter((id) => !blocked.includes(id));

const prices = read("src/lib/servicePrices.ts");
const priceKeys = [...prices.matchAll(/^  ([a-z0-9]+): \d+/gm)].map((m) => m[1]).filter((k) => k !== "credential");

const builderKeys = new Set();
for (const f of ["src/app/api/execute/txBuilder.ts", "src/app/api/execute/serviceBuilders.ts"]) {
  for (const m of read(f).matchAll(/^  ([a-z0-9]+): (?:\(|async|builders\.)/gm)) builderKeys.add(m[1]);
}

const names = read("src/app/api/create-payment/route.ts");
const nameKeys = [...names.slice(names.indexOf("const NAMES"), names.indexOf("const MAX_DONATION")).matchAll(/([a-z0-9]+):'/g)].map((m) => m[1]).filter((k) => !["credential", "donate"].includes(k));

const N = buildable.length;
same("page vs catalog", set(pageIds), set(buildable), "the homepage", "the catalog (buildable)");
same("price table vs catalog", set(priceKeys), set(buildable), "servicePrices.ts", "the catalog (buildable)");
same("builders vs catalog", builderKeys, set(catalogAll), "the builders", "the catalog");
same("payment names vs catalog", set(nameKeys), set(buildable), "create-payment NAMES", "the catalog (buildable)");
same("TOP_ORDER vs page", set([...topOrder, ...featuredIds]), set(pageIds), "TOP_ORDER + featured", "the homepage");
if (blocked.some((id) => pageIds.includes(id))) fail("a blocked service is on the homepage: " + blocked.filter((id) => pageIds.includes(id)).join(", "));

// ── hard-coded counts ────────────────────────────────────────────────────────
// a count is a number that isn't part of a longer or comma-grouped number ("5,000 transactions")
const COUNT = /(?<![\d,.])\b(\d{2,3})\b(?![,.]\d)(?=[ `*]+(?:(?:XRPL|Done-For-You|paid|prebuilt)[ `*]+)*(?:actions?|services?|Services|ids|build_xrpl_transaction|prebuilt|transaction))/g;
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".next", ".git"].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk("src"), "README.md", "../README.md", "../CLAUDE.md", "../server.json"].filter((f) => fs.existsSync(path.join(root, f)));
for (const f of files) {
  read(f).split("\n").forEach((line, i) => {
    if (/SERVICE_COUNT|PRODUCTS\.length|BUILDABLE_SERVICE_IDS/.test(line) && !/\b\d{2,3}\b(?=[ `*]+(?:XRPL |paid )*(?:actions?|services?))/.test(line.replace(/\$\{[^}]*\}/g, ""))) return;
    for (const m of line.matchAll(COUNT)) {
      if (Number(m[1]) !== N) fail(`${f}:${i + 1}: says "${m[1]}" services/actions but the catalog has ${N}: ${line.trim().slice(0, 110)}`);
    }
  });
}

// ── no AI-as-actor claims in public copy (there is no LLM in the shipped code) ──
const AI_CLAIM = /\bAI[- ](?:builds|assembles|verifies|does|will build|is building|delivers|reviews|triages|evaluates|underwrit\w*|powered|delivered|generated)|\bAI-powered|\bOur AI\b|\bpowered by AI\b/i;
for (const f of ["src/app/page.tsx", "src/app/layout.tsx", "src/app/llms.txt/route.ts", "src/app/openapi.json/route.ts", "src/app/api/execute/serviceCatalog.ts", "src/app/.well-known/x402/route.ts", "../README.md", "../server.json"]) {
  if (!fs.existsSync(path.join(root, f))) continue;
  read(f).split("\n").forEach((line, i) => { if (AI_CLAIM.test(line)) fail(`${f}:${i + 1}: AI claim (there is no LLM in the shipped code): ${line.trim().slice(0, 110)}`); });
}

if (problems.length) {
  console.error(`\n✖ service parity check FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error("  - " + p);
  console.error("\nThe homepage, catalog, price table, builders and docs must describe the same services. Fix the mismatch above.\n");
  process.exit(1);
}
console.log(`✔ service parity OK — ${N} services; page, catalog, prices, builders, names and TOP_ORDER agree; no stale counts; no AI claims.`);
