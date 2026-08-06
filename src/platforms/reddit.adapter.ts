// ─────────────────────────────────────────────────────────────────────────
// Reddit adapter — OAuth 2.0 (authorization code, permanent duration for a
// refresh token). Posts a self (text) post to the user's own profile
// (u/username) by default. Needs a Reddit "web app" registered at
// https://www.reddit.com/prefs/apps with REDDIT_CLIENT_ID/SECRET set.
//
// Reddit requires a descriptive User-Agent on every API call.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const UA = 'web:seenpaid:1.0 (by /u/seenpaid)'
const clientId = () => process.env.REDDIT_CLIENT_ID ?? ''
const clientSecret = () => process.env.REDDIT_CLIENT_SECRET ?? ''
const basicAuth = () => Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')

export class RedditAdapter implements PlatformAdapter {
  readonly id = 'reddit' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      state,
      redirect_uri: redirectUri,
      duration: 'permanent',
      scope: 'identity submit',
    })
    return `https://www.reddit.com/api/v1/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    })
    if (!res.ok) throw new ApiError(502, `Reddit token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    })
    if (!res.ok) throw new ApiError(401, `Reddit token refresh failed: ${res.status}`)
    const data = await res.json() as { access_token: string; expires_in: number }
    return {
      accessToken: data.access_token,
      refreshToken, // Reddit keeps the same refresh token
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch('https://oauth.reddit.com/api/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
    })
    if (!res.ok) throw new ApiError(502, `Reddit profile fetch failed: ${res.status}`)
    const data = await res.json() as { name: string; icon_img?: string }
    // externalAccountId = username; needed to target u/username on publish.
    return { externalAccountId: data.name, displayName: `u/${data.name}`, avatarUrl: data.icon_img }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { title, body } = splitTitleBody(input.caption)
    const res = await fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({
        sr: `u_${input.externalAccountId}`, // the user's own profile
        kind: 'self',
        title,
        text: body,
        api_type: 'json',
      }),
    })
    if (!res.ok) throw new ApiError(502, `Reddit submit failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { json: { errors: unknown[]; data?: { id: string; url: string } } }
    if (data.json.errors?.length) throw new ApiError(502, `Reddit submit error: ${JSON.stringify(data.json.errors)}`)
    return {
      externalPostId: data.json.data?.id ?? '',
      externalUrl: data.json.data?.url ?? `https://www.reddit.com/user/${input.externalAccountId}`,
    }
  }
}
