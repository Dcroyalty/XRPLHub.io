// src/app/api/spend/config/route.ts — GET: what the Spend Controls pages may promise (reminders only once proven).
import { REMINDERS_UNAVAILABLE, remindersAvailable, spendJson } from "@/lib/spendApi";

export const dynamic = "force-dynamic";

export function GET() {
  return spendJson({ reminders: remindersAvailable(), remindersNote: remindersAvailable() ? null : REMINDERS_UNAVAILABLE });
}
