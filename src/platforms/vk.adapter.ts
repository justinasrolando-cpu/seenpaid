// ─────────────────────────────────────────────────────────────────────────
// VK adapter — OAuth 2.0, posts to the user's wall (wall.post). Needs a VK app
// (https://dev.vk.com) with VK_CLIENT_ID/SECRET and the `wall` + `offline`
// scopes (offline → non-expiring token). Note: VK API access is region- and
// review-gated, so this is unverified until the app is approved.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const API_VERSION = '5.199'
const clientId = () => process.env.VK_CLIENT_ID ?? ''
const clientSecret = () => process.env.VK_CLIENT_SECRET ?? ''

export class VkAdapter implements PlatformAdapter {
  readonly id = 'vk' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'wall,offline',
      state,
      v: API_VERSION,
    })
    return `https://oauth.vk.com/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const params = new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      code,
    })
    const res = await fetch(`https://oauth.vk.com/access_token?${params.toString()}`)
    if (!res.ok) throw new ApiError(502, `VK token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string; user_id: number }
    // Store the user id in the scope field so publish can target the wall.
    return { accessToken: data.access_token, scope: String(data.user_id) }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    // offline scope → tokens don't expire; nothing to refresh.
    return { accessToken: refreshToken }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch(`https://api.vk.com/method/users.get?fields=photo_200&access_token=${accessToken}&v=${API_VERSION}`)
    if (!res.ok) throw new ApiError(502, `VK profile fetch failed: ${res.status}`)
    const data = await res.json() as { response?: { id: number; first_name: string; last_name: string; photo_200?: string }[] }
    const u = data.response?.[0]
    if (!u) throw new ApiError(502, 'VK profile fetch returned no user')
    return { externalAccountId: String(u.id), displayName: `${u.first_name} ${u.last_name}`, avatarUrl: u.photo_200 }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const params = new URLSearchParams({
      owner_id: input.externalAccountId,
      message: input.caption,
      access_token: input.accessToken,
      v: API_VERSION,
    })
    const image = input.media.find((m) => m.type === 'image')
    if (image) params.set('attachments', image.url)

    const res = await fetch(`https://api.vk.com/method/wall.post?${params.toString()}`, { method: 'POST' })
    if (!res.ok) throw new ApiError(502, `VK publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { response?: { post_id: number }; error?: { error_msg: string } }
    if (data.error) throw new ApiError(502, `VK publish error: ${data.error.error_msg}`)
    const postId = data.response?.post_id
    return {
      externalPostId: String(postId ?? ''),
      externalUrl: `https://vk.com/wall${input.externalAccountId}_${postId}`,
    }
  }
}
