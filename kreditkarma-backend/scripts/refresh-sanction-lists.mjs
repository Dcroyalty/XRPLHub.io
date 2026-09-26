// scripts/refresh-sanction-lists.mjs
// Operator tool: run the sanctions-list ingestion (OFAC-SDN, EU-FSF, UK-SL) from a laptop, through the SAME code path as the daily
// cron (src/lib/sanctionLists.ts), including every integrity gate. Useful for a first ingestion after a deploy, or an emergency
// refresh when a cron run failed.
//
//   DATABASE_URL=postgresql://… node --import ./scripts/ts-hooks.mjs scripts/refresh-sanction-lists.mjs [--force] [LIST …]
//   node --import ./scripts/ts-hooks.mjs scripts/refresh-sanction-lists.mjs --env     # use DATABASE_URL from ./.env (production!)
//
// --force skips only the "publication stamp unchanged" shortcut and the drop-ratio gates; the size gate, the record-count floor
// and the empty-list gate still apply to the first snapshot. Prints one JSON line per list.

import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
if (args.includes("--env")) await import("dotenv/config");
const force = args.includes("--force");
const wanted = args.filter((a) => !a.startsWith("--"));
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (pass it in the environment, or use --env to read ./.env).");
  process.exit(2);
}
const host = new URL(process.env.DATABASE_URL).host;
console.error(`database host: ${host}`);

const prisma = new PrismaClient();
const { refreshList, LIST_NAMES } = await import("../src/lib/sanctionLists.ts");
const names = wanted.length ? wanted : LIST_NAMES;
let bad = 0;
for (const name of names) {
  if (!LIST_NAMES.includes(name)) {
    console.error(`unknown list ${name}; known: ${LIST_NAMES.join(", ")}`);
    bad++;
    continue;
  }
  const t = Date.now();
  const r = await refreshList(prisma, name, { force });
  console.log(JSON.stringify({ ...r, ms: Date.now() - t }));
  if (r.action.startsWith("blocked")) bad++;
}
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
