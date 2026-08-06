import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const PDS_URL = 'https://bsky.social'

// Build app.bsky.richtext.facet link annotations for every URL in the text.
// Byte offsets are UTF-8 (Buffer.byteLength), not string indices — AT Protocol
// requires byte ranges, and a leading emoji would otherwise misalign them.
// Trailing sentence punctuation is trimmed off the link so a URL ending a
// sentence doesn't swallow the period.
function linkFacets(text: string): Array<{
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }>
}> {
  const facets = []
  const re = /https?:\/\/[^\s]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let url = m[0]
    const trailing = url.match(/[.,;:!?)\]]+$/)
    if (trailing) url = url.slice(0, url.length - trailing[0].length)
    const byteStart = Buffer.byteLength(text.slice(0, m.index), 'utf8')
    const byteEnd = byteStart + Buffer.byteLength(url, 'utf8')
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link' as const, uri: url }],
    })
  }
  return facets
}

interface BlueskySession {
  accessJwt: string
  refreshJwt: string
  handle: string
  did: string
}

// Bluesky (AT Protocol) has no OAuth authorize-redirect flow for the
// classic app-password login this adapter uses — auth is a direct
// identifier + app-password POST to com.atproto.server.createSession.
// `accessToken`/`refreshToken` throughout this adapter map to the
// session's accessJwt/refreshJwt so the storage/refresh plumbing in
// social-account.repository stays identical across platforms.
export class BlueskyAdapter implements PlatformAdapter {
  readonly id = 'bluesky' as const

  getAuthorizeUrl(_state: string, _redirectUri: string): string {
    throw new ApiError(400, 'Bluesky has no OAuth redirect — call POST /api/accounts/bluesky/connect with an app password instead')
  }

  async exchangeCodeForTokens(_code: string, _redirectUri: string): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Bluesky has no OAuth redirect — call POST /api/accounts/bluesky/connect with an app password instead')
  }

  // Not part of PlatformAdapter — Bluesky's dedicated connect route calls
  // this directly with the user's identifier + app password.
  async loginWithAppPassword(identifier: string, appPassword: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
    })
    if (!res.ok) throw new ApiError(401, `Bluesky login failed: ${res.status} ${await res.text()}`)

    const session = await res.json() as BlueskySession
    const profile = await this.fetchAccountProfile(session.accessJwt)

    return {
      tokens: {
        accessToken: session.accessJwt,
        refreshToken: session.refreshJwt,
        // App-password session JWTs are short-lived (~2h); refresh eagerly.
        expiresAt: new Date(Date.now() + 90 * 60 * 1000),
      },
      profile,
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshToken}` },
    })
    if (!res.ok) throw new ApiError(502, `Bluesky session refresh failed: ${res.status} ${await res.text()}`)

    const session = await res.json() as BlueskySession
    return {
      accessToken: session.accessJwt,
      refreshToken: session.refreshJwt,
      expiresAt: new Date(Date.now() + 90 * 60 * 1000),
    }
  }

  async fetchAccountProfile(accessToken: string): Promise<AccountProfile> {
    const { did } = this.decodeSubject(accessToken)
    const res = await fetch(`${PDS_URL}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(502, `Bluesky profile fetch failed: ${res.status} ${await res.text()}`)

    const data = await res.json() as { did: string; handle: string; displayName?: string; avatar?: string }
    // Bluesky returns displayName: "" (not omitted/null) for accounts that
    // never set one, so `??` alone doesn't catch it — falsy check does.
    return {
      externalAccountId: data.did,
      displayName: data.displayName || `@${data.handle}`,
      avatarUrl: data.avatar,
    }
  }

  // AT Proto JWTs are standard JWTs; we only need the `sub` (did) claim and
  // have no need to verify signature here since the token was issued to us
  // moments ago by the PDS over TLS.
  private decodeSubject(jwt: string): { did: string } {
    const payload = jwt.split('.')[1]
    if (!payload) throw new ApiError(500, 'Malformed Bluesky session token')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }
    return { did: decoded.sub }
  }

  private async uploadBlob(url: string, mimeType: string, accessToken: string): Promise<unknown> {
    const assetRes = await fetch(url)
    if (!assetRes.ok) throw new ApiError(502, `Failed to fetch media asset for upload: ${url}`)
    const buffer = Buffer.from(await assetRes.arrayBuffer())

    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType, Authorization: `Bearer ${accessToken}` },
      body: buffer,
    })
    if (!res.ok) throw new ApiError(502, `Bluesky blob upload failed: ${res.status} ${await res.text()}`)

    const { blob } = await res.json() as { blob: unknown }
    return blob
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { did } = this.decodeSubject(input.accessToken)

    let embed: Record<string, unknown> | undefined
    if (input.media.length > 0) {
      const images = await Promise.all(
        input.media.slice(0, 4).map(async (m) => ({
          image: await this.uploadBlob(m.url, m.mimeType, input.accessToken),
          alt: '',
        })),
      )
      embed = { $type: 'app.bsky.embed.images', images }
    }

    // Bluesky renders URLs as plain text unless the post carries "facets" —
    // byte-range annotations marking each URL as a link. Offsets MUST be
    // UTF-8 byte indices (not char indices), so multi-byte characters like
    // emoji before a URL don't shift the link off-target. Without this the
    // tracked /r/ link posts as unclickable text, defeating attribution.
    const facets = linkFacets(input.caption)

    const record = {
      $type: 'app.bsky.feed.post',
      text: input.caption,
      createdAt: new Date().toISOString(),
      ...(facets.length > 0 ? { facets } : {}),
      ...(embed ? { embed } : {}),
    }

    const res = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.accessToken}` },
      body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
    })
    if (!res.ok) throw new ApiError(502, `Bluesky post creation failed: ${res.status} ${await res.text()}`)

    const { uri } = await res.json() as { uri: string }
    // at://did:plc:xxx/app.bsky.feed.post/yyy → rkey is the last segment
    const rkey = uri.split('/').pop()
    return {
      externalPostId: uri,
      externalUrl: `https://bsky.app/profile/${did}/post/${rkey}`,
    }
  }
}
