// ─────────────────────────────────────────────────────────────────────────
// WordPress adapter — Application Password based, no OAuth. Self-serve for any
// self-hosted WordPress (5.6+) or WordPress.com site with the REST API enabled:
// the user creates an Application Password (Users → Profile → Application
// Passwords) and pastes the site URL, username, and that password.
//
// Publishes ARTICLES (title = caption's first line, body = the rest as HTML).
// The credential stored is `username:app_password`; the site URL is the
// account's externalAccountId (the publish target).
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// Trim a trailing slash so we can safely append REST paths.
function normalizeSite(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, '')
}

export class WordpressAdapter implements PlatformAdapter {
  readonly id = 'wordpress' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'WordPress connects with an Application Password, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'WordPress connects with an Application Password, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // application passwords don't expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'WordPress profile is set at connect time')
  }

  // Validate the credentials against the site's REST API and capture the site
  // as the target. accessToken = "username:appPassword" (Basic auth material).
  async connectAppPassword(
    siteUrl: string, username: string, appPassword: string,
  ): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const site = normalizeSite(siteUrl)
    const creds = `${username}:${appPassword.replace(/\s+/g, '')}`
    const auth = Buffer.from(creds).toString('base64')
    const res = await fetch(`${site}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: `Basic ${auth}` },
    })
    if (!res.ok) throw new ApiError(401, `WordPress credentials rejected: ${res.status} ${await res.text()}`)
    const data = await res.json() as { name?: string; slug?: string; avatar_urls?: Record<string, string> }
    return {
      tokens: { accessToken: creds },
      profile: {
        externalAccountId: site,
        displayName: `${data.name || username} · ${site.replace(/^https?:\/\//, '')}`,
        avatarUrl: data.avatar_urls?.['96'],
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const site = input.externalAccountId
    const auth = Buffer.from(input.accessToken).toString('base64')
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')
    const content = image ? `<p><img src="${image.url}" /></p>\n${body}` : body

    const res = await fetch(`${site}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({ title, content, status: 'publish' }),
    })
    if (!res.ok) throw new ApiError(502, `WordPress publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: number; link: string }
    return { externalPostId: String(data.id), externalUrl: data.link }
  }
}
