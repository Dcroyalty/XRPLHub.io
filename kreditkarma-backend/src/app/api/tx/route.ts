// src/app/api/tx/route.ts
// FREE: the unsigned transaction for any of the 35 XRPL services. See src/lib/freeTxHttp.ts.
import { handleFreeTxRequest } from "@/lib/freeTxHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleFreeTxRequest;
export const POST = handleFreeTxRequest;
