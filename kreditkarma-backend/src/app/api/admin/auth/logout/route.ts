// src/app/api/admin/auth/logout/route.ts
// POST -> clears the admin session cookie. Stateless sessions (adminSession.ts) can't be revoked
// server-side before they expire, but this at least removes it from the browser immediately.
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/adminSession";

export async function POST() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(ADMIN_SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
