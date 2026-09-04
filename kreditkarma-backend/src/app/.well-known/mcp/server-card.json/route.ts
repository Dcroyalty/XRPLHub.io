// src/app/.well-known/mcp/server-card.json  (route segment: server-card)
// MCP Server Card — https://modelcontextprotocol.io + Smithery's documented shape.
// Served so scanners (Smithery et al.) read the CURRENT tool set instead of a
// one-time crawl of a truncated description. Generated from the same TOOLS array
// the JSON-RPC endpoint uses, so it can never drift.

import { NextResponse } from "next/server";
import { TOOLS, MCP_SERVER_INFO } from "@/app/api/mcp/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  return NextResponse.json(
    {
      $schema: "https://modelcontextprotocol.io/schemas/draft/2025-06-18/server-card.json",
      version: "1.0",
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
        description: MCP_SERVER_INFO.description,
        websiteUrl: origin,
      },
      transport: { type: "streamable-http", url: `${origin}/api/mcp` },
      authentication: { required: false },
      capabilities: { tools: {} },
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      resources: [],
      prompts: [],
    },
    { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } }
  );
}
