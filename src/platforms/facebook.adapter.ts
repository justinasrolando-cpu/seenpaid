import { ApiError } from '../errors/index.js'
import { GRAPH_URL, exchangeMetaCode, getLongLivedUserToken, listManagedPages } from './meta-shared.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// Facebook Pages (via Meta Graph API) — same OAuth app as Instagram.
// POST /{page-id}/feed for text/link posts, POST /{page-id}/photos for
// image posts. Development Mode + the posting user added as a
// Tester/Admin is sufficient — no app review needed for personal-page use.
//
// We store the PAGE access token (not the user token) as this account's
// accessToken, since that's what every publish call actually needs and it
// stays valid as long as the underlying long-lived user token does
// (~60 days, refreshed by re-connecting).
export class FacebookAdapter implements PlatformAdapter {
  readonly id = 'facebook' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID ?? '',
      redirect_uri: redirectUri,
      state,
      scope: 'pages_manage_posts,pages_read_engagement,pages_show_list',
      response_type: 'code',
    })
    return `https://www.facebook.com/v22.0/dialog/oauth?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const short = await exchangeMetaCode(code, redirectUri)
    const long = await getLongLivedUserToken(short.accessToken)
    const pages = await listManagedPages(long.accessToken)

    const page = pages[0]
    if (!page) throw new ApiError(400, 'No Facebook Pages found for this account — the app needs at least one Page to manage')

    return {
      accessToken: page.access_token,
      expiresAt: new Date(Date.now() + long.expiresIn * 1000),
    }
  }

  async refreshTokens(_refreshToken: string): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Facebook Page tokens don’t self-refresh — user must re-connect to mint a new long-lived token')
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const params = new URLSearchParams({ fields: 'id,name,picture', access_token: accessToken })
    const res = await fetch(`${GRAPH_URL}/me?${params.toString()}`)
    if (!res.ok) throw new ApiError(502, `Facebook Page lookup failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { id: string; name: string; picture?: { data?: { url?: string } } }
    return {
      externalAccountId: data.id,
      displayName: data.name,
      avatarUrl: data.picture?.data?.url,
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const images = input.media.filter((m) => m.type === 'image')

    if (images.length === 0) {
      const res = await fetch(`${GRAPH_URL}/${input.externalAccountId}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input.caption, access_token: input.accessToken }),
      })
      if (!res.ok) throw new ApiError(502, `Facebook feed post failed: ${res.status} ${await res.text()}`)
      const data = await res.json() as { id: string }
      return { externalPostId: data.id, externalUrl: `https://www.facebook.com/${data.id}` }
    }

    // Single photo → /photos; multiple → upload unpublished photos then
    // attach via attached_media on a /feed post.
    if (images.length === 1) {
      const res = await fetch(`${GRAPH_URL}/${input.externalAccountId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: images[0]!.url,
          caption: input.caption,
          access_token: input.accessToken,
        }),
      })
      if (!res.ok) throw new ApiError(502, `Facebook photo post failed: ${res.status} ${await res.text()}`)
      const data = await res.json() as { id: string; post_id?: string }
      const postId = data.post_id ?? data.id
      return { externalPostId: postId, externalUrl: `https://www.facebook.com/${postId}` }
    }

    const uploaded = await Promise.all(images.slice(0, 10).map(async (m) => {
      const res = await fetch(`${GRAPH_URL}/${input.externalAccountId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: m.url, published: false, access_token: input.accessToken }),
      })
      if (!res.ok) throw new ApiError(502, `Facebook unpublished photo upload failed: ${res.status} ${await res.text()}`)
      const data = await res.json() as { id: string }
      return data.id
    }))

    const res = await fetch(`${GRAPH_URL}/${input.externalAccountId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: input.caption,
        attached_media: uploaded.map((id) => ({ media_fbid: id })),
        access_token: input.accessToken,
      }),
    })
    if (!res.ok) throw new ApiError(502, `Facebook multi-photo feed post failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: string }
    return { externalPostId: data.id, externalUrl: `https://www.facebook.com/${data.id}` }
  }
}
