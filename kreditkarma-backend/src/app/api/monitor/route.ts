// GET /api/monitor — what the continuous-monitoring service does, its limits and its honest capacity. No key needed.
import { NextResponse } from "next/server";
import { describeMonitoring } from "@/lib/monitorApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await describeMonitoring(), { headers: { "Cache-Control": "public, max-age=60" } });
}
