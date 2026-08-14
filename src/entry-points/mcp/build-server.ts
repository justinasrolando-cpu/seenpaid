import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PostsService } from '../../domain/features/posts/posts.service.js'
import { AccountsService } from '../../domain/features/accounts/accounts.service.js'
import { MediaService } from '../../domain/features/media/media.service.js'
import { SocialAccountRepository } from '../../data-access/repositories/social-account.repository.js'
import { MediaRepository } from '../../data-access/repositories/media.repository.js'
import { CAPTION_LIMITS, REQUIRES_MEDIA, PLATFORM_NOTES } from '../../platforms/capabilities.js'

// A posting-only MCP server — 13 tools, all scheduling mechanics. The hosted
// seenpaid.com cloud product's MCP server has 47: everything here, plus
// revenue attribution (which post earned what), autopilot, experiments,
// recycle, and the in-dashboard AI assistant — all of which read through the
// closed-source Stripe matching engine. None of that is part of this repo.
// See the README's "what this repo is NOT" section, and docs/OPEN_SOURCE_SCOPE.md
// in the private repo this was extracted from for the exact module boundary.

const PLATFORMS = ['x', 'bluesky', 'linkedin', 'instagram', 'facebook', 'tiktok', 'discord', 'telegram', 'mastodon', 'nostr', 'devto', 'hashnode', 'medium', 'reddit', 'threads', 'tumblr', 'pinterest', 'vk', 'slack', 'wordpress', 'ghost', 'lemmy', 'webhook', 'microblog', 'matrix'] as const

const postsService = new PostsService()
const accountsService = new AccountsService()
const mediaService = new MediaService()
const accountRepo = new SocialAccountRepository()
const mediaRepo = new MediaRepository()

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true as const })

// Builds a fresh MCP server scoped to the single self-hosted org. Reuses the
// exact same domain services as the REST API.
export function buildMcpServer(ctx: { orgId: string }) {
  const server = new McpServer(
    { name: 'seenpaid', version: '1.1.0' },
    {
      instructions: `seenpaid lets you schedule social posts across 25 platforms (X, Bluesky, LinkedIn, Instagram, Facebook, TikTok, Discord, Telegram, Mastodon, and more).

Core: list_accounts, list_posts, get_post, schedule_post, bulk_schedule, update_post, cancel_post, delete_post.
Media: list_media, add_media_from_url, generate_image.
Setup: get_connect_url, disconnect_account, get_account_health.
Before-you-publish: get_platform_requirements, validate_post — check these before scheduling to several platforms at once; a caption too long or missing required media fails silently otherwise.`,
    },
  )

  // ── Posting ──────────────────────────────────────────────────────────
  server.registerTool('list_accounts', {
    description: 'List the connected social media accounts (platform, handle, id, status). Use these ids or platforms when scheduling a post.',
    inputSchema: {},
  }, async () => {
    const accounts = await accountRepo.findAllForOrg(ctx.orgId)
    return json(accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.displayName ?? a.externalAccountId, status: a.status })))
  })

  server.registerTool('list_posts', {
    description: 'List posts with status, schedule time, target platforms and any publish errors.',
    inputSchema: {
      status: z.enum(['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled']).optional()
        .describe('Only return posts in this state'),
      limit: z.number().int().min(1).max(100).optional().describe('Max posts to return (default 20)'),
    },
  }, async ({ status, limit }) => {
    const all = await postsService.list(ctx.orgId)
    const filtered = status ? all.filter((p) => p.status === status) : all
    const rows = filtered.slice(-(limit ?? 20)).reverse().map((p) => ({
      id: p.id, caption: p.caption, status: p.status,
      scheduledFor: p.scheduledFor, publishedAt: p.publishedAt, platforms: p.platforms,
      ...(p.errors.length ? { errors: p.errors } : {}),
    }))
    return json({ count: rows.length, totalPosts: all.length, posts: rows })
  })

  server.registerTool('get_post', {
    description: 'Get one post in full.',
    inputSchema: { post_id: z.string().uuid() },
  }, async ({ post_id }) => {
    try { return json(await postsService.get(ctx.orgId, post_id)) }
    catch { return fail(`No post ${post_id} in this account.`) }
  })

  server.registerTool('schedule_post', {
    description: 'Schedule (or immediately publish) a post to one or more connected platforms. Provide a caption plus either account_ids or platforms; omit both to post to every active account. Omit schedule_for to publish now.',
    inputSchema: {
      caption: z.string().min(1).max(3000).describe('The post text'),
      platforms: z.array(z.enum(PLATFORMS)).optional().describe('Which platforms to post to, e.g. ["x","linkedin"]'),
      account_ids: z.array(z.string().uuid()).optional().describe('Specific connected-account ids (from list_accounts). Overrides platforms.'),
      schedule_for: z.string().datetime().optional().describe('ISO-8601 time to publish. Omit to publish immediately.'),
      media_ids: z.array(z.string().uuid()).max(10).optional().describe('Media ids from list_media, add_media_from_url or generate_image'),
    },
  }, async ({ caption, platforms, account_ids, schedule_for, media_ids }) => {
    const t = await resolveTargets(platforms, account_ids)
    if (!t.ok) return fail(t.message)
    if (schedule_for && new Date(schedule_for).getTime() <= Date.now()) {
      return fail('schedule_for must be a future ISO-8601 time. Omit it to publish immediately.')
    }
    const post = await postsService.create(ctx.orgId, 'mcp', {
      caption, mediaIds: media_ids ?? [], socialAccountIds: t.ids,
      ...(schedule_for ? { scheduledFor: new Date(schedule_for) } : {}),
    })
    return json({ ok: true, postId: post.id, status: post.status, scheduledFor: post.scheduledFor, postedTo: t.platforms })
  })

  server.registerTool('bulk_schedule', {
    description: 'Schedule several posts in one call — a content calendar, a week of promos. Each is scheduled independently; if one fails the rest still go through.',
    inputSchema: {
      posts: z.array(z.object({
        caption: z.string().min(1).max(3000),
        schedule_for: z.string().datetime().optional(),
        platforms: z.array(z.enum(PLATFORMS)).optional(),
        media_ids: z.array(z.string().uuid()).max(10).optional(),
      })).min(1).max(50),
    },
  }, async ({ posts }) => {
    const results: { index: number; ok: boolean; postId?: string; error?: string }[] = []
    for (const [index, p] of posts.entries()) {
      try {
        if (p.schedule_for && new Date(p.schedule_for).getTime() <= Date.now()) {
          results.push({ index, ok: false, error: 'schedule_for must be in the future' }); continue
        }
        const t = await resolveTargets(p.platforms, undefined)
        if (!t.ok) { results.push({ index, ok: false, error: t.message }); continue }
        const created = await postsService.create(ctx.orgId, 'mcp', {
          caption: p.caption, mediaIds: p.media_ids ?? [], socialAccountIds: t.ids,
          ...(p.schedule_for ? { scheduledFor: new Date(p.schedule_for) } : {}),
        })
        results.push({ index, ok: true, postId: created.id })
      } catch (err) {
        results.push({ index, ok: false, error: err instanceof Error ? err.message : 'failed' })
      }
    }
    const scheduled = results.filter((r) => r.ok).length
    return json({ scheduled, failed: results.length - scheduled, results })
  })

  server.registerTool('update_post', {
    description: 'Edit a draft or scheduled post\'s caption or time. Published posts cannot be edited.',
    inputSchema: {
      post_id: z.string().uuid(),
      caption: z.string().min(1).max(3000).optional(),
      schedule_for: z.string().datetime().optional(),
    },
  }, async ({ post_id, caption, schedule_for }) => {
    if (!caption && !schedule_for) return fail('Give at least one of caption or schedule_for.')
    if (schedule_for && new Date(schedule_for).getTime() <= Date.now()) return fail('schedule_for must be in the future.')
    try {
      const updated = await postsService.update(ctx.orgId, post_id, {
        ...(caption ? { caption } : {}),
        ...(schedule_for ? { scheduledFor: new Date(schedule_for) } : {}),
      })
      return json({ ok: true, id: updated.id, caption: updated.caption, status: updated.status, scheduledFor: updated.scheduledFor })
    } catch (err) { return fail(err instanceof Error ? err.message : `Could not update ${post_id}.`) }
  })

  server.registerTool('cancel_post', {
    description: 'Cancel a scheduled post before it goes out. Platforms it already published to are untouched.',
    inputSchema: { post_id: z.string().uuid() },
  }, async ({ post_id }) => {
    try { const p = await postsService.cancel(ctx.orgId, post_id); return json({ ok: true, id: p.id, status: p.status }) }
    catch (err) { return fail(err instanceof Error ? err.message : `Could not cancel ${post_id}.`) }
  })

  server.registerTool('delete_post', {
    description: 'Permanently delete a post and cancel any pending publishes. Cannot be undone — prefer cancel_post unless deletion was specifically asked for.',
    inputSchema: { post_id: z.string().uuid(), confirm: z.literal(true).describe('Must be true.') },
  }, async ({ post_id }) => {
    try { await postsService.delete(ctx.orgId, post_id); return json({ ok: true, deleted: post_id }) }
    catch (err) { return fail(err instanceof Error ? err.message : `Could not delete ${post_id}.`) }
  })

  // ── Media ────────────────────────────────────────────────────────────
  server.registerTool('list_media', {
    description: 'The media library, newest first — reuse an existing upload instead of regenerating it.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  }, async ({ limit }) => {
    const rows = await mediaRepo.findAllForOrg(ctx.orgId, limit ?? 25)
    return json({ count: rows.length, media: rows.map((m) => ({ id: m.id, url: m.url, type: m.type, width: m.width, height: m.height })) })
  })

  server.registerTool('add_media_from_url', {
    description: 'Pull a publicly-reachable image or video into the media library (jpeg, png, webp, mp4 or mov; 100MB max).',
    inputSchema: { url: z.string().url() },
  }, async ({ url }) => {
    try {
      const m = await mediaService.ingestFromUrl(ctx.orgId, url)
      return json({ ok: true, mediaId: m.id, url: m.url, type: m.type })
    } catch (err) { return fail(err instanceof Error ? err.message : 'Could not add that media.') }
  })

  server.registerTool('generate_image', {
    description: 'Generate an image from a text prompt (free, keyless) and store it in the media library.',
    inputSchema: { prompt: z.string().min(3).max(1000) },
  }, async ({ prompt }) => {
    try { const m = await mediaService.generateImage(ctx.orgId, prompt); return json({ ok: true, mediaId: m.id, url: m.url }) }
    catch (err) { return fail(err instanceof Error ? err.message : 'Image generation failed.') }
  })

  // ── Setup / health ───────────────────────────────────────────────────
  server.registerTool('get_account_health', {
    description: 'Which connected accounts are healthy and which stopped working. Check before scheduling a big batch — a disconnected account fails silently.',
    inputSchema: {},
  }, async () => {
    const accounts = await accountRepo.findAllForOrg(ctx.orgId)
    const broken = accounts.filter((a) => a.status !== 'active')
    return json({
      healthy: accounts.length - broken.length, broken: broken.length,
      needsAttention: broken.map((a) => ({ id: a.id, platform: a.platform, status: a.status })),
    })
  })

  server.registerTool('get_connect_url', {
    description: 'Get the URL a human needs to open to connect a new social account. OAuth requires a human — hand this link to whoever runs this instance.',
    inputSchema: { platform: z.enum(PLATFORMS), redirect_uri: z.string().url() },
  }, async ({ platform, redirect_uri }) => {
    try {
      const { url } = await accountsService.getAuthorizeUrl(ctx.orgId, platform as never, redirect_uri)
      return json({ ok: true, connectUrl: url })
    } catch (err) { return fail(err instanceof Error ? err.message : `Could not build a connect URL for ${platform}.`) }
  })

  server.registerTool('disconnect_account', {
    description: 'Disconnect a social account. Scheduled posts targeting only that account will stop publishing.',
    inputSchema: { account_id: z.string().uuid(), confirm: z.literal(true).describe('Must be true.') },
  }, async ({ account_id }) => {
    try { await accountsService.disconnect(ctx.orgId, account_id); return json({ ok: true, disconnected: account_id }) }
    catch (err) { return fail(err instanceof Error ? err.message : 'Could not disconnect that account.') }
  })

  // ── Before you publish ───────────────────────────────────────────────
  server.registerTool('get_platform_requirements', {
    description: "What each platform will and won't accept: caption limit, whether media is mandatory, any platform-specific catch.",
    inputSchema: { platforms: z.array(z.enum(PLATFORMS)).optional().describe('Limit to these; omit for all 25') },
  }, async ({ platforms }) => {
    const ids = platforms ?? PLATFORMS
    return json({
      platforms: ids.map((p) => ({
        platform: p,
        captionLimit: CAPTION_LIMITS[p as keyof typeof CAPTION_LIMITS],
        requiresMedia: REQUIRES_MEDIA[p as keyof typeof REQUIRES_MEDIA] ?? false,
        ...(PLATFORM_NOTES[p as keyof typeof PLATFORM_NOTES] ? { caveat: PLATFORM_NOTES[p as keyof typeof PLATFORM_NOTES] } : {}),
      })),
    })
  })

  server.registerTool('validate_post', {
    description: 'Dry-run a caption against the platforms you plan to send it to, WITHOUT publishing. Reports per platform whether it would publish and exactly why not. Call this before schedule_post whenever one caption goes to several platforms.',
    inputSchema: {
      caption: z.string().max(10_000),
      platforms: z.array(z.enum(PLATFORMS)).min(1),
      has_media: z.boolean().optional(),
    },
  }, async ({ caption, platforms, has_media }) => {
    const accounts = await accountRepo.findAllForOrg(ctx.orgId)
    const results = platforms.map((p) => {
      const problems: string[] = []
      const limit = CAPTION_LIMITS[p]
      if (caption.length > limit) problems.push(`Caption is ${caption.length} characters, ${caption.length - limit} over ${p}'s ${limit} limit.`)
      if (REQUIRES_MEDIA[p] && !has_media) problems.push(`${p} rejects text-only posts — attach an image or video.`)
      const acct = accounts.find((a) => a.platform === p)
      if (!acct) problems.push(`No ${p} account is connected.`)
      else if (acct.status !== 'active') problems.push(`The ${p} account needs reconnecting (status: ${acct.status}).`)
      return { platform: p, wouldPublish: problems.length === 0, problems, characterLimit: limit }
    })
    const blocked = results.filter((r) => !r.wouldPublish)
    return json({
      allClear: blocked.length === 0,
      summary: blocked.length === 0 ? `Would publish cleanly to all ${results.length} platform(s).` : `${blocked.length} of ${results.length} platform(s) would fail.`,
      results,
    })
  })

  // Shared targeting logic for schedule_post / bulk_schedule.
  async function resolveTargets(
    platforms?: readonly string[], accountIds?: string[],
  ): Promise<{ ok: true; ids: string[]; platforms: string[] } | { ok: false; message: string }> {
    const all = await accountRepo.findAllForOrg(ctx.orgId)
    const active = all.filter((a) => a.status === 'active')
    if (active.length === 0) return { ok: false, message: 'No active accounts. Call get_connect_url to connect one.' }

    let targets = active
    if (accountIds?.length) {
      targets = active.filter((a) => accountIds.includes(a.id))
      if (targets.length === 0) return { ok: false, message: 'None of those account_ids are active. Call list_accounts for current ids.' }
    } else if (platforms?.length) {
      targets = active.filter((a) => platforms.includes(a.platform))
      if (targets.length === 0) {
        return { ok: false, message: `No active account for ${platforms.join(', ')}. Connected: ${[...new Set(active.map((a) => a.platform))].join(', ')}.` }
      }
    }
    return { ok: true, ids: targets.map((a) => a.id), platforms: [...new Set(targets.map((a) => a.platform))] }
  }

  return server
}
