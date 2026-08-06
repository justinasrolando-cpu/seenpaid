import {
  pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, uniqueIndex, index,
} from 'drizzle-orm/pg-core'

// ── Enums ────────────────────────────────────────────────────────────────

export const platformEnum = pgEnum('platform', [
  'x', 'bluesky', 'linkedin', 'instagram', 'facebook', 'tiktok', 'discord', 'telegram', 'mastodon', 'nostr', 'devto', 'hashnode', 'medium', 'reddit', 'threads', 'tumblr', 'pinterest', 'vk', 'slack', 'wordpress', 'ghost', 'lemmy', 'webhook', 'microblog', 'matrix',
])
export const postStatusEnum = pgEnum('post_status', [
  'draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled',
])
export const postTargetStatusEnum = pgEnum('post_target_status', [
  'pending', 'publishing', 'published', 'failed',
])
export const mediaTypeEnum = pgEnum('media_type', ['image', 'video'])

// ── Tenancy ──────────────────────────────────────────────────────────────
//
// seenpaid is single-operator self-hosted software — there is no
// multi-tenant/billing concept here (the hosted seenpaid.com cloud has that
// layer; this repo doesn't). `organizations` is kept as a single fixed row
// purely so the rest of the schema (which is org-scoped by convention, same
// shape as the upstream cloud product) doesn't need bespoke single-row
// tables. See src/auth/single-user.ts for how the one row is created/used.
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().default('My Workspace'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Connected social accounts ───────────────────────────────────────────

// One connected account per platform (e.g. your X handle). OAuth tokens are
// stored separately so they can be encrypted/rotated independently of the
// account's display metadata.
export const socialAccounts = pgTable('social_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  platform: platformEnum('platform').notNull(),
  externalAccountId: text('external_account_id').notNull(), // platform's user/page id
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  status: text('status', { enum: ['active', 'reauth_required', 'disconnected'] })
    .notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgPlatformExternalUnique: uniqueIndex('social_accounts_org_platform_external_unique')
    .on(t.orgId, t.platform, t.externalAccountId),
  orgIdx: index('social_accounts_org_idx').on(t.orgId),
}))

// Tokens kept in a separate table: never joined into list queries, encrypted
// at rest at the application layer before insert (see src/auth/crypto.ts).
export const oauthTokens = pgTable('oauth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  socialAccountId: uuid('social_account_id').notNull()
    .references(() => socialAccounts.id, { onDelete: 'cascade' }).unique(),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  scope: text('scope'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ── Media ────────────────────────────────────────────────────────────────

export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  type: mediaTypeEnum('type').notNull(),
  r2Key: text('r2_key').notNull(),
  url: text('url').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  durationSeconds: integer('duration_seconds'), // video only
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index('media_org_idx').on(t.orgId),
}))

// ── Posts ────────────────────────────────────────────────────────────────

// A "post" is the single source of content (caption + media); each platform
// it's cross-posted to gets its own post_targets row so per-platform publish
// state and errors can be tracked independently.
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // No `users` table in single-operator mode — this is a free-text label
  // ("api", "mcp:<key-name>", etc.) for who/what created the post, not an FK.
  createdBy: text('created_by').notNull().default('self-host'),
  caption: text('caption').notNull().default(''),
  mediaIds: jsonb('media_ids').$type<string[]>().notNull().default([]),
  status: postStatusEnum('status').notNull().default('draft'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index('posts_org_idx').on(t.orgId),
  scheduledIdx: index('posts_scheduled_idx').on(t.scheduledFor),
}))

export const postTargets = pgTable('post_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  postId: uuid('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  socialAccountId: uuid('social_account_id').notNull()
    .references(() => socialAccounts.id, { onDelete: 'cascade' }),
  platform: platformEnum('platform').notNull(),
  // Per-platform caption override. NULL = use the parent post's shared
  // caption; a value here is published to THIS target instead.
  caption: text('caption'),
  status: postTargetStatusEnum('status').notNull().default('pending'),
  externalPostId: text('external_post_id'), // id returned by the platform once published
  externalUrl: text('external_url'),
  errorMessage: text('error_message'),
  bullJobId: text('bull_job_id'), // for dedup / cancellation lookups
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  postIdx: index('post_targets_post_idx').on(t.postId),
  socialAccountIdx: index('post_targets_social_account_idx').on(t.socialAccountId),
}))

export type Organization = typeof organizations.$inferSelect
export type NewOrganization = typeof organizations.$inferInsert
export type SocialAccount = typeof socialAccounts.$inferSelect
export type NewSocialAccount = typeof socialAccounts.$inferInsert
export type OauthToken = typeof oauthTokens.$inferSelect
export type NewOauthToken = typeof oauthTokens.$inferInsert
export type Media = typeof media.$inferSelect
export type NewMedia = typeof media.$inferInsert
export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type PostTarget = typeof postTargets.$inferSelect
export type NewPostTarget = typeof postTargets.$inferInsert
