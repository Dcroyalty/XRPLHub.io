// scripts/show-push-request.ts — print the EXACT JSON body our code POSTs to Xaman for a push (the admin test push and the
// daily subscription reminder), token masked. Xaman is a local stand-in that only records the request.
//
//   node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/show-push-request.ts

process.env.XUMM_API_KEY = "k"; process.env.XUMM_API_SECRET = "s"; process.env.ADMIN_API_TOKEN = "local";
const TOKEN = "c5bc4ccc-28fa-4080-b702-0d3aac97b993"; // stand-in token (the example from Xaman's Push docs)
const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  sent.push({ url: u, method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, /secret|key/i.test(k) ? "***" : v])), body });
  if (u.includes("/payload/")) return Response.json({ meta: { exists: true, signed: true }, application: { issued_user_token: TOKEN }, response: { account: "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF" }, payload: {}, custom_meta: {} });
  if (u.endsWith("/payload")) return Response.json({ uuid: "60b28b46-0000-4000-8000-000000000000", next: { always: "x" }, refs: {}, pushed: false });
  return Response.json({});
}) as typeof fetch;

const { POST } = await import("@/app/api/admin/xaman-push/route");
const { pushSignRequest } = await import("@/lib/spendApi");
const mask = (o: unknown) => JSON.parse(JSON.stringify(o).split(TOKEN).join("c5bc…(masked)"));

await POST(new Request("https://x/api/admin/xaman-push", { method: "POST", headers: { authorization: "Bearer local" }, body: JSON.stringify({ tokenFrom: "11111111-2222-4333-8444-555555555555" }) }));
const adminPush = sent.find((s) => s.method === "POST" && s.url.endsWith("/payload"));
console.log("ADMIN TEST PUSH →", adminPush!.method, adminPush!.url);
console.log("headers:", JSON.stringify(adminPush!.headers));
console.log(JSON.stringify(mask(adminPush!.body), null, 2));

sent.length = 0;
await pushSignRequest({ TransactionType: "CheckCreate", Account: "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF", Destination: "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f", SendMax: "1000000" }, "subscription: 1 XRP to Issuer", "cmv1b95kl0000k006c36ihr5a", TOKEN);
const reminder = sent.find((s) => s.method === "POST" && s.url.endsWith("/payload"));
console.log("\nDAILY REMINDER →", reminder!.method, reminder!.url);
console.log(JSON.stringify(mask(reminder!.body), null, 2));

const b = adminPush!.body as Record<string, unknown>;
const topLevel = typeof b.user_token === "string" && !("user_token" in (b.options as object)) && !("user_token" in (b.txjson as object));
console.log(`\nuser_token is a top-level string field (not in options, not in txjson): ${topLevel}`);
process.exit(topLevel ? 0 : 1);
