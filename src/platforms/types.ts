export type PlatformId = 'x' | 'bluesky' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok' | 'discord' | 'telegram' | 'mastodon' | 'nostr' | 'devto' | 'hashnode' | 'medium' | 'reddit' | 'threads' | 'tumblr' | 'pinterest' | 'vk' | 'slack' | 'wordpress' | 'ghost' | 'lemmy' | 'webhook' | 'microblog' | 'matrix'

export interface MediaAsset {
  url: string
  mimeType: string
  type: 'image' | 'video'
}

export interface PublishInput {
  caption: string
  media: MediaAsset[]
  accessToken: string       // decrypted, short-lived per-call
  externalAccountId: string // platform user/page id
  // X BYOK (Bring-Your-Own-Key): when present, the X adapter signs each request
  // with OAuth 1.0a using the user's own X app keys instead of `accessToken`.
  oauth1?: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string }
}

export interface PublishResult {
  externalPostId: string
  externalUrl: string
}

export interface OAuthTokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scope?: string
}

export interface AccountProfile {
  externalAccountId: string
  displayName: string
  avatarUrl?: string
}

// One adapter per platform, isolated behind this interface so the
// scheduler/domain layer never branches on platform-specific SDKs.
export interface PlatformAdapter {
  readonly id: PlatformId

  getAuthorizeUrl(state: string, redirectUri: string): string
  // `state` is passed back for adapters that need to correlate the callback
  // with per-attempt data generated in getAuthorizeUrl (e.g. X's PKCE verifier).
  exchangeCodeForTokens(code: string, redirectUri: string, state?: string): Promise<OAuthTokenSet>
  refreshTokens(refreshToken: string): Promise<OAuthTokenSet>
  fetchAccountProfile(accessToken: string): Promise<AccountProfile>

  publish(input: PublishInput): Promise<PublishResult>
}
