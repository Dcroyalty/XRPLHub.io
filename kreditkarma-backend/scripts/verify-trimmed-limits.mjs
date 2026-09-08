// scripts/verify-trimmed-limits.mjs
// Item 2 verification: does trimming account_lines 400->100 and account_tx
// 400->200 change any real wallet's XRPLScore?
//
// For each wallet: fetch the shared calls once, then account_lines at {400,100}
// and account_tx at {400,200}, run the EXACT v1.1 formula both ways, print the
// delta. A non-zero delta means we're trading accuracy for cost.
//
//   node scripts/verify-trimmed-limits.mjs

const NODES = [
  "https://xrplcluster.com", "https://xrpl.ws", "https://xrpl.link",
  "https://s1.ripple.com:51234", "https://s2.ripple.com:51234",
];
const RIPPLE_EPOCH = 946_684_800;
let n = 0;
const rpc = async (method, params) => {
  for (let i = 0; i < NODES.length; i++) {
    const url = NODES[(n++ + i) % NODES.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(15000) });
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) continue;
      const j = await r.json();
      if (j?.result && !j.result.error) return j.result;
    } catch { /* next node */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

const clamp = (v) => Math.max(0, Math.min(100, v));
const W = { accountAge: .28, txActivity: .22, financialHealth: .22, tokenEngagement: .12, dexActivity: .08, ammActivity: .03, securityConfig: .03, nftActivity: .02 };

// The v1.1 formula, parameterised by page size only.
function scoreFrom({ info, lines, txs, offers, nfts, escrows, firstTx }, txPage) {
  const a = info.account_data;
  const balanceXRP = Number(a.Balance) / 1e6;
  const trust = lines.lines || [];
  const T = txs.transactions || [];
  const txListLen = T.length;
  const txCapped = txListLen >= txPage;
  const sequence = Number(a.Sequence) || 0;
  const txOf = (t) => t.tx ?? t.tx_json ?? {};
  const firstTxDate = firstTx?.date;
  const firstTxLedger = firstTx?.ledger_index ?? firstTx?.LedgerIndex;
  const nowSec = Math.floor(Date.now() / 1000);
  const accountAgeDays = typeof firstTxDate === "number" ? Math.max(0, Math.floor((nowSec - (firstTxDate + RIPPLE_EPOCH)) / 86400)) : 0;
  const dexTxCount = T.filter((t) => ["OfferCreate", "OfferCancel"].includes(txOf(t).TransactionType)).length;
  const ammTxCount = T.filter((t) => ["AMMDeposit", "AMMWithdraw", "AMMCreate", "AMMVote"].includes(txOf(t).TransactionType)).length;
  const nftTxCount = T.filter((t) => String(txOf(t).TransactionType || "").startsWith("NFToken")).length;
  const recvCount = T.filter((t) => { const x = txOf(t); return x.TransactionType === "Payment" && x.Destination === a.Account; }).length;
  const hasOffers = (offers.offers || []).length > 0;
  const nftCount = (nfts.account_nfts || []).length;
  const hasMultiSig = !!(a.SignerLists?.length) || !!(info.signer_lists?.length);
  const secPts = (hasMultiSig ? 40 : 0) + (a.RegularKey ? 20 : 0) + (a.Domain ? 20 : 0) + (a.EmailHash ? 10 : 0) + ((escrows.account_objects || []).length ? 10 : 0);
  const objectCount = Number(a.OwnerCount) || 0;
  const realReserve = 1 + 0.2 * objectCount;
  const spendableXRP = Math.max(0, balanceXRP - realReserve);
  const reserveBuffer = realReserve > 0 ? balanceXRP / realReserve : 0;
  const isModern = sequence > 30_000_000 && firstTxLedger != null && sequence > firstTxLedger;
  const sentEst = isModern ? Math.max(0, sequence - firstTxLedger) : sequence;
  const lifetimeTx = (txCapped ? Math.max(sentEst, txListLen, txPage) : Math.max(sentEst, txListLen)) + 0.35 * recvCount;
  const s = {
    accountAge: clamp(Math.sqrt(accountAgeDays / 1095) * 100),
    txActivity: clamp((Math.log10(lifetimeTx + 1) / Math.log10(8000)) * 100),
    financialHealth: clamp(0.40 * clamp((Math.log10(spendableXRP + 1) / Math.log10(2500)) * 100) + 0.60 * clamp(((reserveBuffer - 1) / 7) * 100)),
    tokenEngagement: clamp(Math.sqrt(trust.length / 8) * 100),
    dexActivity: clamp((hasOffers ? 20 : 0) + Math.min(80, Math.sqrt(dexTxCount / 25) * 80)),
    ammActivity: clamp(Math.sqrt(ammTxCount / 8) * 100),
    securityConfig: clamp(secPts),
    nftActivity: clamp((nftCount / 8) * 50 + (nftTxCount / 15) * 50),
  };
  const weighted = Object.entries(W).reduce((acc, [k, w]) => acc + (s[k] || 0) * w, 0);
  return { score: Math.round(300 + weighted * 5.5), trustLines: trust.length, txRows: txListLen, txCapped };
}

async function sampleAddresses() {
  const known = [
    "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", // Ripple RLUSD issuer
    "rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz", // Sologenic issuer
    "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", // GateHub
    "rcoef87SYMJ58NAFx7fNM5frVknmvHsvJ", // Coreum bridge (heavy)
    "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B", // Bitstamp USD issuer
    "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF", // XRPLHub treasury (low activity)
    "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb", // anchor wallet (low activity)
  ];
  const seen = new Set(known);
  // Pull active accounts from recent validated ledgers.
  for (let back = 0; back < 6 && seen.size < 20; back++) {
    const led = await rpc("ledger", { ledger_index: "validated", transactions: true, expand: true });
    const idx = led?.ledger?.ledger_index;
    if (!idx) break;
    for (const t of led.ledger.transactions || []) {
      const acct = (t.tx_json ?? t).Account;
      if (acct && !seen.has(acct)) { seen.add(acct); if (seen.size >= 20) break; }
    }
    if (back === 0) continue;
    await rpc("ledger", { ledger_index: idx - back * 3 }); // nudge to older ledgers
  }
  return [...seen].slice(0, 20);
}

const addrs = await sampleAddresses();
console.log(`Verifying ${addrs.length} wallets — score at (lines 400 / tx 400) vs (lines 100 / tx 200)\n`);
console.log("wallet".padEnd(36), "old", "new", "Δ", "  lines(400/100)", "tx(400/200)");
let maxDelta = 0, shifted = 0;
for (const addr of addrs) {
  const [info, offers, nfts, escrows, ftx, lines400, lines100, tx400, tx200] = await Promise.all([
    rpc("account_info", { account: addr, ledger_index: "validated", signer_lists: true }),
    rpc("account_offers", { account: addr }),
    rpc("account_nfts", { account: addr }),
    rpc("account_objects", { account: addr, type: "escrow" }),
    rpc("account_tx", { account: addr, limit: 1, forward: true, ledger_index_min: -1, ledger_index_max: -1 }),
    rpc("account_lines", { account: addr, limit: 400 }),
    rpc("account_lines", { account: addr, limit: 100 }),
    rpc("account_tx", { account: addr, limit: 400, ledger_index_min: -1, ledger_index_max: -1 }),
    rpc("account_tx", { account: addr, limit: 200, ledger_index_min: -1, ledger_index_max: -1 }),
  ]);
  if (!info?.account_data) { console.log(addr.padEnd(36), "(not found / unreadable)"); continue; }
  const firstTx = (ftx?.transactions?.[0]?.tx ?? ftx?.transactions?.[0]?.tx_json) || null;
  const base = { info, offers, nfts, escrows, firstTx };
  const oldS = scoreFrom({ ...base, lines: lines400, txs: tx400 }, 400);
  const newS = scoreFrom({ ...base, lines: lines100, txs: tx200 }, 200);
  const d = newS.score - oldS.score;
  if (d !== 0) shifted++;
  maxDelta = Math.max(maxDelta, Math.abs(d));
  console.log(
    addr.padEnd(36),
    String(oldS.score).padStart(3), String(newS.score).padStart(3), String(d).padStart(3),
    ` ${String(lines400?.lines?.length ?? "?").padStart(4)}/${String(lines100?.lines?.length ?? "?").padStart(4)}`,
    `  ${String(oldS.txRows).padStart(3)}/${String(newS.txRows).padStart(3)}${newS.txCapped ? " (capped)" : ""}`
  );
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\nwallets with a non-zero delta: ${shifted}/${addrs.length}   max |Δ|: ${maxDelta} points`);
console.log(maxDelta === 0
  ? "VERDICT: trimmed limits do not change any score. Safe to ship."
  : `VERDICT: trimming shifts up to ${maxDelta} points — this is an accuracy trade-off, decide explicitly.`);
