// A tiny client for XRPLHub's public MCP endpoint (JSON-RPC 2.0 over HTTPS POST).
//
// One transport on purpose: every tool this plugin exposes is a tool the hosted MCP server already serves, so the two
// can never drift and there is nothing for an operator to configure. The endpoint is fixed (no env var, no setting):
// pointing an agent that can be asked to build value-moving transactions at an operator-supplied URL is exactly the
// kind of knob that should not exist. `url` is a constructor argument for tests only.

export const XRPLHUB_ORIGIN = "https://www.xrplhub.io";
export const XRPLHUB_MCP_URL = `${XRPLHUB_ORIGIN}/api/mcp`;

const MAX_RESPONSE_CHARS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 25_000;

export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; retryable: boolean; data?: Record<string, unknown> };

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface XrplhubClient {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Test seam. Not exposed through plugin settings. */
  url?: string;
}

let nextId = 1;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createClient(opts: ClientOptions = {}): XrplhubClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = opts.url ?? XRPLHUB_MCP_URL;

  return {
    async callTool(name, args) {
      let raw: string;
      let status: number;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        raw = await res.text();
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        return {
          ok: false,
          retryable: true,
          error: timedOut
            ? `XRPLHub did not answer within ${Math.round(timeoutMs / 1000)}s. Nothing was built or charged; try again.`
            : "XRPLHub could not be reached. Nothing was built or charged; try again shortly.",
        };
      }

      if (raw.length > MAX_RESPONSE_CHARS) {
        return { ok: false, retryable: false, error: "XRPLHub returned an unexpectedly large response; refusing to use it." };
      }
      if (status >= 500) {
        return { ok: false, retryable: true, error: `XRPLHub is temporarily unavailable (HTTP ${status}). Try again shortly.` };
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        return { ok: false, retryable: false, error: `XRPLHub returned a response that is not JSON (HTTP ${status}).` };
      }
      if (!isRecord(envelope)) return { ok: false, retryable: false, error: "XRPLHub returned an unexpected response shape." };

      if (isRecord(envelope.error)) {
        const msg = typeof envelope.error.message === "string" ? envelope.error.message : "unknown error";
        return { ok: false, retryable: false, error: `XRPLHub rejected the call: ${msg}` };
      }

      const result = envelope.result;
      const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
      const first = content[0];
      const text = isRecord(first) && typeof first.text === "string" ? first.text : null;
      if (text === null) return { ok: false, retryable: false, error: "XRPLHub returned no tool output." };

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, retryable: false, error: "XRPLHub returned tool output that is not JSON." };
      }
      if (!isRecord(data)) return { ok: false, retryable: false, error: "XRPLHub returned unexpected tool output." };

      // The hosted tools report their own failures as { error: "..." } inside a successful JSON-RPC result.
      if (typeof data.error === "string" && data.error) {
        return { ok: false, retryable: false, error: data.error, data };
      }
      return { ok: true, data };
    },
  };
}
