// scripts/test-ledger-halt-watchdog.ts — the watchdog's "ledger halted" vs "our nodes are bad" check, against fake
// XRPL nodes served locally (each answers server_info with a chosen validated-ledger age).
//
//   node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/test-ledger-halt-watchdog.ts

import http from "node:http";
import { checkLedgerHalt } from "@/lib/watchdog";

const nodes: Record<string, { seq: number; age: number }> = {};
const server = http.createServer((req, res) => {
  const n = nodes[req.url ?? ""];
  if (!n) { res.writeHead(500); res.end(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: { info: { network_id: 0, amendment_blocked: false, validated_ledger: { seq: n.seq, age: n.age } } } }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

let fails = 0;
async function scenario(name: string, set: Record<string, { seq: number; age: number } | null>, want: { level: string; includes: string }) {
  for (const k of Object.keys(nodes)) delete nodes[k];
  const urls: string[] = [];
  for (const [p, v] of Object.entries(set)) { if (v) nodes[p] = v; urls.push(url(p)); }
  const f = await checkLedgerHalt(urls);
  const ok = f.level === want.level && f.message.includes(want.includes);
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗"} ${name}\n    → ${f.level.toUpperCase()}: ${f.message}`);
}

await scenario("every node stuck on ledger 5000 for 16 minutes (a network halt)", {
  "/a": { seq: 5000, age: 960 }, "/b": { seq: 5000, age: 965 }, "/c": { seq: 5000, age: 961 },
}, { level: "red", includes: "XRP LEDGER HALTED — the network, not XRPLHub" });
await scenario("two nodes current, one stuck 15 min behind (our bad node)", {
  "/a": { seq: 9000, age: 2 }, "/b": { seq: 9000, age: 3 }, "/c": { seq: 8780, age: 900 },
}, { level: "red", includes: "OUR NODES, not the ledger" });
await scenario("no node answers (our connectivity)", { "/a": null, "/b": null }, { level: "red", includes: "OUR SIDE" });
await scenario("all nodes current (normal)", {
  "/a": { seq: 9100, age: 1 }, "/b": { seq: 9100, age: 2 }, "/c": { seq: 9100, age: 4 },
}, { level: "ok", includes: "closing normally" });

server.close();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nAll 4 scenarios passed.");
process.exit(fails ? 1 : 0);
