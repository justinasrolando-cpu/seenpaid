// ─────────────────────────────────────────────────────────────────────────
// Webhook adapter — a generic outbound target, no OAuth. Self-serve: the user
// pastes any HTTPS URL (their own endpoint, Zapier/Make/n8n catch hook, an
// internal service…) and every published post is POSTed to it as JSON. This
// lets power users pipe seenpaid content anywhere.
//
// Optional signing secret → each request carries an X-Seenpaid-Signature
// HMAC-SHA256 of the raw body so the receiver can verify authenticity.
// ─────────────────────────────────────────────────────────────────────────
import { createHmac } from 'node:crypto'
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

export class WebhookAdapter implements PlatformAdapter {
  readonly id = 'webhook' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Webhook connects with a URL, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Webhook connects with a URL, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken }
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Webhook profile is set at connect time')
  }

  // Store "url|secret" (secret optional) as the credential. externalAccountId
  // is the host so the account chip reads sensibly and reconnects upsert.
  async connectUrl(url: string, secret?: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    if (!/^https:\/\/.+/.test(url)) throw new ApiError(400, 'Webhook URL must be an https:// address')
    let host = url
    try { host = new URL(url).host } catch { /* keep raw */ }
    return {
      tokens: { accessToken: `${url}|${secret ?? ''}` },
      profile: { externalAccountId: host, displayName: host },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const [url = '', secret = ''] = input.accessToken.split('|')
    const payload = JSON.stringify({
      platform: 'webhook',
      caption: input.caption,
      media: input.media.map((m) => ({ url: m.url, type: m.type })),
      postedAt: new Date().toISOString(),
    })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (secret) headers['X-Seenpaid-Signature'] = createHmac('sha256', secret).update(payload).digest('hex')

    const res = await fetch(url, { method: 'POST', headers, body: payload })
    if (!res.ok) throw new ApiError(502, `Webhook POST failed: ${res.status} ${await res.text()}`)
    return { externalPostId: `webhook_${Date.now()}`, externalUrl: '' }
  }
}
