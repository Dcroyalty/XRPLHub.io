// node --import ./scripts/alias-loader.mjs <script.ts> — see alias-hooks.mjs.
import { register } from "node:module";
register("./alias-hooks.mjs", import.meta.url);
