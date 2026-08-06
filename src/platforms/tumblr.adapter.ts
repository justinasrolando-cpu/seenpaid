// ─────────────────────────────────────────────────────────────────────────
// Tumblr adapter — OAuth 2.0 (API v2). Posts to the user's primary blog using
// the Neue Post Format (NPF). Needs a Tumblr app registered at
// https://www.tumblr.com/oauth/apps with TUMBLR_CLIENT_ID/SECRET.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const API = 'https://api.tumblr.com/v2'
const clientId = () => process.env.TUMBLR_CLIENT_ID ?? ''
const clientSecret = () => process.env.TUMBLR_CLIENT_SECRET ?? ''

export class TumblrAdapter implements PlatformAdapter {
  readonly id = 'tumblr' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      scope: 'write offline_access',
      state,
      redirect_uri: redirectUri,
    })
    return `https://www.tumblr.com/oauth2/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new ApiError(502, `Tumblr token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId(),
        client_secret: clientSecret(),
      }),
    })
    if (!res.ok) throw new ApiError(401, `Tumblr token refresh failed: ${res.status}`)
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch(`${API}/user/info`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new ApiError(502, `Tumblr profile fetch failed: ${res.status}`)
    const data = await res.json() as { response: { user: { name: string; blogs: { name: string; primary: boolean }[] } } }
    const primary = data.response.user.blogs.find((b) => b.primary) ?? data.response.user.blogs[0]
    // externalAccountId = primary blog name (the {blog-identifier} for publishing).
    return { externalAccountId: primary?.name ?? data.response.user.name, displayName: primary?.name ?? data.response.user.name }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const blog = input.externalAccountId
    const content: Record<string, unknown>[] = [{ type: 'text', text: input.caption }]
    const image = input.media.find((m) => m.type === 'image')
    if (image) content.unshift({ type: 'image', media: [{ url: image.url }] })

    const res = await fetch(`${API}/blog/${blog}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({ content, state: 'published' }),
    })
    if (!res.ok) throw new ApiError(502, `Tumblr publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { response: { id_string?: string; id?: string } }
    const id = data.response.id_string ?? String(data.response.id ?? '')
    return { externalPostId: id, externalUrl: `https://${blog}.tumblr.com/post/${id}` }
  }
}
