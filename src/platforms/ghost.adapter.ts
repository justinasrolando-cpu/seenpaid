// ─────────────────────────────────────────────────────────────────────────
// Ghost adapter — Admin API key based, no OAuth. Self-serve: the user pastes
// their site URL + an Admin API key (Ghost Admin → Settings → Integrations →
// Add custom integration). Publishes ARTICLES (title = caption's first line).
//
// Ghost's Admin API authenticates with a short-lived JWT signed from the key
// (which is "id:secret", secret hex-encoded).
// ─────────────────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken'
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const GHOST_VERSION = 'v5.0'

function normalizeSite(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, '')
}

// Mint a 5-minute Admin API token from the "id:secret" key.
function ghostToken(adminKey: string): string {
  const [id, secret] = adminKey.split(':')
  if (!id || !secret) throw new ApiError(400, 'Ghost Admin API key must be in the form id:secret')
  return jwt.sign({}, Buffer.from(secret, 'hex'), {
    keyid: id,
    algorithm: 'HS256',
    expiresIn: '5m',
    audience: '/admin/',
  })
}

export class GhostAdapter implements PlatformAdapter {
  readonly id = 'ghost' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Ghost connects with an Admin API key, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Ghost connects with an Admin API key, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // admin keys don't expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Ghost profile is set at connect time')
  }

  // Validate the key against the Admin API and capture the site as the target.
  // The credential stored is "siteUrl|adminKey" (both are needed on publish).
  async connectAdminKey(siteUrl: string, adminKey: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const site = normalizeSite(siteUrl)
    const token = ghostToken(adminKey)
    const res = await fetch(`${site}/ghost/api/admin/users/me/`, {
      headers: { Authorization: `Ghost ${token}`, 'Accept-Version': GHOST_VERSION },
    })
    if (!res.ok) throw new ApiError(401, `Ghost key rejected: ${res.status} ${await res.text()}`)
    const data = await res.json() as { users?: { name: string; slug: string; profile_image?: string }[] }
    const user = data.users?.[0]
    return {
      tokens: { accessToken: `${site}|${adminKey}` },
      profile: {
        externalAccountId: site,
        displayName: `${user?.name ?? 'Ghost'} · ${site.replace(/^https?:\/\//, '')}`,
        avatarUrl: user?.profile_image,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const [site = '', adminKey = ''] = input.accessToken.split('|')
    const token = ghostToken(adminKey)
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')
    const html = image ? `<figure><img src="${image.url}" /></figure><p>${body}</p>` : `<p>${body}</p>`

    const res = await fetch(`${site}/ghost/api/admin/posts/?source=html`, {
      method: 'POST',
      headers: {
        Authorization: `Ghost ${token}`,
        'Accept-Version': GHOST_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ posts: [{ title, html, status: 'published' }] }),
    })
    if (!res.ok) throw new ApiError(502, `Ghost publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { posts?: { id: string; url: string }[] }
    const post = data.posts?.[0]
    return { externalPostId: post?.id ?? '', externalUrl: post?.url ?? site }
  }
}
