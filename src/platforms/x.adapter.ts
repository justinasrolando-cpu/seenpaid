import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from '../errors/index.js'
import { buildOAuth1Header, type Oauth1Creds } from './oauth1.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// In-memory PKCE verifier store keyed by OAuth `state`. Fine for a single
// API instance; move to Redis if the API scales horizontally.
const pkceVerifiers = new Map<string, string>()

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Turn X's raw API error into a short, actionable reason for the "Why it
// failed" post card. X's failure modes are distinct and each needs a different
// user action, so a plain status dump ("402 {...}") isn't enough.
function describeXPublishError(status: number, bodyText: string): string {
  let title = '', detail = ''
  try {
    const j = JSON.parse(bodyText) as { title?: string; detail?: string; errors?: { message?: string }[] }
    title = j.title ?? ''
    detail = j.detail ?? j.errors?.[0]?.message ?? ''
  } catch { /* non-JSON body — fall through to the raw text */ }
  const hay = `${title} ${detail} ${bodyText}`.toLowerCase()

  if (status === 402 || hay.includes('credit')) {
    return 'X needs API credits to post. X now charges for API posting — in your X developer portal, redeem the free-credits voucher, add credits, or switch the app to the Free tier. (Not a seenpaid limit — it’s X’s API pricing.)'
  }
  if (hay.includes('duplicate')) {
    return 'X rejected this as duplicate content — change the wording and try again.'
  }
  if (status === 403 || hay.includes('oauth1 app permissions') || hay.includes('unsupported authentication')) {
    return 'Your X app can’t post. Set it to “Read and write”, regenerate the Access Token & Secret, then reconnect X.'
  }
  if (status === 401 || hay.includes('unauthorized')) {
    return 'X rejected your keys. Reconnect X under Accounts with fresh OAuth 1.0 keys.'
  }
  return `X tweet publish failed: ${status}${detail ? ` — ${detail}` : ` ${bodyText.slice(0, 160)}`}`
}

// X (Twitter) API v2 — OAuth 2.0 PKCE, POST /2/tweets for text,
// POST /2/media/upload (chunked, v1.1 endpoint — v2 has no media upload yet)
// for images/video before attaching media_ids.
export class XAdapter implements PlatformAdapter {
  readonly id = 'x' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    pkceVerifiers.set(state, verifier)

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.X_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      scope: 'tweet.read tweet.write users.read offline.access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    return `https://twitter.com/i/oauth2/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string, state?: string): Promise<OAuthTokenSet> {
    const verifier = state ? pkceVerifiers.get(state) : undefined
    if (!verifier) throw new ApiError(400, 'Missing or expired PKCE verifier for this OAuth state')
    if (state) pkceVerifiers.delete(state)

    const basicAuth = Buffer.from(
      `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`,
    ).toString('base64')

    const res = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      // client_id/client_secret redundantly included in the body alongside
      // the Basic auth header — X's newer Pay-Per-Use token endpoint has
      // been unreliable about picking up Basic auth alone (see project
      // CLAUDE.md / task #27), so send both to maximize compatibility.
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: process.env.X_CLIENT_ID ?? '',
        client_secret: process.env.X_CLIENT_SECRET ?? '',
      }),
    })
    if (!res.ok) throw new ApiError(502, `X token exchange failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number; scope: string }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scope: data.scope,
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const basicAuth = Buffer.from(
      `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`,
    ).toString('base64')

    const res = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.X_CLIENT_ID ?? '',
      }),
    })
    if (!res.ok) throw new ApiError(502, `X token refresh failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number; scope: string }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scope: data.scope,
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(502, `X profile fetch failed: ${res.status} ${await res.text()}`)

    const { data } = await res.json() as { data: { id: string; username: string; profile_image_url?: string } }
    return {
      externalAccountId: data.id,
      displayName: `@${data.username}`,
      avatarUrl: data.profile_image_url,
    }
  }

  // The Authorization header for a request: OAuth 1.0a signed with the user's
  // own X app keys when BYOK creds are present (each request signs its own
  // URL/method), else the shared OAuth 2.0 user-context bearer.
  private authHeader(method: string, url: string, input: PublishInput): string {
    if (input.oauth1) return buildOAuth1Header(method, url, input.oauth1)
    return `Bearer ${input.accessToken}`
  }

  private async uploadMedia(url: string, mimeType: string, input: PublishInput): Promise<string> {
    const assetRes = await fetch(url)
    if (!assetRes.ok) throw new ApiError(502, `Failed to fetch media asset for upload: ${url}`)
    const buffer = Buffer.from(await assetRes.arrayBuffer())

    // multipart body params are excluded from the OAuth 1.0a signature base, so
    // the header signs only the method+URL — no extra params to fold in.
    const form = new FormData()
    form.append('media', new Blob([buffer], { type: mimeType }))

    const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json'
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader('POST', uploadUrl, input) },
      body: form,
    })
    if (!res.ok) throw new ApiError(502, `X media upload failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { media_id_string: string }
    return data.media_id_string
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const mediaIds = await Promise.all(
      input.media.slice(0, 4).map((m) => this.uploadMedia(m.url, m.mimeType, input)),
    )

    const body: Record<string, unknown> = { text: input.caption }
    if (mediaIds.length > 0) body.media = { media_ids: mediaIds }

    const tweetsUrl = 'https://api.twitter.com/2/tweets'
    const res = await fetch(tweetsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.authHeader('POST', tweetsUrl, input),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(502, describeXPublishError(res.status, await res.text()))

    const { data } = await res.json() as { data: { id: string } }
    return {
      externalPostId: data.id,
      externalUrl: `https://x.com/${input.externalAccountId}/status/${data.id}`,
    }
  }

  // BYOK connect flow: validate a user's 4 X keys by calling /2/users/me signed
  // with them. Returns the account profile (id + @handle) if valid; throws if
  // the keys are wrong so the connect route can surface a clear error. Query
  // params must be folded into the OAuth 1.0a signature base.
  async fetchProfileWithByok(creds: Oauth1Creds): Promise<AccountProfile> {
    const baseUrl = 'https://api.twitter.com/2/users/me'
    const params = { 'user.fields': 'profile_image_url' }
    const res = await fetch(`${baseUrl}?user.fields=profile_image_url`, {
      headers: { Authorization: buildOAuth1Header('GET', baseUrl, creds, params) },
    })
    if (!res.ok) throw new ApiError(400, `X credentials rejected: ${res.status} ${await res.text()}`)

    const { data } = await res.json() as { data: { id: string; username: string; profile_image_url?: string } }
    return {
      externalAccountId: data.id,
      displayName: `@${data.username}`,
      avatarUrl: data.profile_image_url,
    }
  }
}
