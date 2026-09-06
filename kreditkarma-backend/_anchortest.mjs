import "dotenv/config";
import { computeRegistrySnapshot, canonJson, merkleRoot, CANON_VERSION } from "./src/lib/mptAnchor.ts";
import { mptCoverage } from "./src/lib/mptIndex.ts";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const s1 = await computeRegistrySnapshot(prisma);
const s2 = await computeRegistrySnapshot(prisma);
console.log("CANON_VERSION:", CANON_VERSION);
console.log("records:", s1.issuanceCount, "issuers:", s1.issuerCount);
console.log("root run 1:", s1.merkleRoot);
console.log("root run 2:", s2.merkleRoot);
console.log("deterministic:", s1.merkleRoot === s2.merkleRoot);
console.log("sample leaf[0]:", canonJson(s1.records[0]).slice(0,160));
// independent recompute
const jsons = s1.records.map(canonJson);
console.log("independent merkleRoot():", merkleRoot(jsons), "== snapshot:", merkleRoot(jsons) === s1.merkleRoot);
const cov = await mptCoverage(prisma);
console.log("coverage:", JSON.stringify(cov, null, 1));
await prisma.$disconnect();
