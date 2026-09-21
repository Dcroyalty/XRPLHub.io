// scripts/check-attestation-freshness.mjs
// HARD GATE (runs in `npm run build`): a cached XRPLScore must never reach an anchored or signed attestation.
//
// Attestation paths anchor `xrplScore` in a Merkle leaf or sign it into a credential. They MUST call scoreWallet()
// directly. Two ways to break that, both failed here:
//   1. IMPORT  — the module imports the 15-minute display cache (scoreCache / getScoreCached).
//   2. HTTP HOP — the module fetches the score over HTTP from /api/score/* or /api/v1/score, which are served from that
//      cache. (The paid credential route did exactly this; an import-only check cannot see it.)
// Comments are stripped before matching so a comment may say what NOT to do.
//
// The module list must not rot: every listed file has to exist, or the build fails (a renamed file used to make this
// gate pass silently).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Modules and routes that produce an anchored/signed receipt containing a score.
const ATTESTATION_MODULES = [
  "src/lib/lendingExposure.ts",
  "src/lib/lendingCanon.ts",
  "src/lib/lendingSweep.ts",
  "src/lib/underwriteBundle.ts",
  "src/lib/underwriteCanon.ts",
  "src/lib/underwriteAnchor.ts",
  "src/lib/credentials.ts",
  "src/lib/screen.ts",
  "src/lib/screenCanon.ts",
  "src/lib/monitorEngine.ts",
  "src/lib/monitorCanon.ts",
  "src/lib/monitorAnchor.ts",
  "src/lib/monitorWebhook.ts",
  "src/app/api/credential/route.ts", // the paid, signed score certificate
];

const IMPORT_CACHE = /from\s+["'][^"']*scoreCache["']|require\(\s*["'][^"']*scoreCache["']|getScoreCached/;
// any mention of the cache-backed score routes in CODE (comments are stripped first)
const HTTP_HOP = /\/api\/(?:v1\/)?score(?![A-Za-z0-9_-])/;

/** Remove block comments, full-line // comments and trailing " // ..." comments (a URL's "://" is not a comment). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split(/\r?\n/)
    .map((l) => (/^\s*\/\//.test(l) ? "" : l.replace(/(^|[^:])\s\/\/.*$/, "$1")));
}

const violations = [];
for (const rel of ATTESTATION_MODULES) {
  const file = resolve(root, rel);
  if (!existsSync(file)) {
    violations.push(`${rel}  MISSING — the gate's module list is stale (renamed or deleted?); update ATTESTATION_MODULES`);
    continue;
  }
  const lines = stripComments(readFileSync(file, "utf8"));
  lines.forEach((line, i) => {
    if (IMPORT_CACHE.test(line)) violations.push(`${rel}:${i + 1}  imports the display cache: ${line.trim()}`);
    else if (HTTP_HOP.test(line)) violations.push(`${rel}:${i + 1}  fetches a cache-backed score route over HTTP: ${line.trim()}`);
  });
}

if (violations.length) {
  console.error("\n✗ ATTESTATION FRESHNESS GATE FAILED\n");
  console.error("  A cached XRPLScore must never be anchored/signed as current.\n");
  for (const v of violations) console.error("    " + v);
  console.error("\n  Fix: call scoreWallet() directly in the attestation path (never via scoreCache or /api/score).\n");
  process.exit(1);
}

console.log(`✓ attestation-freshness gate: ${ATTESTATION_MODULES.length} attestation modules — none imports the score cache or calls a cache-backed score route`);
