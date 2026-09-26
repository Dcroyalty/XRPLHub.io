// scripts/ts-hooks.mjs
// Lets plain `node` run the project's real TypeScript source in scripts and tests, with no bundler:
//   node --import ./scripts/ts-hooks.mjs some-script.mjs
// Node 22.18+/24 strips types natively; this adds the two things it does not do: resolve the `@/` alias to src/, and
// resolve extensionless relative imports (`./notify`) to `.ts`. Only for offline tooling — the app itself is built by Next.
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = [".ts", ".tsx", ".mts", "/index.ts"];

function tryFile(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const e of EXTS) {
    const f = base + e;
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && context.parentURL.includes("/node_modules/")) return nextResolve(specifier, context);
    let base = null;
    if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
    else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (base) {
      const f = tryFile(base);
      if (f) return nextResolve(pathToFileURL(f).href, context);
    }
    return nextResolve(specifier, context);
  },
});
