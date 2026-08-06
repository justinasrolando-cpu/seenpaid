// ─────────────────────────────────────────────────────────────────────────
// Threads adapter — Meta's Threads API, OAuth 2.0. Publishing is a two-step
// container flow (create → publish). Needs a Threads app (Meta developer
// console) with THREADS_CLIENT_ID/SECRET and the threads_content_publish
// permission. Text posts work in dev mode with the app owner added as a tester.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const GRAPH = 'https://graph.threads.net/v1.0'
const clientId = () => process.env.THREADS_CLIENT_ID ?? ''
const clientSecret = () => process.env.THREADS_CLIENT_SECRET ?? ''

export class ThreadsAdapter implements PlatformAdapter {
  readonly id = 'threads' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      scope: 'threads_basic,threads_content_publish',
      response_type: 'code',
      state,
    })
    return `https://threads.net/oauth/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      }),
    })
    if (!res.ok) throw new ApiError(502, `Threads token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string; user_id: string }
    return { accessToken: data.access_token }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    // Long-lived Threads tokens can be refreshed at th_refresh_token; treat as
    // a no-op here so the sweep doesn't force re-auth prematurely.
    const res = await fetch(`${GRAPH}/refresh_access_token?grant_type=th_refresh_token&access_token=${refreshToken}`)
    if (!res.ok) return { accessToken: refreshToken }
    const data = await res.json() as { access_token: string; expires_in: number }
    return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch(`${GRAPH}/me?fields=id,username,threads_profile_picture_url&access_token=${accessToken}`)
    if (!res.ok) throw new ApiError(502, `Threads profile fetch failed: ${res.status}`)
    const data = await res.json() as { id: string; username: string; threads_profile_picture_url?: string }
    return { externalAccountId: data.id, displayName: `@${data.username}`, avatarUrl: data.threads_profile_picture_url }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const userId = input.externalAccountId
    const image = input.media.find((m) => m.type === 'image')

    // Step 1: create a media container (TEXT, or IMAGE with a caption).
    const createParams = new URLSearchParams({ access_token: input.accessToken, text: input.caption })
    if (image) {
      createParams.set('media_type', 'IMAGE')
      createParams.set('image_url', image.url)
    } else {
      createParams.set('media_type', 'TEXT')
    }
    const createRes = await fetch(`${GRAPH}/${userId}/threads`, { method: 'POST', body: createParams })
    if (!createRes.ok) throw new ApiError(502, `Threads container create failed: ${createRes.status} ${await createRes.text()}`)
    const { id: creationId } = await createRes.json() as { id: string }

    // Step 2: publish the container.
    const pubRes = await fetch(`${GRAPH}/${userId}/threads_publish`, {
      method: 'POST',
      body: new URLSearchParams({ access_token: input.accessToken, creation_id: creationId }),
    })
    if (!pubRes.ok) throw new ApiError(502, `Threads publish failed: ${pubRes.status} ${await pubRes.text()}`)
    const { id } = await pubRes.json() as { id: string }
    return { externalPostId: id, externalUrl: `https://www.threads.net/@me/post/${id}` }
  }
}
