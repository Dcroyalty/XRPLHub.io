import { notifyError, alertingArmed } from "./src/lib/notify.ts";
// 1. no webhook set — must not throw, must resolve
process.env.ERROR_WEBHOOK_URL = "";
await notifyError("test/no-hook", new Error("should only log"), { a: 1 });
console.log("no-hook: ok, armed =", alertingArmed());
// 2. garbage webhook — must not throw
process.env.ERROR_WEBHOOK_URL = "not-a-url";
await notifyError("test/bad-url", new Error("bad url"), {});
console.log("bad-url: ok");
// 3. unreachable https webhook — must not throw, times out gracefully
process.env.ERROR_WEBHOOK_URL = "https://127.0.0.1:9/webhook";
const t = Date.now();
await notifyError("test/unreachable", new Error("unreachable host"), {});
console.log("unreachable: ok, took", Date.now()-t, "ms");
// 4. un-awaited (fire and forget) — must not throw synchronously
process.env.ERROR_WEBHOOK_URL = "https://127.0.0.1:9/x";
notifyError("test/fire-forget", "string error");
console.log("fire-forget: ok (no sync throw)");
