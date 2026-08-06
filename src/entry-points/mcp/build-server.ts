import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PostsService } from '../../domain/features/posts/posts.service.js'
import { SocialAccountRepository } from '../../data-access/repositories/social-account.repository.js'

// This is a trimmed, posting-only MCP server: `list_accounts`, `list_posts`,
// `schedule_post`. The hosted seenpaid.com cloud product's MCP server has two
// more tools — `get_analytics` and `get_top_posts` — which read through the
// closed-source revenue attribution engine (matching Stripe sales back to
// the post that drove them). Those aren't part of this repo — see the
// README's "what this repo is NOT" section.

const PLATFORMS = ['x', 'bluesky', 'linkedin', 'instagram', 'facebook', 'tiktok', 'discord', 'telegram', 'mastodon', 'nostr', 'devto', 'hashnode', 'medium', 'reddit', 'threads', 'tumblr', 'pinterest', 'vk', 'slack', 'wordpress', 'ghost', 'lemmy', 'webhook', 'microblog', 'matrix'] as const

const postsService = new PostsService()
const accountRepo = new SocialAccountRepository()

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })

// Builds a fresh MCP server scoped to the single self-hosted org. Reuses the
// exact same domain services as the REST API.
export function buildMcpServer(ctx: { orgId: string }) {
  const server = new McpServer(
    { name: 'seenpaid', version: '1.0.0' },
    { instructions: 'seenpaid lets you schedule social posts across 25 platforms (X, Bluesky, LinkedIn, Instagram, Facebook, TikTok, Discord, Telegram, Mastodon, and more). Use list_accounts to see connected accounts, list_posts to review recent posts, and schedule_post to publish or schedule new content.' },
  )

  server.registerTool('list_accounts', {
    description: 'List the connected social media accounts (platform, handle, id, status). Use these ids or platforms when scheduling a post.',
    inputSchema: {},
  }, async () => {
    const accounts = await accountRepo.findAllForOrg(ctx.orgId)
    return json(accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.displayName ?? a.externalAccountId, status: a.status })))
  })

  server.registerTool('list_posts', {
    description: 'List recent posts with their status, schedule time and target platforms.',
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Max posts to return (default 20)') },
  }, async ({ limit }) => {
    const posts = await postsService.list(ctx.orgId)
    const rows = posts.slice(-(limit ?? 20)).reverse().map((p) => ({
      id: p.id, caption: p.caption, status: p.status,
      scheduledFor: p.scheduledFor, publishedAt: p.publishedAt, platforms: p.platforms,
    }))
    return json(rows)
  })

  server.registerTool('schedule_post', {
    description: 'Schedule (or immediately publish) a post to one or more connected platforms. Provide a caption plus either account_ids or platforms; omit both to post to every active account. Omit schedule_for to publish now.',
    inputSchema: {
      caption: z.string().min(1).max(3000).describe('The post text'),
      platforms: z.array(z.enum(PLATFORMS)).optional().describe('Which platforms to post to, e.g. ["x","linkedin"]'),
      account_ids: z.array(z.string().uuid()).optional().describe('Specific connected-account ids (from list_accounts). Overrides platforms.'),
      schedule_for: z.string().datetime().optional().describe('ISO-8601 time to publish. Omit to publish immediately.'),
    },
  }, async ({ caption, platforms, account_ids, schedule_for }) => {
    const active = (await accountRepo.findAllForOrg(ctx.orgId)).filter((a) => a.status === 'active')
    let targets = active
    if (account_ids?.length) targets = active.filter((a) => account_ids.includes(a.id))
    else if (platforms?.length) targets = active.filter((a) => platforms.includes(a.platform))
    if (targets.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching active accounts to post to. Call list_accounts to see what is connected.' }], isError: true }
    }
    if (schedule_for && new Date(schedule_for).getTime() <= Date.now()) {
      return { content: [{ type: 'text' as const, text: 'schedule_for must be a future ISO-8601 time. Omit it to publish immediately.' }], isError: true }
    }
    const post = await postsService.create(ctx.orgId, 'mcp', {
      caption,
      mediaIds: [],
      socialAccountIds: targets.map((a) => a.id),
      ...(schedule_for ? { scheduledFor: new Date(schedule_for) } : {}),
    })
    return json({ ok: true, postId: post.id, status: post.status, scheduledFor: post.scheduledFor, postedTo: targets.map((a) => a.platform) })
  })

  return server
}
