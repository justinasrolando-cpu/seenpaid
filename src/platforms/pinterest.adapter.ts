// ─────────────────────────────────────────────────────────────────────────
// Pinterest adapter — OAuth 2.0 (API v5). A Pin needs a board + an image, so
// publish requires media and targets the user's first board. Needs a Pinterest
// app (https://developers.pinterest.com) with PINTEREST_CLIENT_ID/SECRET; the
// app must be approved for the pins:write / boards:read scopes for live use.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const API = 'https://api.pinterest.com/v5'
const clientId = () => process.env.PINTEREST_CLIENT_ID ?? ''
const clientSecret = () => process.env.PINTEREST_CLIENT_SECRET ?? ''
const basicAuth = () => Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')

export class PinterestAdapter implements PlatformAdapter {
  readonly id = 'pinterest' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'boards:read,pins:read,pins:write',
      state,
    })
    return `https://www.pinterest.com/oauth/?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    })
    if (!res.ok) throw new ApiError(502, `Pinterest token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
    if (!res.ok) throw new ApiError(401, `Pinterest token refresh failed: ${res.status}`)
    const data = await res.json() as { access_token: string; expires_in: number }
    return { accessToken: data.access_token, refreshToken, expiresAt: new Date(Date.now() + data.expires_in * 1000) }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch(`${API}/user_account`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new ApiError(502, `Pinterest profile fetch failed: ${res.status}`)
    const data = await res.json() as { username: string; profile_image?: string }
    return { externalAccountId: data.username, displayName: `@${data.username}`, avatarUrl: data.profile_image }
  }

  private async firstBoardId(accessToken: string): Promise<string> {
    const res = await fetch(`${API}/boards?page_size=1`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new ApiError(502, `Pinterest boards fetch failed: ${res.status}`)
    const data = await res.json() as { items?: { id: string }[] }
    const id = data.items?.[0]?.id
    if (!id) throw new ApiError(400, 'No Pinterest board found — create a board first')
    return id
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const image = input.media.find((m) => m.type === 'image')
    if (!image) throw new ApiError(400, 'Pinterest requires an image to create a Pin')
    const { title, body } = splitTitleBody(input.caption)
    const boardId = await this.firstBoardId(input.accessToken)

    const res = await fetch(`${API}/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({
        board_id: boardId,
        title: title.slice(0, 100),
        description: body.slice(0, 800),
        media_source: { source_type: 'image_url', url: image.url },
      }),
    })
    if (!res.ok) throw new ApiError(502, `Pinterest pin create failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: string }
    return { externalPostId: data.id, externalUrl: `https://www.pinterest.com/pin/${data.id}/` }
  }
}
