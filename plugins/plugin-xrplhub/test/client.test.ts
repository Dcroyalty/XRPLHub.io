import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, XRPLHUB_MCP_URL, type FetchLike } from "../src/client.ts";

const rpc = (payload: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
const fakeFetch = (status: number, body: string, seen?: { url?: string; body?: string }): FetchLike => async (url, init) => {
  if (seen) {
    seen.url = url;
    seen.body = init.body;
  }
  return { ok: status < 400, status, text: async () => body };
};

test("posts a JSON-RPC tools/call to the fixed XRPLHub MCP url", async () => {
  const seen: { url?: string; body?: string } = {};
  const c = createClient({ fetchImpl: fakeFetch(200, rpc({ ok: 1 }), seen) });
  const r = await c.callTool("check_xrpl_score", { wallet_address: "rX" });
  assert.equal(seen.url, XRPLHUB_MCP_URL);
  assert.equal(XRPLHUB_MCP_URL, "https://www.xrplhub.io/api/mcp");
  const sent = JSON.parse(seen.body!);
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "tools/call");
  assert.deepEqual(sent.params, { name: "check_xrpl_score", arguments: { wallet_address: "rX" } });
  assert.deepEqual(r, { ok: true, data: { ok: 1 } });
});

test("a tool-level { error } becomes a failure that keeps the data", async () => {
  const c = createClient({ fetchImpl: fakeFetch(200, rpc({ error: "Invalid XRPL wallet address.", missingParams: ["x"] })) });
  const r = await c.callTool("build_xrpl_transaction", {});
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "Invalid XRPL wallet address.");
    assert.equal(r.retryable, false);
    assert.deepEqual(r.data?.missingParams, ["x"]);
  }
});

test("JSON-RPC error, 5xx, non-JSON and empty output are all failures, never throws", async () => {
  const cases: [number, string, boolean][] = [
    [200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Tool not found: nope" } }), false],
    [503, "upstream down", true],
    [200, "<html>not json</html>", false],
    [200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), false],
    [200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "not json" }] } }), false],
    [200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "[1,2]" }] } }), false],
  ];
  for (const [status, body, retryable] of cases) {
    const r = await createClient({ fetchImpl: fakeFetch(status, body) }).callTool("x", {});
    assert.equal(r.ok, false, body);
    if (!r.ok) assert.equal(r.retryable, retryable, body);
  }
});

test("a network failure or timeout is a retryable failure that says nothing was built", async () => {
  const boom: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  const timeout: FetchLike = async () => {
    const e = new Error("timed out");
    e.name = "TimeoutError";
    throw e;
  };
  for (const f of [boom, timeout]) {
    const r = await createClient({ fetchImpl: f }).callTool("x", {});
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.retryable, true);
      assert.match(r.error, /Nothing was built or charged/);
    }
  }
});

test("an oversized response is refused", async () => {
  const r = await createClient({ fetchImpl: fakeFetch(200, "x".repeat(2_000_001)) }).callTool("x", {});
  assert.equal(r.ok, false);
});
