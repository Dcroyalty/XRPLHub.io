// Fails the build if this package ever grows a signing, key-handling, submission or configuration surface.
// "Unsigned only, no custody" is the whole trust story of this plugin, so it is enforced by a check, not a comment.
//
// Runs against the BUILT output (dist/), i.e. what actually ships.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const problems = [];
const fail = (m) => problems.push(m);

if (!fs.existsSync(path.join(dist, "index.js"))) {
  console.error("check-surface: dist/index.js missing; run `npm run build` first.");
  process.exit(1);
}

// 1. The plugin object: actions only.
const mod = await import(pathToFileURL(path.join(dist, "index.js")).href);
const plugin = mod.default;
if (!plugin || plugin !== mod.xrplhubPlugin) fail("default export must be xrplhubPlugin");
for (const k of ["services", "providers", "evaluators", "routes", "events", "models", "init", "config", "dependencies", "adapter"]) {
  const v = plugin?.[k];
  const empty = v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && Object.keys(v).length === 0);
  if (!empty) fail(`plugin.${k} must be empty/absent (found ${typeof v})`);
}
const expected = ["XRPLHUB_SCORE_WALLET", "XRPLHUB_SCREEN_ADDRESS", "XRPLHUB_MPT_RISK", "XRPLHUB_LIST_SERVICES", "XRPLHUB_PREVIEW_TRANSACTION", "XRPLHUB_BUILD_TRANSACTION"];
const names = (plugin?.actions ?? []).map((a) => a.name);
if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`actions must be exactly ${expected.join(", ")} (found ${names.join(", ")})`);

// 2. package.json declares no settings.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const params = pkg.agentConfig?.pluginParameters ?? {};
if (Object.keys(params).length) fail("package.json agentConfig.pluginParameters must be empty (no settings)");
if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail("package.json must have no runtime dependencies");

// 3. Shipped JS: no key/signing/submission vocabulary, no env access, and only node:crypto imported.
const FORBIDDEN = [
  [/privateKey|private_key|secretKey|mnemonic|passphrase/i, "key material vocabulary"],
  [/\bseed\b/i, "seed"],
  [/process\.env/, "environment access"],
  [/\.sign\(|signTransaction|sign_transaction|multisign|walletFromSeed|Wallet\.from/i, "signing call"],
  [/submitAndWait|\bsubmit\(|"submit"|'submit'|submit_multisigned|sendTransaction/, "submission call"],
  [/from\s+["'](?!node:crypto["'])(?!\.\/)[^"']+["']/, "runtime import other than node:crypto"],
  [/require\(/, "require()"],
  [/\.(transactions?|txjson)\b/, "reads a transaction/txjson field from a server response (this plugin must never pass a signable transaction on)"],
  [/child_process|node:fs|node:net|node:http/, "process/file/network module"],
];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
for (const file of walk(dist).filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const [re, what] of FORBIDDEN) {
    const m = re.exec(text);
    if (m) fail(`${path.relative(root, file)}: forbidden ${what}: ${m[0]}`);
  }
}

// 4. The endpoint is fixed to XRPLHub (no operator-supplied URL reaches the plugin).
const client = fs.readFileSync(path.join(dist, "client.js"), "utf8");
if (!client.includes("https://www.xrplhub.io")) fail("client must pin https://www.xrplhub.io");

if (problems.length) {
  console.error("check-surface FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log(`check-surface OK: ${names.length} actions, no services/providers/settings, no signing/key/submit vocabulary, only node:crypto imported.`);
