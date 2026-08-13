// src/lib/xrplscore-db.ts
// A dedicated Prisma client for the XRPLScore tables. Named separately so it
// never touches your existing src/lib/db.ts. Cached on globalThis under a
// unique key so it coexists cleanly with your app's own client.
//
// (Later cleanup, optional: if you'd rather share one client, point these
// imports at your existing db.ts — but this works as-is today.)

import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { xrplscorePrisma?: PrismaClient };

export const prisma =
  g.xrplscorePrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") g.xrplscorePrisma = prisma;
