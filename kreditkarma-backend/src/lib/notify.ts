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

/**
 * A non-error message through the same webhook (recoveries, "XLS-66 is now active", the weekly
 * "I'm alive" heartbeat). Never throws. Silence from THIS is itself a signal: the weekly heartbeat
 * stopping means the crons, the database or the webhook died.
 */
export async function notifyInfo(route: string, message: string, context?: Record<string, unknown>): Promise<void> {
  try {
    console.log(`[info] ${route}: ${message}`, context ? JSON.stringify(context) : "");
  } catch {
    /* ignore */
  }
  const hook = process.env.ERROR_WEBHOOK_URL;
  if (!hook || !/^https:\/\//.test(hook)) return;
  try {
    const isDiscord = /discord(app)?\.com\//.test(hook);
    const ctx = context ? "\n```" + JSON.stringify(context).slice(0, 1200) + "```" : "";
    const body = isDiscord
      ? { content: `ℹ️ **XRPLHub** \`${route}\`\n${message.slice(0, 1500)}${ctx}` }
      : { text: `ℹ️ XRPLHub \`${route}\`: ${message}${ctx}` };
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

/**
 * Optional dead-man's switch. If HEALTHCHECK_PING_URL is set (e.g. a free healthchecks.io check), each cron
 * pings it when a run completes. If BOTH crons — or Vercel itself, the database, or the alert webhook —
 * die, the pings stop and that external service emails you. Nothing inside this app can report its own death.
 */
export async function pingHealthcheck(suffix = ""): Promise<void> {
  const url = process.env.HEALTHCHECK_PING_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  try {
    await fetch(url.replace(/\/$/, "") + suffix, { method: "GET", signal: AbortSignal.timeout(5000) }).catch(() => {});
  } catch {
    /* never break the caller */
  }
}

/** True when an alerting webhook is configured. Shown by /api/health. */
export function alertingArmed(): boolean {
  const hook = process.env.ERROR_WEBHOOK_URL;
  return !!hook && /^https:\/\//.test(hook);
}
