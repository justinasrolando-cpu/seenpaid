import { PostRepository } from '../../../data-access/repositories/post.repository.js'
import { SocialAccountRepository } from '../../../data-access/repositories/social-account.repository.js'
import { MediaRepository } from '../../../data-access/repositories/media.repository.js'
import { schedulePublish, cancelPublish } from '../../../jobs/queue.js'
import { ApiError } from '../../../errors/index.js'
import type { CreatePostDto, UpdatePostDto } from './dto.js'
import type { Post } from '../../../data-access/schema/index.js'

// NOTE on what's missing vs. the hosted seenpaid.com cloud product this was
// extracted from: the cloud version gates `create()` behind
// `assertOrgActive`/`assertWithinAccountLimit` (plan-tier checks against
// Stripe billing state). Self-hosters don't have a plan to be gated by, so
// those calls are simply not present here.

const postRepo = new PostRepository()
const socialAccountRepo = new SocialAccountRepository()
const mediaRepo = new MediaRepository()

export class PostsService {
  async list(orgId: string): Promise<(Post & { platforms: string[]; errors: string[] })[]> {
    const [rows, targets] = await Promise.all([
      postRepo.findAllForOrg(orgId),
      postRepo.platformsForOrg(orgId),
    ])
    const byPost = new Map<string, Set<string>>()
    // Per-post failure reasons, so a "failed" post card can explain itself
    // rather than being a dead badge the user can't act on. Prefixed with the
    // platform since a post can fan out to several and only some may fail.
    const errorsByPost = new Map<string, string[]>()
    for (const t of targets) {
      const set = byPost.get(t.postId) ?? new Set<string>()
      set.add(t.platform)
      byPost.set(t.postId, set)

      if (t.status === 'failed') {
        const list = errorsByPost.get(t.postId) ?? []
        list.push(`${t.platform}: ${t.errorMessage ?? 'Publishing failed (no detail recorded)'}`)
        errorsByPost.set(t.postId, list)
      }
    }
    return rows.map((p) => ({
      ...p,
      platforms: [...(byPost.get(p.id) ?? [])],
      errors: errorsByPost.get(p.id) ?? [],
    }))
  }

  async get(orgId: string, id: string): Promise<Post> {
    const post = await postRepo.findById(orgId, id)
    if (!post) throw new ApiError(404, 'Post not found')
    return post
  }

  // Creates the post and, per selected account, a post_target row + a
  // scheduled BullMQ job. "Publish now" is just scheduledFor = now.
  async create(orgId: string, createdBy: string, dto: CreatePostDto): Promise<Post> {
    const accounts = await Promise.all(
      dto.socialAccountIds.map((id) => socialAccountRepo.findById(orgId, id)),
    )
    const missing = accounts.findIndex((a) => !a)
    if (missing !== -1) throw new ApiError(404, `Social account ${dto.socialAccountIds[missing]} not found`)

    // mediaIds are jsonb (no FK) and org-scoped only via this check — without
    // it, a mediaId belonging to another org (or a typo'd/nonexistent one)
    // would silently pass through and get dropped at publish time
    // (mediaRepo.findByIds(orgId, ...) filters it out), publishing the post
    // with missing media instead of failing loudly at creation time.
    if (dto.mediaIds.length > 0) {
      const media = await mediaRepo.findByIds(orgId, dto.mediaIds)
      if (media.length !== dto.mediaIds.length) {
        const foundIds = new Set(media.map((m) => m.id))
        const missingMediaId = dto.mediaIds.find((id) => !foundIds.has(id))
        throw new ApiError(404, `Media ${missingMediaId} not found`)
      }
    }

    const runAt = dto.scheduledFor ?? new Date()

    const post = await postRepo.create({
      orgId,
      createdBy,
      caption: dto.caption,
      mediaIds: dto.mediaIds,
      status: dto.scheduledFor ? 'scheduled' : 'publishing',
      scheduledFor: runAt,
    })

    const targets = await postRepo.createTargets(
      accounts.map((account) => {
        // Per-account caption override (trimmed, non-empty) → target.caption;
        // otherwise null so the publish job falls back to the shared caption.
        const override = dto.captions?.[account!.id]?.trim()
        return {
          postId: post.id,
          socialAccountId: account!.id,
          platform: account!.platform,
          caption: override && override !== dto.caption.trim() ? override : null,
          status: 'pending' as const,
        }
      }),
    )

    for (const target of targets) {
      const job = await schedulePublish({ postId: post.id, postTargetId: target.id, orgId }, runAt)
      await postRepo.updateTarget(orgId, target.id, { bullJobId: job.id })
    }

    return post
  }

  async update(orgId: string, id: string, dto: UpdatePostDto): Promise<Post> {
    const post = await this.get(orgId, id)
    if (post.status !== 'scheduled' && post.status !== 'draft') {
      throw new ApiError(409, 'Only draft or scheduled posts can be edited')
    }
    const updated = await postRepo.update(orgId, id, dto)

    // A BullMQ job's fire time is baked in as a fixed delay at creation, so
    // just writing a new scheduledFor to the DB would leave the post firing at
    // the OLD time. If the time changed on a still-scheduled post, cancel the
    // pending target jobs and re-enqueue them at the new time (mirroring create).
    if (dto.scheduledFor && post.status === 'scheduled') {
      const targets = await postRepo.findTargetsForPost(orgId, id)
      for (const t of targets.filter((t) => t.status === 'pending')) {
        if (t.bullJobId) await cancelPublish(t.bullJobId)
        const job = await schedulePublish({ postId: id, postTargetId: t.id, orgId }, dto.scheduledFor)
        await postRepo.updateTarget(orgId, t.id, { bullJobId: job.id })
      }
    }

    return updated!
  }

  // Cancels every pending platform job for the post — doesn't touch
  // targets that already published.
  async cancel(orgId: string, id: string): Promise<Post> {
    const post = await this.get(orgId, id)
    const targets = await postRepo.findTargetsForPost(orgId, id)

    await Promise.all(
      targets
        .filter((t) => t.status === 'pending' && t.bullJobId)
        .map((t) => cancelPublish(t.bullJobId!)),
    )

    const updated = await postRepo.update(orgId, id, { status: 'cancelled' })
    return updated ?? post
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.cancel(orgId, id)
    await postRepo.delete(orgId, id)
  }
}
