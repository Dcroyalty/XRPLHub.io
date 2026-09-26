// GET /api/domains/guide — the plain-English integration guide for gating a Permissioned Domain on XRPLScore credentials. Free, markdown.
import { DOMAIN_GUIDE_MD } from "@/lib/domainGuide";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  return new Response(DOMAIN_GUIDE_MD, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
