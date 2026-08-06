// ─────────────────────────────────────────────────────────────────────────
// Matrix adapter — access-token based, no OAuth. Self-serve: the user gives
// their homeserver URL, an access token (Element → Settings → Help & About →
// Access Token), and a room ID; posts are sent to that room.
//
// Credential is stored as "homeserver|accessToken"; the room ID is the
// account's externalAccountId (the publish target).
// ─────────────────────────────────────────────────────────────────────────
import { ApiError } from '../errors/index.js'
import type {
  AccountProfile, OAuthTokenSet, PlatformAdapter, PublishInput, PublishResult,
} from './types.js'

function normalizeHost(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export class MatrixAdapter implements PlatformAdapter {
  readonly id = 'matrix' as const

  getAuthorizeUrl(): string {
    throw new ApiError(400, 'Matrix connects with an access token, not OAuth')
  }

  async exchangeCodeForTokens(): Promise<OAuthTokenSet> {
    throw new ApiError(400, 'Matrix connects with an access token, not OAuth')
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    return { accessToken: refreshToken } // access token; reconnect if revoked
  }

  async fetchAccountProfile(): Promise<AccountProfile> {
    throw new ApiError(400, 'Matrix profile is set at connect time')
  }

  // Validate the token (whoami) and capture the target room.
  async connectToken(
    homeserver: string, accessToken: string, roomId: string,
  ): Promise<{ tokens: OAuthTokenSet; profile: AccountProfile }> {
    const hs = normalizeHost(homeserver)
    const res = await fetch(`${hs}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new ApiError(401, `Matrix token rejected: ${res.status}`)
    const data = await res.json() as { user_id?: string }
    return {
      tokens: { accessToken: `${hs}|${accessToken}` },
      profile: {
        externalAccountId: roomId,
        displayName: `${data.user_id ?? 'Matrix'} · ${roomId}`,
      },
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const [hs = '', token = ''] = input.accessToken.split('|')
    const roomId = input.externalAccountId
    const image = input.media.find((m) => m.type === 'image')
    const bodyText = image ? `${input.caption}\n${image.url}` : input.caption
    const txnId = `seenpaid-${Date.now()}`

    const res = await fetch(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: bodyText }),
      },
    )
    if (!res.ok) throw new ApiError(502, `Matrix publish failed: ${res.status} ${await res.text()}`)
    const data = await res.json() as { event_id?: string }
    const eventId = data.event_id ?? ''
    return { externalPostId: eventId, externalUrl: `https://matrix.to/#/${roomId}/${eventId}` }
  }
}
