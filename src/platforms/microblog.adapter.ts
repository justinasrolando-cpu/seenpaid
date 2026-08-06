// ─────────────────────────────────────────────────────────────────────────
// Micro.blog adapter — app-token based (Micropub standard), no OAuth. Self-
// serve: the user pastes an app token from micro.blog → Account → App tokens,
// and can publish short posts immediately.
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

const MICROPUB = 'https://micro.blog/micropub'

export class MicroblogAdapter implements PlatformAdapter {
  readonly id = 'microblog' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Micro.blog connects with an app token, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Micro.blog connects with an app token, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // app tokens don't auto-expire
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Micro.blog profile is set at connect time')
  }

  // Validate the token against the Micropub config endpoint.
  async connectToken(token: string): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const res = await fetch(`${MICROPUB}?q=config`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new ApiError(401, `Micro.blog token rejected: ${res.status}`)
    return {
      tokens: { accessToken: token },
      profile: { externalAccountId: 'microblog', displayName: 'Micro.blog' },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const body = new URLSearchParams({ h: 'entry', content: input.caption })
    for (const m of input.media.filter((x) => x.type === 'image')) body.append('photo[]', m.url)

    const res = await fetch(MICROPUB, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (res.status !== 201 && res.status !== 202 && !res.ok) {
      throw new ApiError(502, `Micro.blog publish failed: ${res.status} ${await res.text()}`)
    }
    const url = res.headers.get('Location') ?? 'https://micro.blog/'
    return { externalPostId: url, externalUrl: url }
  }
}
