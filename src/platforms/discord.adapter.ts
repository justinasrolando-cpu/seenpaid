import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// Discord has no OAuth for this flow — the "connection" is a channel webhook
// URL the user creates in Discord (Channel → Integrations → Webhooks) and
// pastes. We store the webhook URL as the account's accessToken and POST to it
// to publish. Mirrors the Bluesky app-password pattern.
interface DiscordWebhook {
  id: string
  name: string
  channel_id: string
  guild_id?: string
  avatar?: string | null
}

const WEBHOOK_RE = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/

export class DiscordAdapter implements PlatformAdapter {
  readonly id = 'discord' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Discord connects via a channel webhook URL, not OAuth — POST /api/accounts/discord/connect')
  }
  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Discord connects via a channel webhook URL, not OAuth')
  }
  // Webhook URLs don't expire — nothing to refresh.
  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken }
  }

  // Validates a pasted webhook URL and reads the channel/webhook name. Called
  // by the dedicated connect route (not part of the OAuth PlatformAdapter API).
  async connectWebhook(webhookUrl: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    if (!WEBHOOK_RE.test(webhookUrl)) throw new ApiError(400, 'That doesn’t look like a Discord webhook URL.')
    const hook = await this.fetchWebhook(webhookUrl)
    return {
      tokens: { accessToken: webhookUrl }, // the webhook URL *is* the credential
      profile: {
        externalAccountId: hook.channel_id,
        displayName: hook.name || 'Discord channel',
        avatarUrl: hook.avatar ? `https://cdn.discordapp.com/avatars/${hook.id}/${hook.avatar}.png` : undefined,
      },
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const hook = await this.fetchWebhook(accessToken)
    return {
      externalAccountId: hook.channel_id,
      displayName: hook.name || 'Discord channel',
      avatarUrl: hook.avatar ? `https://cdn.discordapp.com/avatars/${hook.id}/${hook.avatar}.png` : undefined,
    }
  }

  private async fetchWebhook(webhookUrl: string): Promise<DiscordWebhook> {
    const res = await fetch(webhookUrl)
    if (!res.ok) throw new ApiError(401, `Discord webhook not reachable: ${res.status}`)
    return res.json() as Promise<DiscordWebhook>
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    // Images ride along as embeds; the caption is the message content.
    const embeds = input.media
      .filter((m) => m.type === 'image')
      .slice(0, 4)
      .map((m) => ({ image: { url: m.url } }))

    const res = await fetch(`${input.accessToken}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: input.caption.slice(0, 2000),
        ...(embeds.length ? { embeds } : {}),
      }),
    })
    if (!res.ok) throw new ApiError(502, `Discord post failed: ${res.status} ${await res.text()}`)

    const msg = await res.json() as { id: string; channel_id: string }
    return {
      externalPostId: msg.id,
      externalUrl: `https://discord.com/channels/@me/${msg.channel_id}/${msg.id}`,
    }
  }
}
