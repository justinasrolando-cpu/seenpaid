// ─────────────────────────────────────────────────────────────────────────
// Mastodon adapter — READY TO USE.
//
// To activate: rename this file to `mastodon.adapter.ts`, then do the wiring in
// docs/ADDING_A_PLATFORM.md (add 'mastodon' to PlatformId + registry + the DB
// platformEnum + the DTO enums + the dashboard lists, then generate/run the
// migration).
//
// Env needed (register an app once at <instance>/settings/applications, scopes
// `read write`):
//   MASTODON_INSTANCE_URL=https://mastodon.social
//   MASTODON_CLIENT_ID=...
//   MASTODON_CLIENT_SECRET=...
//
// Mastodon is federated: this template targets a single configured instance,
// which is the simplest correct MVP. To support any instance the user is on,
// register the app per-instance at connect time (POST /api/v1/apps) and store
// the instance URL on the account — a good v2 follow-up.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const INSTANCE = process.env.MASTODON_INSTANCE_URL ?? 'https://mastodon.social'
const CLIENT_ID = process.env.MASTODON_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.MASTODON_CLIENT_SECRET ?? ''

export class MastodonAdapter implements PlatformAdapter {
  readonly id = 'mastodon' as const

  getAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read write',
      state,
    })
    return `${INSTANCE}/oauth/authorize?${params.toString()}`
  }

  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${INSTANCE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: 'read write',
      }),
    })
    if (!res.ok) throw new ApiError(401, `Mastodon token exchange failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { access_token: string }
    // Mastodon access tokens don't expire by default — no refresh token.
    return { accessToken: data.access_token }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    // Mastodon tokens are long-lived; nothing to refresh. Return as-is so the
    // refresh sweep is a no-op for this platform.
    return { accessToken: refreshToken }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const res = await fetch(`${INSTANCE}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(502, `Mastodon profile fetch failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: string; username: string; display_name?: string; avatar?: string }
    return {
      externalAccountId: data.id,
      displayName: data.display_name || `@${data.username}`,
      avatarUrl: data.avatar,
    }
  }

  private async uploadMedia(url: string, accessToken: string): Promise<string> {
    const assetRes = await fetch(url)
    if (!assetRes.ok) throw new ApiError(502, `Failed to fetch media asset: ${url}`)
    const blob = await assetRes.blob()
    // Mastodon (and many Fediverse servers) reject a multipart file part with
    // no filename — derive one from the content-type so uploads don't 422.
    const ext = (blob.type.split('/')[1] || 'bin').split(';')[0]
    const form = new FormData()
    form.append('file', blob, `upload.${ext}`)
    const res = await fetch(`${INSTANCE}/api/v2/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    })
    if (!res.ok) throw new ApiError(502, `Mastodon media upload failed: ${res.status} ${await res.text()}`)
    const { id } = await res.json() as { id: string }
    return id
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const mediaIds = await Promise.all(
      input.media.slice(0, 4).map((m) => this.uploadMedia(m.url, input.accessToken)),
    )
    const res = await fetch(`${INSTANCE}/api/v1/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({
        status: input.caption,
        ...(mediaIds.length ? { media_ids: mediaIds } : {}),
      }),
    })
    if (!res.ok) throw new ApiError(502, `Mastodon post failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { id: string; url: string }
    return { externalPostId: data.id, externalUrl: data.url }
  }
}
