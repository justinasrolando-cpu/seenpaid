// ─────────────────────────────────────────────────────────────────────────
// Slack adapter — Incoming Webhook based, no OAuth. Self-serve: the user
// creates an Incoming Webhook for a channel (https://api.slack.com/messaging/webhooks)
// and pastes the URL. Posts go to that channel. Mirrors the Discord adapter.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/

export class SlackAdapter implements PlatformAdapter {
  readonly id = 'slack' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Slack connects via an Incoming Webhook URL, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Slack connects via an Incoming Webhook URL, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken }
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Slack profile is set at connect time')
  }

  // Slack webhooks are write-only (no GET validation), so we validate the URL
  // shape and store it as the credential. A short trailing segment of the path
  // keys the account so reconnecting the same webhook upserts in place.
  async connectWebhook(webhookUrl: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    if (!WEBHOOK_RE.test(webhookUrl)) {
      throw new ApiError(400, 'That does not look like a Slack Incoming Webhook URL (https://hooks.slack.com/services/…)')
    }
    const idPart = webhookUrl.split('/services/')[1] ?? webhookUrl
    return {
      tokens: { accessToken: webhookUrl },
      profile: { externalAccountId: idPart.slice(0, 40), displayName: 'Slack channel' },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const image = input.media.find((m) => m.type === 'image')
    const payload: Record<string, unknown> = { text: input.caption }
    // Attach a lead image via the legacy attachments field (image_url renders inline).
    if (image) payload.attachments = [{ image_url: image.url, text: '' }]

    const res = await fetch(input.accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new ApiError(502, `Slack webhook post failed: ${res.status} ${await res.text()}`)
    // Incoming webhooks return "ok" with no message id/permalink.
    return { externalPostId: `slack_${Date.now()}`, externalUrl: '' }
  }
}
