// scripts/check-service-parity.mjs
// Build-time guard (runs before `next build`): XRPLHub keeps ONLY products nobody else offers (owner decision 2026-10-07 —
// the generic transaction catalog was removed). This fails the build if the catalog creeps back or the copy drifts:
//
//   1. The transactions XRPLHub still builds are exactly KEPT_TX (each used inside one of our own products), each is free,
//      the builders match, and the admin health check stays admin-only AND buildable.
//   2. The retired transaction routes answer 410 (retiredTxResponse) and never ask for payment; MCP exposes no generic
//      transaction tools.
//   3. No public copy states a service/action count or advertises a transaction catalog.
//   4. No AI-as-actor claims (there is no LLM in the shipped code); no unsupported decision-time promise.
//   5. Every paid x402 resource costs the same on both rails and goes through the dual-rail wrapper.
//
// Plain regex over source text (no TS toolchain needed), so it runs in a second.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const exists = (p) => fs.existsSync(path.join(root, p));
const problems = [];
const fail = (m) => problems.push(m);

/** The ONLY transactions XRPLHub builds publicly, and the product each one lives in. */
const KEPT_TX = {
  mptissue: "MPT issuance with a recorded backing declaration (io.xrplhub.mpt.v1.declared credential + MPT issuer risk)",
  permdomain: "XRPLScore-gated Permissioned Domain (credentials; /api/domains/build)",
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".next", ".git"].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx|md|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── 1. kept transactions ─────────────────────────────────────────────────────────────────────────────────────────────
const catalog = read("src/app/api/execute/serviceCatalog.ts");
const catalogIds = [...catalog.matchAll(/\n  \{ id: "([a-z0-9]+)"/g)].map((m) => m[1]);
const kept = Object.keys(KEPT_TX);
const extra = catalogIds.filter((id) => !kept.includes(id));
const missing = kept.filter((id) => !catalogIds.includes(id));
if (extra.length) fail(`serviceCatalog.ts lists transactions outside our products: ${extra.join(", ")} — the generic catalog was removed 2026-10-07 (add to KEPT_TX only with the product it lives in)`);
if (missing.length) fail(`serviceCatalog.ts is missing kept transactions: ${missing.join(", ")}`);

const prices = read("src/lib/servicePrices.ts");
const priceOf = Object.fromEntries([...prices.matchAll(/^  ([a-z0-9]+): ([\d.]+)/gm)].map((m) => [m[1], Number(m[2])]));
for (const id of kept) if (priceOf[id] !== 0) fail(`servicePrices.ts: "${id}" must be free ($0), found ${priceOf[id]}`);
const pricedTx = Object.keys(priceOf).filter((k) => !kept.includes(k) && !["credential", "adminhealthcheck"].includes(k));
if (pricedTx.length) fail(`servicePrices.ts prices products that no longer exist: ${pricedTx.join(", ")}`);

const adminBlock = prices.slice(prices.indexOf("ADMIN_ONLY_SERVICE_IDS"));
const adminOnly = [...adminBlock.slice(0, adminBlock.indexOf("]")).matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
const builder = read("src/app/api/execute/txBuilder.ts");
const builderIds = [...builder.matchAll(/^  ([a-z0-9]+): (?:\(|async)/gm)].map((m) => m[1]);
for (const id of [...kept, ...adminOnly]) if (!builderIds.includes(id)) fail(`txBuilder.ts has no builder for "${id}"`);
const strayBuilders = builderIds.filter((id) => !kept.includes(id) && !adminOnly.includes(id));
if (strayBuilders.length) fail(`txBuilder.ts builds transactions outside our products: ${strayBuilders.join(", ")}`);
if (exists("src/app/api/execute/serviceBuilders.ts")) fail("serviceBuilders.ts is back — the generic builders were removed 2026-10-07");
const content = read("src/lib/serviceContent.ts");
for (const m of content.matchAll(/\{ id:'([a-z0-9]+)'/g)) if (!kept.includes(m[1])) fail(`serviceContent.ts shows "${m[1]}" on the homepage — not one of our products`);
for (const id of adminOnly) {
  if (catalogIds.includes(id) || content.includes(`id:'${id}'`)) fail(`admin-only "${id}" must never be customer-visible`);
}
const ex = read("src/app/api/execute/route.ts");
if (!/ADMIN_ONLY_SERVICE_IDS\.has\(productId\)\) \{\n\s*if \(!isAdmin\(req\)\)/.test(ex)) fail("src/app/api/execute/route.ts: the paid flow must be reachable only by admin-only products");
const names = read("src/app/api/create-payment/route.ts");
if (!/listPriceUsd\(product\) === 0/.test(names)) fail("create-payment must refuse free products (listPriceUsd(product) === 0)");
for (const id of kept) if (new RegExp(`\\b${id}:'`).test(names.slice(names.indexOf("const NAMES"), names.indexOf("const MAX_DONATION")))) fail(`create-payment NAMES sells "${id}" — it is free`);

// ── 2. retired routes + MCP ─────────────────────────────────────────────────────────────────────────────────────────
for (const f of ["src/app/api/tx/route.ts", "src/app/api/x402/tx/route.ts", "src/app/api/x402-tx/route.ts"]) {
  const src = read(f);
  if (!/retiredTxResponse/.test(src)) fail(`${f} must answer 410 via retiredTxResponse (the generic catalog was removed)`);
  if (/dualX402\(|withX402\(|serveX402Paid\(/.test(src)) fail(`${f} must never ask for a payment`);
}
const mcp = read("src/app/api/mcp/route.ts");
for (const t of ["list_xrpl_services", "build_xrpl_transaction", "preview_xrpl_transaction"]) {
  if (new RegExp(`name: '${t}'`).test(mcp)) fail(`MCP still exposes the generic transaction tool ${t}`);
}
// precheck_payment is PAID: it may only hand back the x402 resource, never run the check (no free verdict via MCP).
{
  const fnStart = mcp.indexOf("function toolPrecheckPayment(");
  const fnEnd = mcp.indexOf("\nasync function ", fnStart);
  const body = fnStart < 0 ? "" : mcp.slice(fnStart, fnEnd < 0 ? undefined : fnEnd);
  if (!body) fail("MCP precheck_payment handler (toolPrecheckPayment) not found");
  else if (/runPaymentPrecheck|screenAll|computeScore|fetch\(/.test(body)) fail("MCP precheck_payment must return the x402 payment resource only — it runs the check for free");
  if (!/name: 'precheck_payment'/.test(mcp)) fail("MCP precheck_payment tool definition missing");
}
if (exists("src/app/services")) fail("src/app/services is back — the per-service SEO pages were removed (next.config.ts redirects them)");

// ── 3. no service counts, no catalog in public copy ──────────────────────────────────────────────────────────────────
const COUNT = /(?<![\d,.$])\b\d{1,3}\b(?![,.]\d)\s+(?:free\s+|FREE\s+|done[- ]for[- ]you\s+|prebuilt\s+|paid\s+)*(?:XRPL\s+)?(?:transaction\s+)?(?:services|actions|transaction builders)\b/i;
const CATALOG = /transaction catalog|services? catalog|done[- ]for[- ]you xrpl|xrpl services · done/i;
const RETIRED_OK = /remov|retir|no longer|was removed|gone|410/i;
const publicCopy = [
  ...walk("src").filter((f) => /\.(ts|tsx)$/.test(f)),
  "README.md", "../README.md", "../CLAUDE.md", "../server.json", "../plugins/plugin-xrplhub/README.md",
].filter(exists);
for (const f of publicCopy) {
  read(f).split("\n").forEach((line, i) => {
    if (COUNT.test(line) && !/BATCH|batch|checks? (?:a|per) period|MAX_|\bslice\(/.test(line)) fail(`${f}:${i + 1}: states a service/action count: ${line.trim().slice(0, 110)}`);
    if (CATALOG.test(line) && !RETIRED_OK.test(line)) fail(`${f}:${i + 1}: advertises a transaction catalog: ${line.trim().slice(0, 110)}`);
  });
}

// ── 4. no AI claims / residue; no unsupported decision-time promise ─────────────────────────────────────────────────
const AI_CLAIM = /\bAI[- ](?:builds|assembles|verifies|does|will build|is building|delivers|reviews|triages|evaluates|underwrit\w*|powered|delivered|generated)|\bAI-powered|\bOur AI\b|\bpowered by AI\b/i;
for (const f of ["src/app/page.tsx", "src/app/layout.tsx", "src/app/llms.txt/route.ts", "src/app/openapi.json/route.ts", "src/app/.well-known/x402/route.ts", "../README.md", "../server.json"].filter(exists)) {
  read(f).split("\n").forEach((line, i) => { if (AI_CLAIM.test(line)) fail(`${f}:${i + 1}: AI claim (there is no LLM in the shipped code): ${line.trim().slice(0, 110)}`); });
}
const AI_RESIDUE = /ANTHROPIC_API_KEY|XAI_API_KEY|GROK_API_KEY|AI grant review|AI Underwriting|(?<!Ripple XRPL )AI Starter Kit|\bAI: \$\{|"AI" or admin/;
for (const f of [".env.example", "prisma/schema.prisma", "src/app/api/mcp/route.ts", "src/app/account/page.tsx", "src/app/api/grants/[id]/route.ts", "src/app/donate/page.tsx"].filter(exists)) {
  read(f).split("\n").forEach((line, i) => { if (AI_RESIDUE.test(line)) fail(`${f}:${i + 1}: AI residue (there is no LLM in the shipped code): ${line.trim().slice(0, 110)}`); });
}
for (const f of walk("src").filter((x) => /\.(ts|tsx)$/.test(x))) {
  read(f).split("\n").forEach((line, i) => { if (/24\s*[–-]\s*48\s*hours/i.test(line)) fail(`${f}:${i + 1}: unsupported "24–48 hours" decision time`); });
}

// ── 5. x402: one product, one price, every rail ─────────────────────────────────────────────────────────────────────
{
  const paycall = read("src/lib/paycall.ts");
  const base = read("src/lib/x402Base.ts");
  const num = (src, name) => { const m = new RegExp("export const " + name + "\\s*=\\s*([0-9.]+)").exec(src); return m ? Number(m[1]) : null; };
  for (const [rk, uk] of [["SCORE", "SCORE"], ["SCREEN", "SCREEN"], ["MPT", "MPT"], ["EXPOSURE", "EXPOSURE"], ["UNDERWRITE", "UNDERWRITE"], ["PRECHECK", "PRECHECK"], ["PRODUCT", "REPORT"]]) {
    const r = num(paycall, "PRICE_PER_" + rk + "_RLUSD"), u = num(base, "PRICE_PER_" + uk + "_USDC");
    if (r === null || u === null) fail("price pair PRICE_PER_" + rk + "_RLUSD / PRICE_PER_" + uk + "_USDC not found");
    else if (r !== u) fail("PRICE_PER_" + rk + "_RLUSD " + r + " != PRICE_PER_" + uk + "_USDC " + u + " — one product, one price, every rail");
  }
}
for (const f of walk("src/app/api/x402")) {
  if (!/route\.ts$/.test(f) || /[\\/]x402[\\/]tx[\\/]route\.ts$/.test(f)) continue; // /api/x402/tx is retired (410, checked above)
  if (!/dualX402\(|walletGetDual\(/.test(read(f))) fail(`${f}: paid x402 route is not dual-rail (use dualX402 / walletGetDual)`);
}

if (problems.length) {
  console.error(`\n✖ product-surface check FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error("  - " + p);
  console.error("\nXRPLHub keeps only products nobody else offers. Fix the drift above.\n");
  process.exit(1);
}
console.log(`✔ product-surface check OK — only our products' transactions (${kept.join(", ")} + admin health check), all free; retired routes 410; no catalog, no service counts, no AI claims; x402 prices match on both rails.`);
