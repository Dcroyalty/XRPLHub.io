// src/app/api/admin/cdp-diag/route.ts
// TEMPORARY — functional check of CDP_API_KEY_ID / CDP_API_KEY_SECRET as THIS
// deployment sees them. Never logs or returns the values, only presence +
// length. Makes one real authenticated call to the CDP-hosted x402 facilitator
// (POST /verify with an intentionally empty body) and reports the raw
// status + body so a human can read the verdict:
//   401/403            -> credentials missing, empty, or wrong
//   400 (structured)    -> credentials WORK; body was just incomplete (PASS)
//   anything else       -> reported verbatim, not interpreted
//
// Delete this route once the check is done — it exists only to answer that
// one question.
//
//   curl -s https://www.xrplhub.io/api/admin/cdp-diag \
//     -H "authorization: Bearer $ADMIN_API_TOKEN"

import { NextResponse } from "next/server";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACILITATOR_HOST = "api.cdp.coinbase.com";
const FACILITATOR_PATH = "/platform/v2/x402/verify";
const FACILITATOR_URL = `https://${FACILITATOR_HOST}${FACILITATOR_PATH}`;

export async function GET(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();

  const keyId = process.env.CDP_API_KEY_ID ?? "";
  const keySecret = process.env.CDP_API_KEY_SECRET ?? "";

  const env = {
    CDP_API_KEY_ID: { present: keyId.length > 0, length: keyId.length },
    CDP_API_KEY_SECRET: { present: keySecret.length > 0, length: keySecret.length },
  };

  if (!keyId || !keySecret) {
    return NextResponse.json({
      env,
      call: null,
      verdict: "FAIL - one or both env vars are missing/empty on this deployment",
    });
  }

  let jwt: string;
  try {
    jwt = await generateJwt({
      apiKeyId: keyId,
      apiKeySecret: keySecret,
      requestMethod: "POST",
      requestHost: FACILITATOR_HOST,
      requestPath: FACILITATOR_PATH,
    });
  } catch (e) {
    return NextResponse.json({
      env,
      call: null,
      jwtError: e instanceof Error ? e.message : String(e),
      verdict: "FAIL - could not build a JWT from the key material (malformed key, not merely absent)",
    });
  }

  let status = 0;
  let bodyText = "";
  try {
    const res = await fetch(FACILITATOR_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    status = res.status;
    bodyText = await res.text();
  } catch (e) {
    return NextResponse.json({
      env,
      call: null,
      fetchError: e instanceof Error ? e.message : String(e),
      verdict: "INCONCLUSIVE - network error reaching the facilitator",
    });
  }

  let body: unknown = bodyText;
  try { body = JSON.parse(bodyText); } catch { /* keep raw text */ }

  let verdict: string;
  if (status === 401 || status === 403) {
    verdict = `FAIL - HTTP ${status}: credentials missing, empty, or wrong`;
  } else if (status === 400) {
    verdict = "PASS - HTTP 400 structured validation error: credentials WORK, request body was just incomplete";
  } else {
    verdict = `UNEXPECTED - HTTP ${status}, see body verbatim`;
  }

  return NextResponse.json({ env, call: { url: FACILITATOR_URL, status, body }, verdict });
}
