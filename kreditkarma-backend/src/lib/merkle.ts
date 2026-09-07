// src/lib/merkle.ts
// RFC 6962-style Merkle tree over an ordered list of leaf hashes. Byte-identical
// to the scheme the MPT registry anchor and the OFAC screening receipts use:
//   leaf hash  = SHA-256( 0x00 || utf8(recordJson) )   (computed by the caller)
//   node hash  = SHA-256( 0x01 || left || right )
//   odd node at a level is promoted unchanged
//   single-leaf root = that leaf hash; empty tree root = SHA-256("")
//
// Shared so lendingCanon / screenCanon don't depend on each other.

import { createHash } from "crypto";

const SHA1 = Buffer.from([0x01]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest();

export interface ProofStep {
  position: "left" | "right";
  hash: string;
}

/** Merkle root over an ordered list of 64-hex leaf-hash strings. */
export function merkleRootFromLeafHashes(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) return createHash("sha256").update("").digest("hex");
  let level: Buffer[] = leafHashesHex.map((h) => Buffer.from(h, "hex") as Buffer);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha(Buffer.concat([SHA1, level[i], level[i + 1]])));
      else next.push(level[i]); // odd node promoted unchanged
    }
    level = next;
  }
  return level[0].toString("hex");
}

/** Inclusion proof for leaf index `target` in the ordered leaf-hash list. */
export function merkleInclusionProof(leafHashesHex: string[], target: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let idx = target;
  let level: Buffer[] = leafHashesHex.map((h) => Buffer.from(h, "hex") as Buffer);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha(Buffer.concat([SHA1, level[i], level[i + 1]])));
        if (i === idx) proof.push({ position: "right", hash: level[i + 1].toString("hex") });
        else if (i + 1 === idx) proof.push({ position: "left", hash: level[i].toString("hex") });
      } else {
        next.push(level[i]); // promoted; no sibling to record
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Fold a leaf hash + inclusion proof back to a root and compare. */
export function verifyInclusion(leafHashHex: string, proof: ProofStep[], rootHex: string): boolean {
  let h: Buffer = Buffer.from(leafHashHex, "hex") as Buffer;
  for (const step of proof) {
    const sib = Buffer.from(step.hash, "hex");
    h = step.position === "left" ? sha(Buffer.concat([SHA1, sib, h])) : sha(Buffer.concat([SHA1, h, sib]));
  }
  return h.toString("hex") === rootHex;
}

/** SHA-256(0x00 || utf8(s)) as lowercase hex — the leaf hash for a canonical record JSON. */
export function leafHash(canonicalJson: string): string {
  return sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonicalJson, "utf8")])).toString("hex");
}
