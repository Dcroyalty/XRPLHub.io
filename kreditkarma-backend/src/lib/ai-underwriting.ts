// src/lib/ai-underwriting.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI Underwriting Engine
// Uses Claude to evaluate grant legitimacy + rule-based hard guards
// Returns a 0–100 legitimacy score, risk flags, approved amount
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import type { ScoreBreakdown } from "./ledger-score";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface GrantApplication {
  walletAddress: string;
  category: string;
  amountRequested: number;   // USD equivalent
  currency: string;          // RLUSD or XRP
  description: string;
  urgency: string;
  ledgerScore?: ScoreBreakdown;
  accountAgeYears?: number;
  balanceXRP?: number;
  txCount?: number;
}

export interface UnderwritingResult {
  aiScore: number;           // 0–100 legitimacy
  approvedAmount: number;    // may be reduced from requested
  decision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW";
  reasoning: string;
  riskFlags: string[];
  processingTimeMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard rules (run BEFORE AI — instant rejection)
// ─────────────────────────────────────────────────────────────────────────────

function runHardRules(app: GrantApplication): { rejected: boolean; reason: string; flags: string[] } {
  const flags: string[] = [];

  // Amount limits
  const maxAmount = Number(process.env.GRANT_MAX_AMOUNT_RLUSD ?? 100);
  if (app.amountRequested > maxAmount * 2) {
    return {
      rejected: true,
      reason: `Requested amount ($${app.amountRequested}) exceeds maximum grant size ($${maxAmount})`,
      flags: ["AMOUNT_EXCEEDS_MAX"],
    };
  }

  // New account guard (< 30 days)
  if (app.accountAgeYears != null && app.accountAgeYears < 30 / 365) {
    flags.push("NEW_ACCOUNT");
  }

  // Zero transaction history
  if (app.txCount === 0) {
    flags.push("NO_TX_HISTORY");
  }

  // Very low balance (likely spam wallet)
  if (app.balanceXRP != null && app.balanceXRP < 1) {
    flags.push("BELOW_RESERVE");
  }

  // If score exists, very low score is a flag
  if (app.ledgerScore && app.ledgerScore.total < 400) {
    flags.push("LOW_LEDGER_SCORE");
  }

  // Description quality check
  if (app.description.trim().length < 20) {
    return {
      rejected: true,
      reason: "Description too short — please explain your situation in more detail",
      flags: ["INSUFFICIENT_DESCRIPTION"],
    };
  }

  // Spam / nonsense detection (basic)
  const spamPatterns = [/test/i, /asdf/i, /lorem ipsum/i, /aaaa/i, /xxxx/i];
  if (spamPatterns.some((p) => p.test(app.description))) {
    return {
      rejected: true,
      reason: "Application appears to be a test submission",
      flags: ["SPAM_DETECTED"],
    };
  }

  return { rejected: false, reason: "", flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Evaluation
// ─────────────────────────────────────────────────────────────────────────────

async function runAIEvaluation(
  app: GrantApplication,
  hardRuleFlags: string[]
): Promise<{ aiScore: number; reasoning: string; suggestedAmount: number; additionalFlags: string[] }> {
  const scoreContext = app.ledgerScore
    ? `XRPLScore: ${app.ledgerScore.total}/850 (${app.ledgerScore.tier})
Positives: ${app.ledgerScore.positives.slice(0, 3).join("; ")}
Concerns: ${app.ledgerScore.negatives.slice(0, 3).join("; ")}`
    : "XRPLScore: Not available";

  const prompt = `You are an AI underwriter for XRPLHub, a community mutual-aid fund on the XRP Ledger that helps people in genuine financial hardship with small emergency grants ($25 to $100, or the equivalent in XRP).

Review this grant application and provide a legitimacy assessment:

APPLICATION:
- Category: ${app.category}
- Amount Requested: $${app.amountRequested} ${app.currency}
- Urgency: ${app.urgency}
- Description: "${app.description}"

APPLICANT PROFILE:
- Wallet: ${app.walletAddress.slice(0, 8)}...
- Account Age: ${app.accountAgeYears != null ? (app.accountAgeYears * 365).toFixed(0) + " days" : "Unknown"}
- Total Transactions: ${app.txCount ?? "Unknown"}
- XRP Balance: ${app.balanceXRP?.toFixed(2) ?? "Unknown"} XRP
- ${scoreContext}
- Pre-screening flags: ${hardRuleFlags.length ? hardRuleFlags.join(", ") : "None"}

Evaluate this application on:
1. LEGITIMACY (is this a real hardship situation, not fraud/gaming?)
2. NEED (does the description match the category and amount?)
3. PROPORTIONALITY (is the amount appropriate for the stated need?)
4. RISK (any red flags suggesting abuse or misuse?)

Respond ONLY with a JSON object, no markdown:
{
  "legitimacyScore": <0-100, where 100 = definitely legitimate hardship>,
  "suggestedApprovalAmount": <dollar amount to approve, 0 if reject, may be less than requested>,
  "reasoning": "<2-3 sentence clear explanation of your decision>",
  "additionalFlags": ["FLAG_1", "FLAG_2"],
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

Be compassionate but rigorous. If the description seems genuine and the amount is reasonable, lean toward approval. Only reject for clear red flags (fraud indicators, ineligible use, gaming the system).`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as any).text)
    .join("");

  // Parse JSON, strip any accidental markdown fences
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  return {
    aiScore: Math.min(100, Math.max(0, Number(parsed.legitimacyScore ?? 50))),
    reasoning: parsed.reasoning ?? "No reasoning provided",
    suggestedAmount: Number(parsed.suggestedApprovalAmount ?? 0),
    additionalFlags: Array.isArray(parsed.additionalFlags) ? parsed.additionalFlags : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main underwriting function
// ─────────────────────────────────────────────────────────────────────────────

export async function underwriteGrant(app: GrantApplication): Promise<UnderwritingResult> {
  const start = Date.now();

  // 1. Hard rules first (synchronous, fast)
  const hardResult = runHardRules(app);

  if (hardResult.rejected) {
    return {
      aiScore: 0,
      approvedAmount: 0,
      decision: "REJECTED",
      reasoning: hardResult.reason,
      riskFlags: hardResult.flags,
      processingTimeMs: Date.now() - start,
    };
  }

  // 2. AI evaluation
  let aiResult;
  try {
    aiResult = await runAIEvaluation(app, hardResult.flags);
  } catch (err) {
    console.error("[Underwriting] AI evaluation failed, using fallback:", err);
    // Fallback to rules-only scoring if AI is unavailable
    aiResult = {
      aiScore: hardResult.flags.length === 0 ? 70 : 40,
      reasoning: "Evaluated using automated rules (AI temporarily unavailable)",
      suggestedAmount: hardResult.flags.length === 0 ? app.amountRequested : app.amountRequested * 0.5,
      additionalFlags: ["AI_FALLBACK"],
    };
  }

  // 3. Final decision logic
  const allFlags = [...hardResult.flags, ...aiResult.additionalFlags];
  const maxAmount = Number(process.env.GRANT_MAX_AMOUNT_RLUSD ?? 100);

  // Clamp approved amount
  const approvedAmount = Math.min(
    aiResult.suggestedAmount,
    app.amountRequested,
    maxAmount
  );

  let decision: UnderwritingResult["decision"];

  if (aiResult.aiScore >= 65 && approvedAmount > 0 && allFlags.filter(f => f !== "NEW_ACCOUNT").length === 0) {
    decision = "APPROVED";
  } else if (aiResult.aiScore < 35 || approvedAmount === 0) {
    decision = "REJECTED";
  } else {
    // 35–64 score, or has non-critical flags → manual review queue
    decision = "MANUAL_REVIEW";
  }

  // XRPLScore modifier: high score can bump borderline approvals
  if (decision === "MANUAL_REVIEW" && app.ledgerScore && app.ledgerScore.total >= 700) {
    decision = "APPROVED";
  }

  return {
    aiScore: aiResult.aiScore,
    approvedAmount: decision === "REJECTED" ? 0 : approvedAmount,
    decision,
    reasoning: aiResult.reasoning,
    riskFlags: allFlags,
    processingTimeMs: Date.now() - start,
  };
}
