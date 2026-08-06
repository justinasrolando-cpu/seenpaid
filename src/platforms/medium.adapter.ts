// ─────────────────────────────────────────────────────────────────────────
// Medium adapter — integration-token based, no OAuth. The user pastes an
// integration token (medium.com → Settings → Security and apps → Integration
// tokens) and can publish immediately.
//
// NOTE: Medium deprecated NEW integration-token generation, so this works for
// accounts that already hold a token but new users may be unable to create one.
// Kept for completeness. Publishes ARTICLES: caption first line → title.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const API = 'https://api.medium.com/v1'

export class MediumAdapter implements PlatformAdapter {
  readonly id = 'medium' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Medium does not use OAuth here — connect with an integration token instead')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Medium does not use OAuth here — connect with an integration token instead')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // integration tokens don't auto-expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Medium profile is set at connect time')
  }

  // Validate the token and read the user (needed: authorId for publishing).
  async connectToken(token: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new ApiError(401, `Medium token rejected: ${res.status} ${await res.text()}`)
    const { data } = await res.json() as { data: { id: string; username: string; name: string; imageUrl?: string } }
    return {
      tokens: { accessToken: token },
      profile: {
        externalAccountId: data.id,
        displayName: data.name || `@${data.username}`,
        avatarUrl: data.imageUrl,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')
    const markdown = image ? `![](${image.url})\n\n${body}` : body

    const res = await fetch(`${API}/users/${input.externalAccountId}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({
        title, contentFormat: 'markdown', content: markdown, publishStatus: 'public',
      }),
    })
    if (!res.ok) throw new ApiError(502, `Medium publish failed: ${res.status} ${await res.text()}`)
    const { data } = await res.json() as { data: { id: string; url: string } }
    return { externalPostId: data.id, externalUrl: data.url }
  }
}
