// scripts/alias-hooks.mjs — Node module hooks so scripts can import the app's TypeScript directly (Node 24 strips
// types): "@/x" → src/x(.ts|/index.ts), and extensionless relative imports inside src → the .ts file.
// Used by scripts/test-autopay-cycle-testnet.ts via scripts/alias-loader.mjs.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const tryFile = (base) => {
  for (const ext of ["", ".ts", "/index.ts"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
};

export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) {
    const p = tryFile(path.join(SRC, spec.slice(2)));
    if (p) return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:") && !/\.[cm]?[jt]sx?$/.test(spec)) {
    const p = tryFile(path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec));
    if (p) return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  // "next/server" etc. are CommonJS files without an exports map: ESM needs the ".js".
  if (/^next\/[a-z-]+$/.test(spec)) return next(`${spec}.js`, ctx);
  return next(spec, ctx);
}
