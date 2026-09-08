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

import { Client, AccountInfoRequest } from "xrpl";

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

