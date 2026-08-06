import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Post, PostTarget } from '../data-access/schema/index.js'

// finalizePostIfAllTargetsDone rolls post_targets up into the parent post's
// status. It must never clobber a post the user has already cancelled —
// that's a real race: PostsService.cancel can only cancel BullMQ jobs that
// are still 'pending'; a target already 'publishing' keeps running and its
// completion still calls this function, which would otherwise flip
// 'cancelled' back to 'published'/'failed'.
const findTargetsForPost = vi.fn<(orgId: string, postId: string) => Promise<PostTarget[]>>()
const findById = vi.fn<(orgId: string, id: string) => Promise<Post | undefined>>()
const update = vi.fn()

// These tests only exercise finalizePostIfAllTargetsDone, but importing the job
// drags in the whole publish stack: all 25 platform adapters (with their crypto
// and SDK dependencies) and data-access/connection.js (which opens a real pg
// Pool at import time). That cost real module-load time and is exactly the
// kind of thing that makes a test suite flaky under parallelism. Stub the
// heavy edges so the tests stay hermetic and fast.
vi.mock('../data-access/connection.js', () => ({ db: {} }))
vi.mock('../platforms/registry.js', () => ({ getPlatformAdapter: vi.fn() }))
vi.mock('../lib/email.js', () => ({
  sendEmail: vi.fn(),
  publishFailedEmail: vi.fn(() => ({ subject: '', html: '', text: '' })),
}))

vi.mock('../data-access/repositories/post.repository.js', () => ({
  PostRepository: vi.fn().mockImplementation(() => ({
    findTargetsForPost,
    findById,
    update,
  })),
}))
vi.mock('../data-access/repositories/social-account.repository.js', () => ({
  SocialAccountRepository: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('../data-access/repositories/media.repository.js', () => ({
  MediaRepository: vi.fn().mockImplementation(() => ({})),
}))

const baseTarget = (overrides: Partial<PostTarget>): PostTarget => ({
  id: 't1',
  postId: 'post-1',
  socialAccountId: 'acct-1',
  platform: 'bluesky',
  caption: null,
  status: 'published',
  externalPostId: null,
  externalUrl: null,
  errorMessage: null,
  bullJobId: null,
  publishedAt: null,
  createdAt: new Date(),
  ...overrides,
})

const basePost = (overrides: Partial<Post>): Post => ({
  id: 'post-1',
  orgId: 'org-1',
  createdBy: 'user-1',
  caption: '',
  mediaIds: [],
  status: 'publishing',
  scheduledFor: null,
  publishedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('finalizePostIfAllTargetsDone', () => {
  beforeEach(() => {
    findTargetsForPost.mockReset()
    findById.mockReset()
    update.mockReset()
  })

  it('does not overwrite a post the user already cancelled', async () => {
    const { finalizePostIfAllTargetsDone } = await import('./publish-target.job.js')

    findTargetsForPost.mockResolvedValue([baseTarget({ status: 'published' })])
    findById.mockResolvedValue(basePost({ status: 'cancelled' }))

    await finalizePostIfAllTargetsDone('org-1', 'post-1')

    expect(update).not.toHaveBeenCalled()
  })

  it('rolls up to published once all targets are terminal and post is not cancelled', async () => {
    const { finalizePostIfAllTargetsDone } = await import('./publish-target.job.js')

    findTargetsForPost.mockResolvedValue([
      baseTarget({ id: 't1', status: 'published' }),
      baseTarget({ id: 't2', status: 'failed' }),
    ])
    findById.mockResolvedValue(basePost({ status: 'publishing' }))

    await finalizePostIfAllTargetsDone('org-1', 'post-1')

    expect(update).toHaveBeenCalledWith('org-1', 'post-1', expect.objectContaining({ status: 'published' }))
  })

  it('rolls up to failed when no target published and post is not cancelled', async () => {
    const { finalizePostIfAllTargetsDone } = await import('./publish-target.job.js')

    findTargetsForPost.mockResolvedValue([baseTarget({ status: 'failed' })])
    findById.mockResolvedValue(basePost({ status: 'publishing' }))

    await finalizePostIfAllTargetsDone('org-1', 'post-1')

    expect(update).toHaveBeenCalledWith('org-1', 'post-1', expect.objectContaining({ status: 'failed', publishedAt: null }))
  })

  it('does nothing while any target is still pending or publishing', async () => {
    const { finalizePostIfAllTargetsDone } = await import('./publish-target.job.js')

    findTargetsForPost.mockResolvedValue([
      baseTarget({ id: 't1', status: 'published' }),
      baseTarget({ id: 't2', status: 'publishing' }),
    ])

    await finalizePostIfAllTargetsDone('org-1', 'post-1')

    expect(findById).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
