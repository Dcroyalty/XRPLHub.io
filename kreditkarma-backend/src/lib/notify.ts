// src/lib/notify.ts
// Loud-failure alerting. Posts DIRECTLY to ERROR_WEBHOOK_URL (Discord or Slack
// incoming webhook) — no self-fetch, no relative URL, so it can't throw the
// "Failed to parse URL" the Node runtime raises on fetch("/api/..."). Every
// path is wrapped: notifyError never throws and its promise never rejects, so
// an un-awaited call on the customer path is safe and an awaited call in a
// cron is safe.
//
// It also always console.error()s, so the failure is in the Vercel logs even
// when no webhook is configured.

function fmt(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack ?? "" };
  return { message: String(err), stack: "" };
}

export async function notifyError(
  route: string,
  err: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const { message, stack } = fmt(err);
  try {
    // Always visible in logs.
    console.error(`[alert] ${route}: ${message}`, context ? JSON.stringify(context) : "");
  } catch {
    /* ignore */
  }

  const hook = process.env.ERROR_WEBHOOK_URL;
  if (!hook || !/^https:\/\//.test(hook)) return;

  try {
    const isDiscord = /discord(app)?\.com\//.test(hook);
    const ctx = context ? "\n```" + JSON.stringify(context).slice(0, 800) + "```" : "";
    const body = isDiscord
      ? {
          content:
            `🚨 **XRPLHub** \`${route}\`\n\`\`\`${message.slice(0, 1500)}\`\`\`` +
            (stack ? "\n```" + stack.slice(0, 600) + "```" : "") +
            ctx,
        }
      : { text: `🚨 XRPLHub \`${route}\`: ${message}${ctx}` };

    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {
    /* the logger must never break the caller */
  }
}

/** True when an alerting webhook is configured. Shown by /api/health. */
export function alertingArmed(): boolean {
  const hook = process.env.ERROR_WEBHOOK_URL;
  return !!hook && /^https:\/\//.test(hook);
}
