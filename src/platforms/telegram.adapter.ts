import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// Telegram has no OAuth. The user creates a bot with @BotFather, adds it to
// their channel as an admin, and pastes the bot token + the channel id
// (@channelname or a numeric id). We store the bot token as the credential and
// the chat id as the account's externalAccountId.
const API = 'https://api.telegram.org'

export class TelegramAdapter implements PlatformAdapter {
  readonly id = 'telegram' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Telegram connects with a bot token + channel id, not OAuth — POST /api/accounts/telegram/connect')
  }
  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Telegram connects with a bot token + channel id, not OAuth')
  }
  // Bot tokens don't expire.
  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken }
  }

  // Validates the bot token + channel and reads the channel title. Called by
  // the dedicated connect route (not part of the OAuth PlatformAdapter API).
  async connectBot(botToken: string, chatId: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const me = await this.call(botToken, 'getMe', {})
    if (!me.ok) throw new ApiError(401, 'Invalid Telegram bot token.')
    const chat = await this.call(botToken, 'getChat', { chat_id: chatId })
    if (!chat.ok) throw new ApiError(400, 'Bot can’t see that channel — add it as an admin, and check the channel id.')
    const title = (chat.result as { title?: string; username?: string }).title
      ?? (chat.result as { username?: string }).username
      ?? chatId
    return {
      tokens: { accessToken: botToken },
      profile: { externalAccountId: String(chatId), displayName: title },
    }
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    // Profile is captured at connect time; nothing extra to fetch on token use.
    throw new ApiError(400, 'Telegram profile is set at connect time')
  }

  private async call(botToken: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    const res = await fetch(`${API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const botToken = input.accessToken
    const chatId = input.externalAccountId
    const image = input.media.find((m) => m.type === 'image')

    // A single image → sendPhoto with caption; otherwise a plain text message.
    const method = image ? 'sendPhoto' : 'sendMessage'
    const body = image
      ? { chat_id: chatId, photo: image.url, caption: input.caption.slice(0, 1024) }
      : { chat_id: chatId, text: input.caption.slice(0, 4096) }

    const out = await this.call(botToken, method, body)
    if (!out.ok) throw new ApiError(502, `Telegram post failed: ${out.description ?? 'unknown error'}`)

    const msg = out.result as { message_id: number; chat: { username?: string; id: number } }
    const url = msg.chat.username ? `https://t.me/${msg.chat.username}/${msg.message_id}` : ''
    return { externalPostId: String(msg.message_id), externalUrl: url }
  }
}
