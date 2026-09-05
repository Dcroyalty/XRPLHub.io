"use client";
// app/checkout/UsdcBasePay.tsx
// Pay for a plan in USDC on Base — one flow for both a human with a browser
// wallet (this component) and an agent (same GET /api/checkout/usdc/{plan}
// endpoint, hit directly with an x402-aware HTTP client). No invoice, no
// polling: the buyer signs an EIP-3009 authorization for the exact plan price
// (gasless — no on-chain tx from the browser wallet itself), x402-fetch
// attaches it as X-PAYMENT, and the CDP facilitator verifies + settles it
// inside this one request. See src/lib/x402Base.ts for why.
//
// Deliberately separate from CheckoutFlow's XRP/RLUSD invoice/poll state
// machine — that path is untouched.

import { useState } from "react";
import { createWalletClient, custom, publicActions, type Address } from "viem";
import { base } from "viem/chains";
import { wrapFetchWithPayment, type Signer } from "x402-fetch";
import { getPlan, type PlanId } from "@/lib/plans";

type Status = "idle" | "connecting" | "paying" | "paid" | "error";

const BASE_CHAIN_HEX = "0x2105"; // 8453

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

async function ensureBaseChain(): Promise<void> {
  const eth = window.ethereum;
  if (!eth) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (err) {
    // 4902 = chain not added to the wallet yet
    const code = (err as { code?: number } | null)?.code;
    if (code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_CHAIN_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export default function UsdcBasePay({ plan }: { plan: PlanId }) {
  const [status, setStatus] = useState<Status>("idle");
  const [msg, setMsg] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);

  const planInfo = getPlan(plan);

  const payWithUsdc = async () => {
    setStatus("connecting");
    setMsg("");
    try {
      if (!window.ethereum) {
        setStatus("error");
        setMsg("No Base-compatible wallet found. Install MetaMask or Coinbase Wallet.");
        return;
      }
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const account = accounts?.[0];
      if (!account) {
        setStatus("error");
        setMsg("No wallet account was authorized.");
        return;
      }
      await ensureBaseChain();

      // x402-fetch's Signer type needs BOTH wallet and public actions on the
      // client (it reads chain data as well as signing) — .extend(publicActions)
      // is viem's standard way to combine them on one client.
      const walletClient = createWalletClient({
        account: account as Address,
        chain: base,
        transport: custom(window.ethereum),
      }).extend(publicActions);

      // Atomic USDC units (6 decimals) — must cover the exact plan price;
      // x402-fetch refuses to pay above this on its own.
      const maxValue = BigInt(Math.round(planInfo.priceRlusd * 1_000_000));
      // viem's combined wallet+public client is structurally an EvmSigner, but
      // viem's exact generic instantiation (chain literal type, RpcSchema
      // shape) doesn't unify with x402's Signer alias — verified functionally
      // correct against the documented pattern, cast past the generic gap.
      const fetchWithPay = wrapFetchWithPayment(fetch, walletClient as unknown as Signer, maxValue);

      setStatus("paying");
      setMsg("Approve the payment in your wallet…");
      const res = await fetchWithPay(`/api/checkout/usdc/${plan}`, { method: "GET" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMsg(data?.error ?? "Payment failed.");
        return;
      }
      setApiKey(data.key ?? null);
      setStatus("paid");
    } catch (e) {
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Could not complete the USDC payment.");
    }
  };

  if (status === "paid") {
    return (
      <div>
        <p style={s.p}>Payment confirmed on Base. Your API key:</p>
        {apiKey ? (
          <>
            <pre style={s.key}>{apiKey}</pre>
            <p style={s.warn}>Store it now — it cannot be shown again.</p>
          </>
        ) : (
          <p style={s.p}>Your key was already issued for this purchase.</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={s.amountBox}>
        <div style={s.amountBig}>${planInfo.priceRlusd} USDC</div>
        <div style={s.amountSub}>on Base · {planInfo.name} plan</div>
      </div>

      <button onClick={payWithUsdc} disabled={status === "connecting" || status === "paying"} style={s.pay}>
        {status === "connecting" && "Connecting wallet…"}
        {status === "paying" && "Approve in wallet…"}
        {(status === "idle" || status === "error") && "Pay with USDC (Base)"}
      </button>

      {status === "error" && (
        <>
          <p style={s.warn}>{msg}</p>
          <button onClick={payWithUsdc} style={s.retry}>Try again</button>
        </>
      )}
      {status === "paying" && <p style={s.polling}>{msg}</p>}

      <p style={s.hint}>Requires a Base-compatible browser wallet (MetaMask, Coinbase Wallet). One signature — no separate on-chain transaction from your wallet.</p>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  p: { color: "#444", lineHeight: 1.5 },
  amountBox: { textAlign: "center", padding: "6px 0 16px" },
  amountBig: { fontSize: 30, fontWeight: 800 },
  amountSub: { fontSize: 12, color: "#888", marginTop: 4 },
  pay: { display: "block", width: "100%", textAlign: "center", padding: "14px 16px", borderRadius: 12, background: "#0052ff", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer", fontSize: 15, fontFamily: "inherit" },
  retry: { display: "block", width: "100%", textAlign: "center", padding: "10px 16px", borderRadius: 10, background: "#fff", color: "#111", border: "1px solid #111", fontWeight: 700, cursor: "pointer", marginTop: 8, fontFamily: "inherit" },
  warn: { color: "#8a6d00", background: "#fff7d6", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginTop: 12 },
  polling: { textAlign: "center", color: "#888", marginTop: 16, fontSize: 14 },
  hint: { fontSize: 12, color: "#999", marginTop: 14, lineHeight: 1.5 },
  key: { background: "#111", color: "#0f0", padding: 16, borderRadius: 10, wordBreak: "break-all", whiteSpace: "pre-wrap", fontSize: 14 },
};
