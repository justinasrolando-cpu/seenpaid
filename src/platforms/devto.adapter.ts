// ─────────────────────────────────────────────────────────────────────────
// Dev.to adapter — API-key based, no OAuth. Fully self-serve: the user pastes
// an API key from https://dev.to/settings/extensions and can publish articles
// immediately (no dev-app registration for anyone).
//
// Dev.to publishes ARTICLES, not micro-posts, so we split the caption: the
// first line becomes the title, the rest becomes the markdown body. A single
// leading image (if any) is prepended to the body as markdown.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const API = 'https://dev.to/api'

// Article platforms have a title + body; our posts are a single caption. Treat
// the first line as the title and the remainder as the markdown body.
export function splitTitleBody(caption: string): { title: string; body: string } {
  const trimmed = caption.trim()
  const nl = trimmed.indexOf('\n')
  if (nl === -1) return { title: trimmed.slice(0, 120) || 'Untitled', body: trimmed }
  return {
    title: trimmed.slice(0, nl).trim().slice(0, 250) || 'Untitled',
    body: trimmed.slice(nl + 1).trim(),
  }
}

export class DevtoAdapter implements PlatformAdapter {
  readonly id = 'devto' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Dev.to does not use OAuth — connect with an API key instead')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Dev.to does not use OAuth — connect with an API key instead')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // API keys don't expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Dev.to profile is set at connect time')
  }

  // Validate the API key and read the user's identity.
  async connectApiKey(apiKey: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const res = await fetch(`${API}/users/me`, { headers: { 'api-key': apiKey } })
    if (!res.ok) throw new ApiError(401, `Dev.to key rejected: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: number; username: string; name?: string; profile_image?: string }
    return {
      tokens: { accessToken: apiKey },
      profile: {
        externalAccountId: String(data.id),
        displayName: data.name || `@${data.username}`,
        avatarUrl: data.profile_image,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')
    const markdown = image ? `![](${image.url})\n\n${body}` : body

    const res = await fetch(`${API}/articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': input.accessToken },
      body: JSON.stringify({
        article: { title, body_markdown: markdown, published: true },
      }),
    })
    if (!res.ok) throw new ApiError(502, `Dev.to publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: number; url: string }
    return { externalPostId: String(data.id), externalUrl: data.url }
  }
}
