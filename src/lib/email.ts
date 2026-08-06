import { log } from '../observability/logger.js'

// Minimal transactional-email sender, used only for the "a post permanently
// failed to publish" alert (src/jobs/publish-target.job.ts). Uses Resend's
// REST API directly (no SDK dependency) when RESEND_API_KEY is set;
// otherwise falls back to logging the message so a self-hosted instance
// with no email configured still runs fine — you'll just see failures in
// the logs instead of your inbox. Entirely optional.

interface SendEmailInput {
  to: string
  subject: string
  html: string
  text?: string
}

function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL ?? 'seenpaid <onboarding@resend.dev>'
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    log.warn(
      { to: input.to, subject: input.subject },
      'RESEND_API_KEY not set — email not sent. Body logged below.',
    )
    log.info({ to: input.to, subject: input.subject, text: input.text }, 'Email (no RESEND_API_KEY configured)')
    return false
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.error({ status: res.status, body, to: input.to }, 'Resend email send failed')
    throw new Error(`Email send failed: ${res.status}`)
  }
  return true
}

function wrap(bodyHtml: string): string {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#0f172a">
    <p style="font-size:18px;font-weight:800;letter-spacing:-0.5px;color:#0f172a;margin:0 0 24px">seenpaid</p>
    ${bodyHtml}
  </div>`
}

// Sent when a post permanently fails to publish (all BullMQ retries
// exhausted). Deep-links to APP_URL/posts/:id so the fix (usually:
// reconnect the account, retry) is one click away.
export function publishFailedEmail(
  appUrl: string, platformLabel: string | null, reason: string, postId?: string,
): { subject: string; html: string; text: string } {
  const where = platformLabel ? ` to ${platformLabel}` : ''
  const link = postId ? `${appUrl}/posts/${postId}` : `${appUrl}/posts`
  return {
    subject: platformLabel ? `Your post didn't publish to ${platformLabel}` : "Your post didn't publish",
    text: `Heads up — your post didn't go out${where}.\n\nReason: ${reason}\n\nOpen the post to fix it (usually: reconnect the account, then retry): ${link}`,
    html: wrap(`
    <h1 style="font-size:20px;font-weight:700;margin:0 0 12px">Your post didn't publish${where}</h1>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 8px">We tried a few times and it didn't go out. Here's why:</p>
    <p style="font-size:13px;line-height:1.6;color:#0f172a;background:#f1f5f9;border-left:3px solid #64748b;border-radius:0 8px 8px 0;padding:10px 14px;margin:0 0 20px">${reason}</p>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 20px">Most of the time this is a stale connection — reconnect the account, then retry the post.</p>
    <a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:8px">Open the post</a>`),
  }
}
