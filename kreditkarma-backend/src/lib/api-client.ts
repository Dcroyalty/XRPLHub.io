// lib/api-client.ts
// ─────────────────────────────────────────────────────────────────────────────
// Drop this file into your existing Next.js frontend (xrplhub.io)
// Set NEXT_PUBLIC_API_URL in your frontend .env to point to the backend
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error ?? `API error ${res.status}`);
  }

  return res.json();
}

// ─── LedgerScore ─────────────────────────────────────────────────────────────

export interface LedgerScoreResponse {
  cached: boolean;
  address: string;
  score: number;
  tier: "POOR" | "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";
  breakdown: Record<string, { raw: number; weighted: number; label: string; notes: string[] }>;
  positives: string[];
  negatives: string[];
  tips: string[];
  accountSnapshot: {
    balanceXRP: number;
    txCount: number;
    ammPositions: number;
    trustLines: number;
    accountAge?: number;
  };
  calculatedAt: string;
}

export async function getLedgerScore(address: string): Promise<LedgerScoreResponse> {
  return apiFetch(`/api/score/${address}`);
}

// ─── Account Info ─────────────────────────────────────────────────────────────

export interface AccountInfoResponse {
  address: string;
  balance: { xrp: number; rlusd: number; hasRlusdTrustLine: boolean };
  account: { sequence: number; ownerCount: number; flags: number };
}

export async function getAccountInfo(address: string): Promise<AccountInfoResponse> {
  return apiFetch(`/api/account/${address}`);
}

// ─── Grants ──────────────────────────────────────────────────────────────────

export interface GrantSubmission {
  walletAddress: string;
  category: "RENT" | "UTILITIES" | "GROCERIES" | "MEDICAL" | "TRANSPORTATION" | "OTHER";
  amountRequested: number;
  currency: "RLUSD" | "XRP";
  description: string;
  urgency: "LOW" | "MEDIUM" | "HIGH" | "EMERGENCY";
}

export interface GrantSubmissionResponse {
  grantId: string;
  status: "PAID" | "APPROVED_QUEUED" | "UNDER_REVIEW" | "REJECTED" | "PAYOUT_FAILED";
  message: string;
  approvedAmount?: number;
  currency?: string;
  txHash?: string;
  aiScore?: number;
  reasoning?: string;
  processingTimeMs?: number;
}

export async function submitGrant(data: GrantSubmission): Promise<GrantSubmissionResponse> {
  return apiFetch("/api/grants/submit", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getGrantStatus(grantId: string) {
  return apiFetch(`/api/grants/${grantId}`);
}

// ─── Donations ───────────────────────────────────────────────────────────────

export async function getTreasuryAddress(): Promise<{ treasuryAddress: string; network: string }> {
  return apiFetch("/api/donate");
}

export async function recordDonation(data: {
  fromAddress: string;
  txHash: string;
  amount: number;
  currency: "XRP" | "RLUSD";
  message?: string;
}) {
  return apiFetch("/api/donate", { method: "POST", body: JSON.stringify(data) });
}

// ─── Treasury Stats ───────────────────────────────────────────────────────────

export interface TreasuryStats {
  treasury: { xrp: number; rlusd: number };
  grantsIssued: number;
  totalDistributed: number;
  totalDonations: number;
  donorCount: number;
}

export async function getTreasuryStats(): Promise<TreasuryStats> {
  return apiFetch("/api/treasury/stats");
}
