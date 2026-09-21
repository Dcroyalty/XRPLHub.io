// src/app/api/notify-error/route.ts
// Error sink that forwards to ERROR_WEBHOOK_URL (Discord / Slack). ADMIN-ONLY (ADMIN_API_TOKEN, header only).
// It used to be open to the internet, which let anyone post fake alerts into the one channel the operator
// relies on. Server code alerts through src/lib/notify.ts (notifyError), which posts to the webhook directly and
// never calls this route; this endpoint is only for an operator/tool that holds the admin token.
// If ERROR_WEBHOOK_URL is not set, we just log to the Vercel console.

import { NextRequest, NextResponse } from 'next/server';
import { isAdmin, adminUnauthorized } from '@/lib/adminAuth';

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return adminUnauthorized();
  try {
    const { route, message, stack, context } = await req.json().catch(() => ({}));
    const payload = {
      route:   String(route   || 'unknown'),
      message: String(message || 'no message'),
      stack:   String(stack   || '').slice(0, 1500),
      context: context || {},
      site:    'xrplhub.io',
      when:    new Date().toISOString(),
    };

    console.error('[xrplhub error]', JSON.stringify(payload));

    const hook = process.env.ERROR_WEBHOOK_URL;
    if (hook) {
      // Discord webhook format. Works with Slack incoming webhooks too if you adjust content key.
      const isDiscord = hook.includes('discord.com') || hook.includes('discordapp.com');
      const body = isDiscord
        ? { content: `🚨 **XRPLHub Error** \`${payload.route}\`\n\`\`\`${payload.message}\`\`\`\n${payload.stack ? '```\n'+payload.stack.slice(0, 800)+'\n```' : ''}` }
        : { text: `🚨 XRPLHub Error in ${payload.route}: ${payload.message}` };
      fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {}); // intentionally swallow — never let logging break the app
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 }); // never break caller
  }
}
