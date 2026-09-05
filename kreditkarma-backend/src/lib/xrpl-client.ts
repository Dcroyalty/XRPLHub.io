// src/lib/xrpl-client.ts
// Singleton XRPL client with auto-reconnect.
//
// MAINNET GUARD: this client backs treasury.ts (real fund transfers,
// multi-sig) as well as the public account-lookup route, so every connection
// is checked against mainnet's network_id (0) via BOTH client.networkID and
// server_info before it's handed to a caller — same dual-check pattern as
// src/lib/credentials.ts's connectMainnetOrThrow. A mismatch throws and the
// bad client is torn down rather than cached, so a misconfigured
// XRPL_NODE_URL fails loud on the very next call instead of silently serving
// (or signing against) the wrong ledger. This exists because XRPL_NODE_URL
// was found pointed at testnet in production — see the .env comment.

import { Client, AccountInfoRequest, AccountTxRequest } from "xrpl";

const MAINNET_NETWORK_ID = 0;
const DEFAULT_MAINNET_URL = "wss://xrplcluster.com";

export class WrongXrplNetworkError extends Error {}

let client: Client | null = null;
let connectingPromise: Promise<Client> | null = null;

export async function getXrplClient(): Promise<Client> {
  if (client?.isConnected()) return client;

  // Prevent multiple simultaneous connection attempts
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const nodeUrl = process.env.XRPL_NODE_URL ?? DEFAULT_MAINNET_URL;
    const candidate = new Client(nodeUrl);

    try {
      await candidate.connect();

      // Guard 1: the network id xrpl.js negotiated on connect.
      if (candidate.networkID !== undefined && candidate.networkID !== MAINNET_NETWORK_ID) {
        throw new WrongXrplNetworkError(
          `REFUSING: ${nodeUrl} client.networkID=${String(candidate.networkID)}, expected mainnet (0). ` +
            `Check XRPL_NODE_URL.`
        );
      }
      // Guard 2: independently re-check via server_info. Fail closed if absent.
      const info = await candidate.request({ command: "server_info" });
      const netId = (info.result as { info?: { network_id?: number } }).info?.network_id;
      if (netId !== MAINNET_NETWORK_ID) {
        throw new WrongXrplNetworkError(
          `REFUSING: ${nodeUrl} server_info network_id=${String(netId)}, expected mainnet (0). ` +
            `Check XRPL_NODE_URL. No request was served from this connection.`
        );
      }
    } catch (err) {
      await candidate.disconnect().catch(() => {});
      connectingPromise = null;
      throw err; // never cache or hand back a non-mainnet (or otherwise broken) client
    }

    client = candidate;
    client.on("disconnected", () => {
      console.warn("[XRPL] Disconnected from node — will reconnect on next request");
      client = null;
      connectingPromise = null;
    });

    console.log(`[XRPL] Connected to ${nodeUrl} (mainnet, network_id 0 confirmed)`);
    connectingPromise = null;
    return client;
  })();

  return connectingPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed data shapes returned by our fetchers
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountSnapshot {
  address: string;
  balance: string;           // drops
  balanceXRP: number;
  sequence: number;
  ownerCount: number;
  accountFlags: number;
  firstLedger?: number;      // earliest tx ledger
  txCount: number;
  ammPositions: AMMPosition[];
  trustLines: TrustLine[];
  offerCount: number;
  paymentCount: number;
  receivedPayments: number;
  uniqueCounterparties: number;
  regularKeySet: boolean;
  signerListSet: boolean;
  accountAge?: number;       // seconds since first tx on-chain
  recentVolume30d: number;   // XRP equivalent volume, 30 days
}

export interface AMMPosition {
  ammAccount: string;
  asset1: string;
  asset2: string;
  lpBalance: string;
}

export interface TrustLine {
  account: string;
  currency: string;
  balance: string;
  limit: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Info
// ─────────────────────────────────────────────────────────────────────────────

export async function getAccountInfo(address: string) {
  const xrpl = await getXrplClient();

  const req: AccountInfoRequest = {
    command: "account_info",
    account: address,
    ledger_index: "validated",
  };

  const res = await xrpl.request(req);
  return res.result.account_data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction History (paginated, up to 400 tx)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAccountTransactions(
  address: string,
  limit = 400
): Promise<any[]> {
  const xrpl = await getXrplClient();
  const txs: any[] = [];
  let marker: unknown = undefined;

  do {
    const req: AccountTxRequest = {
      command: "account_tx",
      account: address,
      limit: Math.min(limit - txs.length, 200),
      ledger_index_min: -1,
      ledger_index_max: -1,
      ...(marker ? { marker } : {}),
    };

    const res = await xrpl.request(req);
    txs.push(...res.result.transactions);
    marker = res.result.marker;

    if (txs.length >= limit) break;
  } while (marker);

  return txs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust Lines
// ─────────────────────────────────────────────────────────────────────────────

export async function getAccountTrustLines(address: string): Promise<TrustLine[]> {
  const xrpl = await getXrplClient();

  const res = await xrpl.request({
    command: "account_lines",
    account: address,
    ledger_index: "validated",
  });

  return (res.result.lines as any[]).map((l) => ({
    account: l.account,
    currency: l.currency,
    balance: l.balance,
    limit: l.limit,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// AMM Positions for an account
// ─────────────────────────────────────────────────────────────────────────────

export async function getAMMPositions(address: string): Promise<AMMPosition[]> {
  const xrpl = await getXrplClient();
  const positions: AMMPosition[] = [];

  try {
    // Fetch account_objects and look for AMMBid / LP token trust lines
    const res = await xrpl.request({
      command: "account_objects",
      account: address,
      type: "amm",
      ledger_index: "validated",
    } as any);

    for (const obj of (res.result.account_objects ?? []) as any[]) {
      if (obj.LedgerEntryType === "AMM") {
        positions.push({
          ammAccount: obj.Account ?? "",
          asset1: typeof obj.Asset === "string" ? obj.Asset : obj.Asset?.currency ?? "XRP",
          asset2: typeof obj.Asset2 === "string" ? obj.Asset2 : obj.Asset2?.currency ?? "XRP",
          lpBalance: obj.LPTokenBalance?.value ?? "0",
        });
      }
    }
  } catch {
    // AMM lookup may fail on older accounts — safe to ignore
  }

  return positions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Account Snapshot (combines all above)
// ─────────────────────────────────────────────────────────────────────────────

export async function buildAccountSnapshot(address: string): Promise<AccountSnapshot> {
  const [accountData, txs, trustLines, ammPositions] = await Promise.all([
    getAccountInfo(address),
    getAccountTransactions(address, 400),
    getAccountTrustLines(address),
    getAMMPositions(address),
  ]);

  // ── Compute derived metrics ──────────────────────────────────────────────
  const balanceDrops = accountData.Balance as string;
  const balanceXRP = Number(balanceDrops) / 1_000_000;

  // Earliest ledger sequence (proxy for account age)
  const ledgerIndexes = txs
    .map((t) => t.tx?.ledger_index ?? t.tx_json?.ledger_index)
    .filter(Boolean)
    .map(Number);
  const firstLedger = ledgerIndexes.length ? Math.min(...ledgerIndexes) : undefined;

  // Transaction type breakdown
  let paymentCount = 0;
  let receivedPayments = 0;
  let offerCount = 0;
  const counterparties = new Set<string>();
  let recentVolume30d = 0;

  // Approximate 30d cutoff: ~10 ledgers/min × 60 × 24 × 30
  const LEDGERS_30D = 432_000;
  const currentLedger = (await getXrplClient().then((c) =>
    c.request({ command: "ledger", ledger_index: "validated" })
  )) as any;
  const currentLedgerIdx: number = currentLedger.result.ledger_index;
  const cutoff30d = currentLedgerIdx - LEDGERS_30D;

  for (const tx of txs) {
    const t = tx.tx ?? tx.tx_json ?? {};
    const type: string = t.TransactionType ?? "";
    const ledgerIdx: number = t.ledger_index ?? t.LedgerIndex ?? 0;

    if (type === "Payment") {
      if (t.Account === address) {
        paymentCount++;
        if (t.Destination) counterparties.add(t.Destination as string);
        if (ledgerIdx >= cutoff30d && typeof t.Amount === "string") {
          recentVolume30d += Number(t.Amount) / 1_000_000;
        }
      } else if (t.Destination === address) {
        receivedPayments++;
        if (t.Account) counterparties.add(t.Account as string);
      }
    } else if (type === "OfferCreate" || type === "OfferDelete") {
      offerCount++;
    }
  }

  // Account age estimate: ~4 seconds per ledger
  const accountAge = firstLedger
    ? (currentLedgerIdx - firstLedger) * 4
    : undefined;

  return {
    address,
    balance: balanceDrops,
    balanceXRP,
    sequence: accountData.Sequence as number,
    ownerCount: accountData.OwnerCount as number,
    accountFlags: accountData.Flags as number,
    firstLedger,
    txCount: txs.length,
    ammPositions,
    trustLines,
    offerCount,
    paymentCount,
    receivedPayments,
    uniqueCounterparties: counterparties.size,
    regularKeySet: !!(accountData.RegularKey),
    signerListSet: !!(accountData.signer_lists?.length),
    accountAge,
    recentVolume30d,
  };
}
