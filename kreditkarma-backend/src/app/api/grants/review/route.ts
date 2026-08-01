// src/app/api/grants/review/route.ts
// AI-ASSISTED TRIAGE (advisory only) — Grok (xAI) + Anthropic Claude.
// This NEVER auto-approves or auto-denies. It writes an advisory signal to
// aiScore/aiReasoning/riskFlags and sets status to REVIEWING for a human to decide.
// Keep it that way: automated denial of need-based aid invites disparate-impact
// and fair-lending-style exposure. The human decision is the decision.

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const XAI_API_KEY       = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const REVIEW_INSTRUCTIONS = `You are a grant reviewer for XRPLHub, a community mutual-aid fund that gives small emergency grants ($25-$100) directly to people in need, paid to their XRPL wallet. Review the application below for legitimacy and need. Watch for: obvious fraud or spam, duplicate/templated text, requests that don't match the stated category, or amounts that seem inconsistent with the described need. You are advisory only — a human gives final approval before any funds move.

FAIRNESS REQUIREMENTS (mandatory):
- Assess ONLY legitimacy of the request and consistency of the stated need.
- NEVER consider or infer race, ethnicity, national origin, religion, sex, gender identity, sexual orientation, age, disability, marital or familial status, immigration status, or receipt of public assistance. Do not use names, language style, spelling, grammar, or location as proxies for any of these.
- Do not penalize an applicant for poor writing, limited English, or an unusual-sounding name.
- If you lack sufficient basis to judge, return "REVIEW" rather than "REJECT".

Respond with STRICT JSON only, no markdown, no preamble:
{"recommendation":"APPROVE"|"REVIEW"|"REJECT","confidence":0-100,"summary":"one or two sentence rationale for the human approver","flags":["short risk flags, empty array if none"]}`;

interface AppInput { name?: string; wallet?: string; email?: string; category?: string; need?: string; amount?: string | number; }
interface Verdict { recommendation: string; confidence: number; summary: string; flags: string[]; source: string; }

function buildPrompt(app: AppInput): string {
  return `${REVIEW_INSTRUCTIONS}

APPLICATION:
- Name: ${app.name || 'Anonymous'}
- Category: ${app.category || 'n/a'}
- Amount requested: $${app.amount || 'n/a'}
- XRPL wallet: ${app.wallet || 'n/a'}
- Situation described: ${app.need || 'n/a'}`;
}

function safeParse(text: string): Partial<Verdict> | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function reviewWithGrok(app: AppInput): Promise<{ verdict: Partial<Verdict> | null; debug: string }> {
  if (!XAI_API_KEY) return { verdict: null, debug: 'XAI_API_KEY missing in env' };
  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_KEY}` },
      body: JSON.stringify({
        model: 'grok-4.3',
        temperature: 0.2,
        messages: [{ role: 'user', content: buildPrompt(app) }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { verdict: null, debug: `Grok HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const parsed = safeParse(text);
    if (!parsed) return { verdict: null, debug: `Grok response unparseable: ${text.slice(0, 200)}` };
    return { verdict: { ...parsed, source: 'grok' }, debug: 'grok ok' };
  } catch (e) {
    return { verdict: null, debug: `Grok exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function reviewWithAnthropic(app: AppInput): Promise<{ verdict: Partial<Verdict> | null; debug: string }> {
  if (!ANTHROPIC_API_KEY) return { verdict: null, debug: 'ANTHROPIC_API_KEY missing in env' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(app) }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { verdict: null, debug: `Anthropic HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = Array.isArray(data?.content)
      ? data.content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : '')).join('')
      : '';
    const parsed = safeParse(text);
    if (!parsed) return { verdict: null, debug: `Anthropic response unparseable: ${text.slice(0, 200)}` };
    return { verdict: { ...parsed, source: 'anthropic' }, debug: 'anthropic ok' };
  } catch (e) {
    return { verdict: null, debug: `Anthropic exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function combine(grok: Partial<Verdict> | null, claude: Partial<Verdict> | null): Verdict {
  const reviews = [grok, claude].filter(Boolean) as Partial<Verdict>[];
  if (reviews.length === 0) {
    return { recommendation: 'REVIEW', confidence: 0, summary: 'Our team is reviewing your application. Allow 24–48 hours.', flags: [], source: 'fallback' };
  }
  const rank: Record<string, number> = { REJECT: 3, REVIEW: 2, APPROVE: 1 };
  let worst = reviews[0];
  for (const r of reviews) {
    if ((rank[(r.recommendation || 'REVIEW').toUpperCase()] || 2) > (rank[(worst.recommendation || 'REVIEW').toUpperCase()] || 2)) worst = r;
  }
  const flags = Array.from(new Set(reviews.flatMap(r => r.flags || [])));
  const avgConf = Math.round(reviews.reduce((s, r) => s + (Number(r.confidence) || 0), 0) / reviews.length);
  const summaries = reviews.map(r => r.summary || '').filter(Boolean).join(' · ');
  return {
    recommendation: (worst.recommendation || 'REVIEW').toUpperCase(),
    confidence: avgConf,
    summary: summaries || 'Application received and is awaiting review.',
    flags,
    source: reviews.map(r => r.source).join('+'),
  };
}

export async function POST(req: Request) {
  const debugBag: string[] = [];
  try {
    const app: AppInput = await req.json().catch(() => ({}));

    const [grokResult, claudeResult] = await Promise.all([reviewWithGrok(app), reviewWithAnthropic(app)]);
    debugBag.push(grokResult.debug, claudeResult.debug);
    const verdict = combine(grokResult.verdict, claudeResult.verdict);

    // Attach verdict to most recent PENDING grant for this wallet
    if (app.wallet) {
      try {
        const latest = await prisma.grantRequest.findFirst({
          where: { walletAddress: String(app.wallet), status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
        });
        if (latest) {
          await prisma.grantRequest.update({
            where: { id: latest.id },
            data: {
              status:       'REVIEWING',
              aiScore:      verdict.confidence,          // live column
              aiReasoning:  `${verdict.recommendation}: ${verdict.summary}`,
              riskFlags:    verdict.flags.join(', ') || null,
            },
          });
          debugBag.push(`db update ok for ${latest.id}`);
        } else {
          debugBag.push('no PENDING grant found for wallet');
        }
      } catch (e) {
        debugBag.push(`db error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const customerMessage =
      verdict.source === 'fallback'
        ? 'Your application has been received. Our team is reviewing it — allow 24–48 hours. If approved, funds go directly to your XRPL wallet. We help as many people as we can based on need, available funds, and the situation described.'
        : verdict.summary;

    return NextResponse.json({
      recommendation: verdict.recommendation,
      confidence:     verdict.confidence,
      summary:        customerMessage,
      flags:          verdict.flags,
      reviewers:      verdict.source,
      _debug:         debugBag,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'review failed';
    return NextResponse.json({ error: message, _debug: debugBag }, { status: 500 });
  }
}
