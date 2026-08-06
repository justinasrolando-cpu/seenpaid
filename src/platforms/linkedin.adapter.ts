import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// LinkedIn — OAuth 2.0 authorization code flow, POST /rest/posts (UGC API)
// for publishing. No app review needed for personal-profile posting with
// the `w_member_social` scope on an app in Development mode with the
// posting user added as a tester.
//
// LinkedIn's REST API requires a YYYYMM version header on every request;
// versions are supported for ~12 months after release, so this needs
// bumping periodically — a stale version fails with 426 NONEXISTENT_VERSION.
const LINKEDIN_API_VERSION = '202606'

export class LinkedInAdapter implements PlatformAdapter {
  readonly id = 'linkedin' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.LINKEDIN_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      scope: 'openid profile w_member_social',
      state,
    })
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINKEDIN_CLIENT_ID ?? '',
        client_secret: process.env.LINKEDIN_CLIENT_SECRET ?? '',
      }),
    })
    if (!res.ok) throw new ApiError(502, `LinkedIn token exchange failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { access_token: string; expires_in: number; scope: string }
    // LinkedIn access tokens are long-lived (60 days) with no refresh token
    // in the standard 3-legged flow — re-auth is required on expiry.
    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scope: data.scope,
    }
  }

  async refreshTokens(_refreshToken: string): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'LinkedIn has no refresh token in the standard flow — user must re-authorize')
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(502, `LinkedIn profile fetch failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { sub: string; name: string; picture?: string }
    return {
      externalAccountId: data.sub,
      displayName: data.name,
      avatarUrl: data.picture,
    }
  }

  private async uploadImage(url: string, accessToken: string, authorUrn: string): Promise<string> {
    // Step 1: register the upload, get an upload URL + asset URN.
    const registerRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
      },
      body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
    })
    if (!registerRes.ok) throw new ApiError(502, `LinkedIn image upload init failed: ${registerRes.status} ${await registerRes.text()}`)

    const { value } = await registerRes.json() as { value: { uploadUrl: string; image: string } }

    // Step 2: fetch the source asset and PUT the bytes to the upload URL.
    const assetRes = await fetch(url)
    if (!assetRes.ok) throw new ApiError(502, `Failed to fetch media asset for upload: ${url}`)
    const buffer = Buffer.from(await assetRes.arrayBuffer())

    const putRes = await fetch(value.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: buffer,
    })
    if (!putRes.ok) throw new ApiError(502, `LinkedIn image binary upload failed: ${putRes.status}`)

    return value.image // asset URN
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const authorUrn = `urn:li:person:${input.externalAccountId}`

    const images = await Promise.all(
      input.media
        .filter((m) => m.type === 'image')
        .slice(0, 9)
        .map((m) => this.uploadImage(m.url, input.accessToken, authorUrn)),
    )

    const body: Record<string, unknown> = {
      author: authorUrn,
      commentary: input.caption,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }
    if (images.length > 0) {
      body.content = {
        multiImage: { images: images.map((id) => ({ id })) },
      }
    }

    const res = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new ApiError(502, `LinkedIn post publish failed: ${res.status} ${await res.text()}`)

    // LinkedIn returns the created post URN in the x-restli-id header, not the body.
    const postUrn = res.headers.get('x-restli-id') ?? ''
    return {
      externalPostId: postUrn,
      externalUrl: `https://www.linkedin.com/feed/update/${postUrn}`,
    }
  }
}
