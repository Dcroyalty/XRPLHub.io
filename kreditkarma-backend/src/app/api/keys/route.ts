// app/api/keys/route.ts
// Admin-only key issuance. POST here with the ADMIN_API_TOKEN to mint a key.
// The raw key is returned exactly ONCE — it is never retrievable again.
//
//   curl -X POST https://YOURAPP/api/keys \
//     -H "authorization: Bearer $ADMIN_API_TOKEN" \
//     -H "content-type: application/json" \
//     -d '{"name":"acme","plan":"starter"}'

import { NextResponse } from "next/server";
import { generateApiKey } from "@/lib/keys";
import { getPlan } from "@/lib/plans";
import { prisma } from "@/lib/xrplscore-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminOk(req: Request): boolean {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export async function POST(req: Request) {
  if (!adminOk(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    plan?: string;
    ttlDays?: number; // admin-minted keys don't expire by default; pass to time-box one
  };
  const plan = getPlan(body.plan ?? "free").id;
  const expiresAt =
    typeof body.ttlDays === "number" && body.ttlDays > 0
      ? new Date(Date.now() + body.ttlDays * 86_400_000)
      : null;

  const gen = generateApiKey();
  const record = await prisma.apiKey.create({
    data: {
      keyPrefix: gen.keyPrefix,
      keyHash: gen.keyHash,
      name: body.name ?? null,
      plan,
      expiresAt,
    },
  });

  return NextResponse.json(
    {
      id: record.id,
      plan,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      key: gen.full, // shown ONCE — tell the customer to store it now
      note: "Store this key now. It cannot be shown again.",
    },
    { status: 201 }
  );
}

// List keys (metadata only — never the raw key or hash).
export async function GET(req: Request) {
  if (!adminOk(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const keys = await prisma.apiKey.findMany({
    select: {
      id: true,
      name: true,
      plan: true,
      active: true,
      keyPrefix: true,
      createdAt: true,
      lastUsedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data: keys });
}
