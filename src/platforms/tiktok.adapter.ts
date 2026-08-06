import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

// TikTok — OAuth 2.0. publish() uses the INBOX/DRAFT flow
// (/v2/post/publish/inbox/video/init) with FILE_UPLOAD: we download the video
// and stream the bytes straight to TikTok, which drops it into the creator's
// TikTok drafts to finish + publish in-app.
//
// Why this design (two deliberate choices):
//  1. Inbox/draft (video.upload) instead of Direct Post (video.publish): the
//     draft path needs NO content-posting audit and works for every creator,
//     so TikTok is usable at launch. Direct auto-publish is gated behind
//     TikTok's app review — a future upgrade, not a launch blocker.
//  2. FILE_UPLOAD instead of PULL_FROM_URL: pull-from-url requires TikTok to
//     verify the domain serving the video, but our media lives on a Cloudflare
//     *.r2.dev domain we don't own and can't verify. Uploading the bytes
//     ourselves needs no domain verification at all.
export class TikTokAdapter implements PlatformAdapter {
  readonly id = 'tiktok' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY ?? '',
      redirect_uri: redirectUri,
      state,
      scope: 'user.info.basic,video.publish,video.upload',
      response_type: 'code',
    })
    return `https://www.tiktok.com/v2/auth/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY ?? '',
        client_secret: process.env.TIKTOK_CLIENT_SECRET ?? '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new ApiError(502, `TikTok token exchange failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as {
      access_token: string; refresh_token: string; expires_in: number; scope: string
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scope: data.scope,
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY ?? '',
        client_secret: process.env.TIKTOK_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    if (!res.ok) throw new ApiError(502, `TikTok token refresh failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as {
      access_token: string; refresh_token: string; expires_in: number; scope: string
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scope: data.scope,
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const params = new URLSearchParams({ fields: 'open_id,display_name,avatar_url' })
    const res = await fetch(`https://open.tiktokapis.com/v2/user/info/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(502, `TikTok user info fetch failed: ${res.status} ${await res.text()}`)

    const { data } = await res.json() as {
      data: { user: { open_id: string; display_name: string; avatar_url?: string } }
    }
    return {
      externalAccountId: data.user.open_id,
      displayName: data.user.display_name,
      avatarUrl: data.user.avatar_url,
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const video = input.media.find((m) => m.type === 'video')
    if (!video) throw new ApiError(400, 'TikTok requires exactly one video per post')

    // Pull the video bytes so we can hand them to TikTok directly (see the
    // FILE_UPLOAD rationale in the class doc).
    const assetRes = await fetch(video.url)
    if (!assetRes.ok) throw new ApiError(502, `Failed to fetch video for TikTok: ${assetRes.status}`)
    const bytes = Buffer.from(await assetRes.arrayBuffer())
    const size = bytes.byteLength
    // Single-chunk upload; TikTok caps one chunk at 64MB. Short-form videos are
    // comfortably under that. Larger files need multi-chunk (a follow-up) —
    // fail loud rather than silently truncate.
    if (size > 64 * 1024 * 1024) {
      throw new ApiError(400, 'TikTok video is over 64MB — trim it or lower the resolution (multi-chunk upload is a future upgrade)')
    }

    // Step 1: init the inbox/draft upload — returns a pre-signed upload URL.
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: size,
          chunk_size: size,
          total_chunk_count: 1,
        },
      }),
    })
    if (!initRes.ok) throw new ApiError(502, `TikTok inbox init failed: ${initRes.status} ${await initRes.text()}`)
    const { data } = await initRes.json() as { data: { publish_id: string; upload_url: string } }

    // Step 2: upload the whole video as one chunk to the pre-signed URL.
    const putRes = await fetch(data.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': video.mimeType || 'video/mp4',
        'Content-Length': String(size),
        'Content-Range': `bytes 0-${size - 1}/${size}`,
      },
      body: bytes,
    })
    if (!putRes.ok) throw new ApiError(502, `TikTok video upload failed: ${putRes.status} ${await putRes.text()}`)

    // The video now sits in the creator's TikTok drafts; publish_id identifies
    // it. There's no public post URL until they finish + post it in-app, so we
    // surface the profile as a placeholder.
    return {
      externalPostId: data.publish_id,
      externalUrl: `https://www.tiktok.com/@${input.externalAccountId}`,
    }
  }
}
