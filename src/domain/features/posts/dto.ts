import { z } from 'zod'

export const PlatformIdSchema = z.enum(['x', 'bluesky', 'linkedin', 'instagram', 'facebook', 'tiktok', 'discord', 'telegram', 'mastodon', 'nostr', 'devto', 'hashnode', 'medium', 'reddit', 'threads', 'tumblr', 'pinterest', 'vk', 'slack', 'wordpress', 'ghost', 'lemmy', 'webhook', 'microblog', 'matrix'])

export const CreatePostSchema = z.object({
  caption: z.string().max(3000).trim(),
  mediaIds: z.array(z.string().uuid()).max(10).default([]),
  // Duplicates would otherwise create two post_targets rows for the same
  // social account — two independent BullMQ jobs double-publishing the
  // same post to the same platform account.
  socialAccountIds: z.array(z.string().uuid())
    .min(1, 'Select at least one account to post to')
    .refine((ids) => new Set(ids).size === ids.length, 'socialAccountIds must not contain duplicates'),
  // Omit scheduledFor to publish immediately. Uses a lazy Date.now() floor
  // (evaluated per-parse) — a `.min(new Date())` would freeze the cutoff at
  // module-load time and drift ever more permissive as the process runs.
  scheduledFor: z.coerce.date().refine((d) => d.getTime() > Date.now(), 'scheduledFor must be in the future').optional(),
  // Optional per-account caption overrides: { socialAccountId -> caption }.
  // Any account not listed falls back to the shared `caption`. Keys are
  // validated against socialAccountIds in the service.
  captions: z.record(z.string().uuid(), z.string().max(3000)).optional(),
})
export type CreatePostDto = z.infer<typeof CreatePostSchema>

export const UpdatePostSchema = z.object({
  caption: z.string().max(3000).trim().optional(),
  scheduledFor: z.coerce.date().refine((d) => d.getTime() > Date.now(), 'scheduledFor must be in the future').optional(),
})
export type UpdatePostDto = z.infer<typeof UpdatePostSchema>
