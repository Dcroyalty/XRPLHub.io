// scripts/check-attestation-freshness.mjs
// HARD GATE (runs in `npm run build`): the 15-minute score cache must never
// reach an anchored/signed attestation. If any attestation module imports the
// cache, the build fails.
//
// Attestation paths anchor `xrplScore` in a Merkle leaf or sign it into a
// credential. They MUST call scoreWallet() directly.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Modules that produce an anchored/signed receipt containing a score.
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
];

const FORBIDDEN = /from\s+["'][^"']*scoreCache["']|require\(\s*["'][^"']*scoreCache["']|getScoreCached/;

const violations = [];
for (const rel of ATTESTATION_MODULES) {
  let src;
  try {
    src = readFileSync(resolve(root, rel), "utf8");
  } catch {
    continue; // module may not exist in every checkout
  }
  src.split(/\r?\n/).forEach((line, i) => {
    if (FORBIDDEN.test(line)) violations.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
}

if (violations.length) {
  console.error("\n✗ ATTESTATION FRESHNESS GATE FAILED\n");
  console.error("  A cached XRPLScore must never be anchored/signed as current.");
  console.error("  These attestation modules reference the display cache:\n");
  for (const v of violations) console.error("    " + v);
  console.error("\n  Fix: call scoreWallet() directly in the attestation path.\n");
  process.exit(1);
}

console.log("✓ attestation-freshness gate: no attestation module imports the score cache");
