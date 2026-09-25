import assert from "node:assert/strict";
import { test } from "node:test";
import { isMptIssuanceId, isValidXrplAddress, scanAddresses, scanMptIds } from "../src/address.ts";

const VALID = [
  "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF", // XRPLHub treasury
  "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", // genesis account
  "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", // RLUSD issuer
  "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb", // XRPLHub anchor wallet
];

test("real mainnet addresses verify", () => {
  for (const a of VALID) assert.equal(isValidXrplAddress(a), true, a);
});

test("a single mistyped character fails the checksum", () => {
  for (const a of VALID) {
    const last = a.slice(-1);
    const swapped = a.slice(0, -1) + (last === "x" ? "y" : "x");
    assert.equal(isValidXrplAddress(swapped), false, swapped);
  }
  assert.equal(isValidXrplAddress("rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLX"), false);
});

test("wrong shapes are rejected", () => {
  for (const bad of ["", "r", "notanaddress", "0x0000000000000000000000000000000000000000", "xs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF", "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF0"]) {
    assert.equal(isValidXrplAddress(bad), false, bad);
  }
});

test("scanAddresses separates valid from mistyped and dedupes", () => {
  const t = `check ${VALID[0]} and again ${VALID[0]} plus typo rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLX please`;
  const s = scanAddresses(t);
  assert.deepEqual(s.valid, [VALID[0]]);
  assert.deepEqual(s.malformed, ["rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLX"]);
});

test("scanAddresses ignores address-shaped runs inside longer tokens", () => {
  const hash = "A".repeat(10) + "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF" + "B".repeat(10);
  assert.deepEqual(scanAddresses(hash), { valid: [], malformed: [] });
});

test("MPT ids: exactly 48 hex chars, standalone", () => {
  const id = "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045";
  assert.equal(isMptIssuanceId(id), true);
  assert.equal(isMptIssuanceId(id.toLowerCase()), true);
  assert.equal(isMptIssuanceId(id.slice(1)), false);
  assert.equal(isMptIssuanceId(id + "0"), false);
  assert.deepEqual(scanMptIds(`look at ${id.toLowerCase()} now`), [id]);
  assert.deepEqual(scanMptIds("ab" + id), []);
});
