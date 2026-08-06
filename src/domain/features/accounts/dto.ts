import { z } from 'zod'
import { PlatformIdSchema } from '../posts/dto.js'

export const ConnectAccountCallbackSchema = z.object({
  platform: PlatformIdSchema,
  code: z.string().min(1),
  redirectUri: z.string().url(),
  state: z.string().min(1).optional(),
})
export type ConnectAccountCallbackDto = z.infer<typeof ConnectAccountCallbackSchema>

export const ConnectBlueskySchema = z.object({
  identifier: z.string().min(1), // handle or email
  appPassword: z.string().min(1),
})
export type ConnectBlueskyDto = z.infer<typeof ConnectBlueskySchema>

// Discord connects via a channel webhook URL the user pastes.
export const ConnectDiscordSchema = z.object({
  webhookUrl: z.string().url(),
})
export type ConnectDiscordDto = z.infer<typeof ConnectDiscordSchema>

// Telegram connects with a bot token (@BotFather) + the target channel id.
export const ConnectTelegramSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1), // @channelname or numeric id
})
export type ConnectTelegramDto = z.infer<typeof ConnectTelegramSchema>

// Nostr connects with a private key (nsec1… or 64-char hex) — no OAuth.
export const ConnectNostrSchema = z.object({
  privateKey: z.string().min(1),
})
export type ConnectNostrDto = z.infer<typeof ConnectNostrSchema>

// X BYOK: the user pastes their own X app's 4 OAuth 1.0a keys (API key/secret
// + access token/secret) — reliable posting without a shared X app.
export const ConnectXByokSchema = z.object({
  consumerKey: z.string().min(1),
  consumerSecret: z.string().min(1),
  token: z.string().min(1),
  tokenSecret: z.string().min(1),
})
export type ConnectXByokDto = z.infer<typeof ConnectXByokSchema>

// Article platforms — all key/token based, no OAuth.
export const ConnectDevtoSchema = z.object({ apiKey: z.string().min(1) })
export type ConnectDevtoDto = z.infer<typeof ConnectDevtoSchema>

export const ConnectHashnodeSchema = z.object({
  token: z.string().min(1),
  publicationId: z.string().min(1),
})
export type ConnectHashnodeDto = z.infer<typeof ConnectHashnodeSchema>

export const ConnectMediumSchema = z.object({ token: z.string().min(1) })
export type ConnectMediumDto = z.infer<typeof ConnectMediumSchema>

// Slack connects via an Incoming Webhook URL (no OAuth), like Discord.
export const ConnectSlackSchema = z.object({ webhookUrl: z.string().url() })
export type ConnectSlackDto = z.infer<typeof ConnectSlackSchema>

// WordPress connects with a site URL + username + Application Password.
export const ConnectWordpressSchema = z.object({
  siteUrl: z.string().url(),
  username: z.string().min(1),
  appPassword: z.string().min(1),
})
export type ConnectWordpressDto = z.infer<typeof ConnectWordpressSchema>

// Ghost connects with a site URL + Admin API key (id:secret).
export const ConnectGhostSchema = z.object({
  siteUrl: z.string().url(),
  adminKey: z.string().min(1),
})
export type ConnectGhostDto = z.infer<typeof ConnectGhostSchema>

// Lemmy connects with instance credentials + a target community.
export const ConnectLemmySchema = z.object({
  instanceUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  community: z.string().min(1),
})
export type ConnectLemmyDto = z.infer<typeof ConnectLemmySchema>

// Webhook connects with any https URL + an optional signing secret.
export const ConnectWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
})
export type ConnectWebhookDto = z.infer<typeof ConnectWebhookSchema>

// Micro.blog connects with an app token.
export const ConnectMicroblogSchema = z.object({ token: z.string().min(1) })
export type ConnectMicroblogDto = z.infer<typeof ConnectMicroblogSchema>

// Matrix connects with a homeserver URL + access token + room id.
export const ConnectMatrixSchema = z.object({
  homeserver: z.string().url(),
  accessToken: z.string().min(1),
  roomId: z.string().min(1),
})
export type ConnectMatrixDto = z.infer<typeof ConnectMatrixSchema>
