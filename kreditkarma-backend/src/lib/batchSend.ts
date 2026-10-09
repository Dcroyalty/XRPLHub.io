// src/lib/batchSend.ts
// BATCH SEND (2026-10-09) — "send XRP or RLUSD to up to 8 people with one approval: all of them get paid, or none do."
// One single-account Batch (XLS-56, BatchV1_1 + fixBatchV1_2, enabled on mainnet ~2026-10-09) in tfAllOrNothing mode,
// with one Payment per recipient. docs/HUB-GAPS.md #2.
//
// Rules this rests on (xrpl.org Batch Transactions; Devnet-tested by scripts/test-batch-send-devnet.ts):
//   - Up to 8 inner transactions. Inner: Flags tfInnerBatchTxn, Fee "0", SigningPubKey "", no TxnSignature.
//   - Single account: inner Sequences follow the outer one (outer N, inner N+1…N+k), so the sender must not send any other
//     transaction between building and signing (the request goes stale and fails tefPAST_SEQ — nothing is paid).
//   - Outer Fee = (2 + k) × the current open-ledger fee (what xrpl.js autofill computes).
//   - tfAllOrNothing: if any payment would fail, none is applied.
//
// Before building, every recipient is preflighted (exists or will be created, destination tag, Deposit Authorization,
// RLUSD trust line) and the sender's balance is checked, so a doomed batch is refused with a plain reason instead.
// FREE. XRPLHub never signs. No local imports: the Devnet test runs this exact file.

export type Rpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export interface RlusdRef { issuer: string; hex: string }
export type Currency = "XRP" | "RLUSD";
export interface Recipient { address: string; amount: string; currency: Currency; destinationTag?: number | null; label?: string }
export interface Problem { index: number; address: string; error: string }

export const BATCH_SEND_MAX = 8;
const TF_ALL_OR_NOTHING = 0x00010000;
const TF_INNER_BATCH_TXN = 0x40000000;
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DEPOSIT_AUTH = 0x01000000;
const ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function amountFor(r: Recipient, rlusd: RlusdRef): string | Record<string, string> {
  if (!/^\d+(\.\d+)?$/.test(r.amount) || Number(r.amount) <= 0) throw new Error("amount must be a positive number like 10 or 2.5");
  if (r.currency === "XRP") {
    const [w, f = ""] = r.amount.split(".");
    if (f.length > 6) throw new Error("XRP has at most 6 decimal places");
    return (BigInt(w) * BigInt(1_000_000) + BigInt((f + "000000").slice(0, 6))).toString();
  }
  if (r.amount.replace(".", "").replace(/^0+/, "").length > 15) throw new Error("RLUSD amounts have at most 15 significant digits");
  return { currency: rlusd.hex, issuer: rlusd.issuer, value: r.amount };
}

/** Shape checks only (no ledger). Returns the cleaned list or problems. */
export function validateRecipients(sender: string, raw: unknown): { ok: true; recipients: Recipient[] } | { ok: false; problems: Problem[]; error?: string } {
  if (!ADDRESS_RE.test(sender)) return { ok: false, problems: [], error: "Your wallet address isn't valid (it starts with r)." };
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < 2) return { ok: false, problems: [], error: "Add at least 2 people (for one person, just send a normal payment)." };
  if (list.length > BATCH_SEND_MAX) return { ok: false, problems: [], error: `One approval can pay at most ${BATCH_SEND_MAX} people.` };
  const problems: Problem[] = [];
  const out: Recipient[] = [];
  list.forEach((x, i) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const address = String(r.address ?? "").trim();
    const currency = String(r.currency ?? "XRP").toUpperCase() as Currency;
    const amount = String(r.amount ?? "").trim();
    const tag = r.destinationTag == null || r.destinationTag === "" ? null : Number(r.destinationTag);
    if (!ADDRESS_RE.test(address)) problems.push({ index: i, address, error: "not a valid XRP wallet address" });
    else if (address === sender) problems.push({ index: i, address, error: "that's your own wallet" });
    else if (currency !== "XRP" && currency !== "RLUSD") problems.push({ index: i, address, error: "currency must be XRP or RLUSD" });
    else if (tag !== null && (!Number.isInteger(tag) || tag < 0 || tag > 4_294_967_295)) problems.push({ index: i, address, error: "destination tag must be a whole number" });
    else {
      try { amountFor({ address, amount, currency }, { issuer: "r", hex: "0".repeat(40) }); out.push({ address, amount, currency, destinationTag: tag, label: r.label ? String(r.label).slice(0, 40) : undefined }); }
      catch (e) { problems.push({ index: i, address, error: e instanceof Error ? e.message : "bad amount" }); }
    }
  });
  return problems.length ? { ok: false, problems } : { ok: true, recipients: out };
}

/** Ledger preflight: would each payment land, and can the sender cover the total + fee? */
export async function preflightBatch(rpc: Rpc, sender: string, recipients: Recipient[], rlusd: RlusdRef) {
  const [snd, state, fee] = await Promise.all([
    rpc("account_info", { account: sender, ledger_index: "validated" }),
    rpc("server_state", {}),
    rpc("fee", {}),
  ]);
  if (!snd || !state) throw new Error("could not read the XRP Ledger");
  if (snd.error === "actNotFound") return { ok: false as const, problems: [] as Problem[], error: "Your wallet doesn't exist on the XRP Ledger yet." };
  const vl = (state.state as { validated_ledger?: { reserve_base?: number; reserve_inc?: number; base_fee?: number } })?.validated_ledger;
  const reserveBase = (vl?.reserve_base ?? 1_000_000), reserveInc = (vl?.reserve_inc ?? 200_000);
  const openFee = Number((fee?.drops as { open_ledger_fee?: string } | undefined)?.open_ledger_fee ?? vl?.base_fee ?? 10);
  const unit = Math.max(Number(vl?.base_fee ?? 10), openFee);
  const feeDrops = unit * (2 + recipients.length);
  const sd = snd.account_data as { Balance?: string; OwnerCount?: number; Sequence?: number };
  const spendableDrops = Number(sd.Balance ?? 0) - (reserveBase + reserveInc * Number(sd.OwnerCount ?? 0));

  const problems: Problem[] = [];
  let xrpDrops = 0, rlusdTotal = 0;
  for (const [i, r] of recipients.entries()) {
    const a = await rpc("account_info", { account: r.address, ledger_index: "validated" });
    if (!a) throw new Error("could not read the XRP Ledger");
    if (a.error === "actNotFound") {
      if (r.currency !== "XRP") { problems.push({ index: i, address: r.address, error: "this wallet doesn't exist yet, so it can't receive RLUSD" }); continue; }
      if (Number(amountFor(r, rlusd)) < reserveBase) { problems.push({ index: i, address: r.address, error: `this wallet doesn't exist yet; the first payment to it must be at least ${reserveBase / 1e6} XRP` }); continue; }
    } else {
      const flags = Number((a.account_data as { Flags?: number })?.Flags ?? 0);
      if (flags & LSF_REQUIRE_DEST_TAG && r.destinationTag == null) { problems.push({ index: i, address: r.address, error: "this wallet needs a destination tag (ask them for it)" }); continue; }
      if (flags & LSF_DEPOSIT_AUTH) { problems.push({ index: i, address: r.address, error: "this wallet only accepts payments from accounts it approved" }); continue; }
      if (r.currency === "RLUSD") {
        const l = await rpc("account_lines", { account: r.address, peer: rlusd.issuer, ledger_index: "validated" });
        const line = ((l?.lines as { currency?: string; limit?: string; freeze?: boolean; freeze_peer?: boolean }[]) ?? []).find((x) => String(x.currency).toUpperCase() === rlusd.hex);
        if (!line || Number(line.limit) <= 0) { problems.push({ index: i, address: r.address, error: "this wallet can't receive RLUSD yet (it hasn't added RLUSD)" }); continue; }
        if (line.freeze || line.freeze_peer) { problems.push({ index: i, address: r.address, error: "RLUSD is frozen for this wallet" }); continue; }
      }
    }
    if (r.currency === "XRP") xrpDrops += Number(amountFor(r, rlusd)); else rlusdTotal += Number(r.amount);
  }
  if (xrpDrops + feeDrops > spendableDrops) problems.push({ index: -1, address: sender, error: `your wallet has ${Math.max(0, spendableDrops) / 1e6} XRP free; this needs ${(xrpDrops + feeDrops) / 1e6} XRP (payments + network fee)` });
  if (rlusdTotal > 0) {
    const l = await rpc("account_lines", { account: sender, peer: rlusd.issuer, ledger_index: "validated" });
    const bal = Number((((l?.lines as { currency?: string; balance?: string }[]) ?? []).find((x) => String(x.currency).toUpperCase() === rlusd.hex))?.balance ?? 0);
    if (bal + 1e-9 < rlusdTotal) problems.push({ index: -1, address: sender, error: `your wallet holds ${bal} RLUSD; this needs ${rlusdTotal}` });
  }
  return { ok: problems.length === 0, problems, sequence: Number(sd.Sequence ?? 0), feeDrops, totals: { xrp: xrpDrops / 1e6, rlusd: rlusdTotal } } as const;
}

/** The unsigned all-or-nothing Batch: one Payment per recipient. `sequence` = the sender's current account Sequence. */
export function buildBatchSend(sender: string, recipients: Recipient[], sequence: number, feeDrops: number, rlusd: RlusdRef): Record<string, unknown> {
  if (recipients.length < 1 || recipients.length > BATCH_SEND_MAX) throw new Error(`a batch holds 1–${BATCH_SEND_MAX} payments`);
  return {
    TransactionType: "Batch",
    Account: sender,
    Flags: TF_ALL_OR_NOTHING,
    Sequence: sequence,
    Fee: String(feeDrops),
    RawTransactions: recipients.map((r, k) => ({
      RawTransaction: {
        TransactionType: "Payment",
        Account: sender,
        Destination: r.address,
        ...(r.destinationTag != null ? { DestinationTag: r.destinationTag } : {}),
        Amount: amountFor(r, rlusd),
        Flags: TF_INNER_BATCH_TXN,
        Fee: "0",
        SigningPubKey: "",
        Sequence: sequence + 1 + k,
      },
    })),
  };
}
