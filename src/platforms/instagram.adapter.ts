import { ApiError } from '../errors/index.js'
import { GRAPH_URL, exchangeMetaCode, getLongLivedUserToken, listManagedPages } from './meta-shared.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// Instagram (via Meta Graph API) — Facebook Login OAuth, then
// POST /{ig-user-id}/media (create container) → POST /{ig-user-id}/media_publish.
// Requires an IG Business/Creator account linked to a Facebook Page.
// No app review needed while the Meta app stays in Development Mode and
// the target account is added as a Tester/Admin.
//
// Like the Facebook adapter, we persist the Page access token (it's what
// authorizes calls against the linked IG business account), but
// externalAccountId is the IG business account id, not the Page id.
export class InstagramAdapter implements PlatformAdapter {
  readonly id = 'instagram' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID ?? '',
      redirect_uri: redirectUri,
      state,
      // NOTE: the instagram_business_* renamed scopes only apply to the
      // newer "Instagram API with Instagram Login" (standalone, no Page)
      // integration. This adapter uses "Instagram API with Facebook Login"
      // (Page-linked — see class doc comment), which uses this older scope
      // set as of mid-2026. Meta's own "API setup with Facebook login" guide
      // page has a typo ("instagram_content_publishing") — the real
      // permission, confirmed against the authoritative Permissions and
      // Features catalog, is "instagram_content_publish" (no "-ing").
      scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management',
      response_type: 'code',
    })
    return `https://www.facebook.com/v22.0/dialog/oauth?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const short = await exchangeMetaCode(code, redirectUri)
    const long = await getLongLivedUserToken(short.accessToken)
    const pages = await listManagedPages(long.accessToken)

    const pageWithIg = pages.find((p) => p.instagram_business_account)
    if (!pageWithIg) {
      throw new ApiError(400, 'No Instagram Business/Creator account linked to any managed Facebook Page')
    }

    return {
      accessToken: pageWithIg.access_token,
      expiresAt: new Date(Date.now() + long.expiresIn * 1000),
    }
  }

  async refreshTokens(_refreshToken: string): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Instagram Page tokens don’t self-refresh — user must re-connect to mint a new long-lived token')
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const params = new URLSearchParams({
      fields: 'instagram_business_account{id,username,profile_picture_url}',
      access_token: accessToken,
    })
    const res = await fetch(`${GRAPH_URL}/me?${params.toString()}`)
    if (!res.ok) throw new ApiError(502, `Instagram business account lookup failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as {
      instagram_business_account?: { id: string; username: string; profile_picture_url?: string }
    }
    const ig = data.instagram_business_account
    if (!ig) throw new ApiError(400, 'No Instagram Business account linked to this Page')

    return {
      externalAccountId: ig.id,
      displayName: `@${ig.username}`,
      avatarUrl: ig.profile_picture_url,
    }
  }

  private async pollContainerStatus(containerId: string, accessToken: string): Promise<void> {
    // Video containers process asynchronously; images are usually ready
    // immediately but the same poll is safe (returns FINISHED fast).
    for (let attempt = 0; attempt < 30; attempt++) {
      const params = new URLSearchParams({ fields: 'status_code', access_token: accessToken })
      const res = await fetch(`${GRAPH_URL}/${containerId}?${params.toString()}`)
      if (!res.ok) throw new ApiError(502, `Instagram container status check failed: ${res.status} ${await res.text()}`)

      const { status_code } = await res.json() as { status_code: string }
      if (status_code === 'FINISHED') return
      if (status_code === 'ERROR') throw new ApiError(502, 'Instagram media container processing failed')
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new ApiError(504, 'Instagram media container timed out processing')
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (input.media.length === 0) {
      throw new ApiError(400, 'Instagram requires at least one image or video per post')
    }

    const asset = input.media[0]!
    const isVideo = asset.type === 'video'

    const createParams = new URLSearchParams({
      caption: input.caption,
      access_token: input.accessToken,
      ...(isVideo ? { media_type: 'REELS', video_url: asset.url } : { image_url: asset.url }),
    })

    const createRes = await fetch(`${GRAPH_URL}/${input.externalAccountId}/media`, {
      method: 'POST',
      body: createParams,
    })
    if (!createRes.ok) throw new ApiError(502, `Instagram media container creation failed: ${createRes.status} ${await createRes.text()}`)

    const { id: containerId } = await createRes.json() as { id: string }
    await this.pollContainerStatus(containerId, input.accessToken)

    const publishRes = await fetch(`${GRAPH_URL}/${input.externalAccountId}/media_publish`, {
      method: 'POST',
      body: new URLSearchParams({ creation_id: containerId, access_token: input.accessToken }),
    })
    if (!publishRes.ok) throw new ApiError(502, `Instagram media publish failed: ${publishRes.status} ${await publishRes.text()}`)

    const { id: mediaId } = await publishRes.json() as { id: string }
    return { externalPostId: mediaId, externalUrl: `https://www.instagram.com/p/${mediaId}` }
  }
}
