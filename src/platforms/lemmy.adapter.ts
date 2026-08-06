// ─────────────────────────────────────────────────────────────────────────
// Lemmy adapter — per-instance username/password login (no OAuth). Self-serve:
// the user gives their instance URL, login, password, and a target community
// (e.g. "technology" or "technology@lemmy.world"). We log in once, store the
// returned session token (never the password) + the resolved community id, and
// post there. Lemmy posts need a title → caption's first line is the title.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import { splitTitleBody } from './devto.adapter.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

function normalizeSite(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, '')
}

export class LemmyAdapter implements PlatformAdapter {
  readonly id = 'lemmy' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Lemmy connects with instance credentials, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Lemmy connects with instance credentials, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // session token; reconnect if invalidated
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Lemmy profile is set at connect time')
  }

  // Log in, resolve the community id, and store "instance|jwt|communityId" as
  // the credential. externalAccountId encodes the community for display.
  async connectLogin(
    instanceUrl: string, username: string, password: string, community: string,
  ): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const site = normalizeSite(instanceUrl)
    const loginRes = await fetch(`${site}/api/v3/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username_or_email: username, password }),
    })
    if (!loginRes.ok) throw new ApiError(401, `Lemmy login failed: ${loginRes.status} ${await loginRes.text()}`)
    const { jwt } = await loginRes.json() as { jwt?: string }
    if (!jwt) throw new ApiError(401, 'Lemmy login did not return a session token')

    const commRes = await fetch(`${site}/api/v3/community?name=${encodeURIComponent(community)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!commRes.ok) throw new ApiError(400, `Lemmy community "${community}" not found: ${commRes.status}`)
    const commData = await commRes.json() as { community_view?: { community: { id: number; title?: string } } }
    const comm = commData.community_view?.community
    if (!comm) throw new ApiError(400, `Lemmy community "${community}" not found`)

    return {
      tokens: { accessToken: `${site}|${jwt}|${comm.id}` },
      profile: {
        externalAccountId: `${comm.id}`,
        displayName: `${comm.title ?? community} · ${site.replace(/^https?:\/\//, '')}`,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const [site = '', jwt = '', communityId = ''] = input.accessToken.split('|')
    const { title, body } = splitTitleBody(input.caption)
    const image = input.media.find((m) => m.type === 'image')

    const res = await fetch(`${site}/api/v3/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: title.slice(0, 200),
        body,
        community_id: Number(communityId),
        ...(image ? { url: image.url } : {}),
      }),
    })
    if (!res.ok) throw new ApiError(502, `Lemmy publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { post_view?: { post: { id: number; ap_id: string } } }
    const post = data.post_view?.post
    return { externalPostId: String(post?.id ?? ''), externalUrl: post?.ap_id ?? site }
  }
}
