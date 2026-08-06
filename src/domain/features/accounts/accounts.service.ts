import { randomBytes } from 'node:crypto'
import { SocialAccountRepository } from '../../../data-access/repositories/social-account.repository.js'
import { encryptToken } from '../../../auth/crypto.js'
import { getPlatformAdapter } from '../../../platforms/registry.js'
import { XAdapter } from '../../../platforms/x.adapter.js'
import { BlueskyAdapter } from '../../../platforms/bluesky.adapter.js'
import { DiscordAdapter } from '../../../platforms/discord.adapter.js'
import { TelegramAdapter } from '../../../platforms/telegram.adapter.js'
import { NostrAdapter } from '../../../platforms/nostr.adapter.js'
import { DevtoAdapter } from '../../../platforms/devto.adapter.js'
import { HashnodeAdapter } from '../../../platforms/hashnode.adapter.js'
import { MediumAdapter } from '../../../platforms/medium.adapter.js'
import { SlackAdapter } from '../../../platforms/slack.adapter.js'
import { WordpressAdapter } from '../../../platforms/wordpress.adapter.js'
import { GhostAdapter } from '../../../platforms/ghost.adapter.js'
import { LemmyAdapter } from '../../../platforms/lemmy.adapter.js'
import { WebhookAdapter } from '../../../platforms/webhook.adapter.js'
import { MicroblogAdapter } from '../../../platforms/microblog.adapter.js'
import { MatrixAdapter } from '../../../platforms/matrix.adapter.js'
import { ApiError } from '../../../errors/index.js'
import type { ConnectAccountCallbackDto, ConnectBlueskyDto, ConnectDiscordDto, ConnectTelegramDto, ConnectNostrDto, ConnectDevtoDto, ConnectHashnodeDto, ConnectMediumDto, ConnectSlackDto, ConnectWordpressDto, ConnectGhostDto, ConnectLemmyDto, ConnectWebhookDto, ConnectMicroblogDto, ConnectMatrixDto, ConnectXByokDto } from './dto.js'
import type { AccountProfile, OAuthTokenSet, PlatformId } from '../../../platforms/types.js'
import type { SocialAccount } from '../../../data-access/schema/index.js'

// NOTE on what's missing vs. the hosted seenpaid.com cloud product this was
// extracted from: the cloud version gates connect flows behind
// `assertOrgActive`/`assertWithinAccountLimit` (plan-tier + connected-account
// caps checked against Stripe billing state). Self-hosters aren't on a
// metered plan, so those calls are simply not present here. There is no
// account-count limit in this repo.

const socialAccountRepo = new SocialAccountRepository()

// OAuth `state` values issued, kept until the matching callback consumes
// them. Verifying the callback's state against one actually minted is CSRF
// protection for account-linking. In-memory is fine for a single-instance
// self-hosted deploy; move to Redis if you ever run more than one API
// instance. Entries carry a TTL and abandoned ones are swept on write so the
// map can't grow unbounded.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const issuedOAuthStates = new Map<string, { orgId: string; expiresAt: number }>()

function rememberOAuthState(state: string, orgId: string): void {
  const now = Date.now()
  for (const [key, entry] of issuedOAuthStates) {
    if (entry.expiresAt < now) issuedOAuthStates.delete(key)
  }
  issuedOAuthStates.set(state, { orgId, expiresAt: now + OAUTH_STATE_TTL_MS })
}

function consumeOAuthState(state: string | undefined, orgId: string): void {
  if (!state) throw new ApiError(400, 'Missing OAuth state')
  const entry = issuedOAuthStates.get(state)
  issuedOAuthStates.delete(state)
  if (!entry || entry.expiresAt < Date.now() || entry.orgId !== orgId) {
    throw new ApiError(400, 'Invalid or expired OAuth state')
  }
}

export class AccountsService {
  list(orgId: string): Promise<SocialAccount[]> {
    return socialAccountRepo.findAllForOrg(orgId)
  }

  // `state` is an opaque, per-attempt random token (CSRF protection + PKCE
  // correlation for adapters that need it, e.g. X). It's remembered bound to
  // this org and verified on the way back in connect(); the frontend must
  // echo it back unchanged in the /callback request.
  async getAuthorizeUrl(orgId: string, platform: PlatformId, redirectUri: string): Promise<{ url: string; state: string }> {
    const state = randomBytes(24).toString('hex')
    rememberOAuthState(state, orgId)
    const url = getPlatformAdapter(platform).getAuthorizeUrl(state, redirectUri)
    return { url, state }
  }

  // Completes an OAuth callback: verifies the state issued, exchanges the
  // code, fetches the platform profile, stores the account + encrypted tokens.
  async connect(orgId: string, dto: ConnectAccountCallbackDto): Promise<SocialAccount> {
    consumeOAuthState(dto.state, orgId)
    const adapter = getPlatformAdapter(dto.platform)
    const tokens = await adapter.exchangeCodeForTokens(dto.code, dto.redirectUri, dto.state)
    const profile = await adapter.fetchAccountProfile(tokens.accessToken)
    return this.persistAccount(orgId, dto.platform, profile, tokens)
  }

  // X BYOK: the user pastes their own X app's 4 OAuth 1.0a keys. Validated
  // against /2/users/me (which also gives us the @handle) and stored all
  // four as an encrypted `byok1:` blob in the account's access-token slot —
  // the publish job unpacks it back into OAuth 1.0a signing.
  async connectXByok(orgId: string, dto: ConnectXByokDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('x') as XAdapter
    const profile = await adapter.fetchProfileWithByok(dto)
    return this.persistAccount(orgId, 'x', profile, { accessToken: `byok1:${JSON.stringify(dto)}` })
  }

  // Bluesky has no OAuth redirect for app-password login — separate entry
  // point that skips straight to session creation.
  async connectBluesky(orgId: string, dto: ConnectBlueskyDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('bluesky') as BlueskyAdapter
    const { tokens, profile } = await adapter.loginWithAppPassword(dto.identifier, dto.appPassword)
    return this.persistAccount(orgId, 'bluesky', profile, tokens)
  }

  // Discord connects with a pasted channel webhook URL (no OAuth) — validate
  // it, read the channel name, and store the URL as the credential.
  async connectDiscord(orgId: string, dto: ConnectDiscordDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('discord') as DiscordAdapter
    const { tokens, profile } = await adapter.connectWebhook(dto.webhookUrl)
    return this.persistAccount(orgId, 'discord', profile, tokens)
  }

  // Telegram connects with a bot token (@BotFather) + a target channel id —
  // validate the bot can reach the channel, then store the token as the
  // credential and the chat id as the account's externalAccountId.
  async connectTelegram(orgId: string, dto: ConnectTelegramDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('telegram') as TelegramAdapter
    const { tokens, profile } = await adapter.connectBot(dto.botToken, dto.chatId)
    return this.persistAccount(orgId, 'telegram', profile, tokens)
  }

  // Nostr connects with a pasted private key (nsec/hex) — validate it, derive
  // the public identity, and store the key as the credential.
  async connectNostr(orgId: string, dto: ConnectNostrDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('nostr') as NostrAdapter
    const { tokens, profile } = await adapter.connectKey(dto.privateKey)
    return this.persistAccount(orgId, 'nostr', profile, tokens)
  }

  // Article platforms — key/token connect flows (no OAuth).
  async connectDevto(orgId: string, dto: ConnectDevtoDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('devto') as DevtoAdapter
    const { tokens, profile } = await adapter.connectApiKey(dto.apiKey)
    return this.persistAccount(orgId, 'devto', profile, tokens)
  }

  async connectHashnode(orgId: string, dto: ConnectHashnodeDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('hashnode') as HashnodeAdapter
    const { tokens, profile } = await adapter.connectPat(dto.token, dto.publicationId)
    return this.persistAccount(orgId, 'hashnode', profile, tokens)
  }

  async connectMedium(orgId: string, dto: ConnectMediumDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('medium') as MediumAdapter
    const { tokens, profile } = await adapter.connectToken(dto.token)
    return this.persistAccount(orgId, 'medium', profile, tokens)
  }

  // Slack connects with a pasted Incoming Webhook URL (no OAuth).
  async connectSlack(orgId: string, dto: ConnectSlackDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('slack') as SlackAdapter
    const { tokens, profile } = await adapter.connectWebhook(dto.webhookUrl)
    return this.persistAccount(orgId, 'slack', profile, tokens)
  }

  // WordPress connects with a site URL + username + Application Password.
  async connectWordpress(orgId: string, dto: ConnectWordpressDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('wordpress') as WordpressAdapter
    const { tokens, profile } = await adapter.connectAppPassword(dto.siteUrl, dto.username, dto.appPassword)
    return this.persistAccount(orgId, 'wordpress', profile, tokens)
  }

  // Ghost connects with a site URL + Admin API key.
  async connectGhost(orgId: string, dto: ConnectGhostDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('ghost') as GhostAdapter
    const { tokens, profile } = await adapter.connectAdminKey(dto.siteUrl, dto.adminKey)
    return this.persistAccount(orgId, 'ghost', profile, tokens)
  }

  // Lemmy connects with instance credentials + a target community.
  async connectLemmy(orgId: string, dto: ConnectLemmyDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('lemmy') as LemmyAdapter
    const { tokens, profile } = await adapter.connectLogin(dto.instanceUrl, dto.username, dto.password, dto.community)
    return this.persistAccount(orgId, 'lemmy', profile, tokens)
  }

  // Webhook connects with any https URL (+ optional signing secret).
  async connectWebhook(orgId: string, dto: ConnectWebhookDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('webhook') as WebhookAdapter
    const { tokens, profile } = await adapter.connectUrl(dto.url, dto.secret)
    return this.persistAccount(orgId, 'webhook', profile, tokens)
  }

  // Micro.blog connects with an app token.
  async connectMicroblog(orgId: string, dto: ConnectMicroblogDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('microblog') as MicroblogAdapter
    const { tokens, profile } = await adapter.connectToken(dto.token)
    return this.persistAccount(orgId, 'microblog', profile, tokens)
  }

  // Matrix connects with a homeserver + access token + room id.
  async connectMatrix(orgId: string, dto: ConnectMatrixDto): Promise<SocialAccount> {
    const adapter = getPlatformAdapter('matrix') as MatrixAdapter
    const { tokens, profile } = await adapter.connectToken(dto.homeserver, dto.accessToken, dto.roomId)
    return this.persistAccount(orgId, 'matrix', profile, tokens)
  }

  private async persistAccount(
    orgId: string, platform: PlatformId, profile: AccountProfile, tokens: OAuthTokenSet,
  ): Promise<SocialAccount> {
    // Reconnecting (e.g. after reauth_required) hits the same
    // (orgId, platform, externalAccountId) unique key — update in place
    // rather than letting the insert fail on the constraint.
    const existing = await socialAccountRepo.findByExternal(orgId, platform, profile.externalAccountId)

    let account: SocialAccount
    if (existing) {
      account = (await socialAccountRepo.update(orgId, existing.id, {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        status: 'active',
      }))!
    } else {
      account = await socialAccountRepo.create({
        orgId,
        platform,
        externalAccountId: profile.externalAccountId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        status: 'active',
      })
    }

    await socialAccountRepo.upsertTokens(account.id, {
      accessTokenEnc: encryptToken(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })

    return account
  }

  async disconnect(orgId: string, id: string): Promise<void> {
    const account = await socialAccountRepo.findById(orgId, id)
    if (!account) throw new ApiError(404, 'Social account not found')
    await socialAccountRepo.delete(orgId, id)
  }
}
