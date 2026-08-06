import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Media, SocialAccount } from '../../../data-access/schema/index.js'

// PostsService.create validates socialAccountIds belong to the org before
// creating targets; mediaIds referenced the same DTO but, before this fix
// (upstream), were never checked against the org at all. A mediaId
// belonging to another org (or simply nonexistent) would silently pass
// through and get dropped at publish time by mediaRepo.findByIds(orgId,
// ...) — the post would publish with missing media instead of failing
// loudly up front.
//
// Note: the hosted cloud product also gates create() behind
// assertOrgActive/assertWithinAccountLimit (plan-tier checks). This
// single-operator build has no plan concept, so there's nothing to mock
// there — see posts.service.ts for the full explanation.
const findAllForOrgSocialAccounts = vi.fn()
const findByIdSocialAccount = vi.fn<(orgId: string, id: string) => Promise<SocialAccount | undefined>>()
const findByIdsMedia = vi.fn<(orgId: string, ids: string[]) => Promise<Media[]>>()
const createPost = vi.fn()
const createTargets = vi.fn()
const updateTarget = vi.fn()

vi.mock('../../../data-access/repositories/post.repository.js', () => ({
  PostRepository: vi.fn().mockImplementation(() => ({
    create: createPost,
    createTargets,
    updateTarget,
  })),
}))
vi.mock('../../../data-access/repositories/social-account.repository.js', () => ({
  SocialAccountRepository: vi.fn().mockImplementation(() => ({
    findById: findByIdSocialAccount,
    findAllForOrg: findAllForOrgSocialAccounts,
  })),
}))
vi.mock('../../../data-access/repositories/media.repository.js', () => ({
  MediaRepository: vi.fn().mockImplementation(() => ({
    findByIds: findByIdsMedia,
  })),
}))
vi.mock('../../../jobs/queue.js', () => ({
  schedulePublish: vi.fn().mockResolvedValue({ id: 'bull-job-1' }),
  cancelPublish: vi.fn(),
}))

const account = (id: string): SocialAccount => ({
  id,
  orgId: 'org-1',
  platform: 'bluesky',
  externalAccountId: 'ext-1',
  displayName: 'Test',
  avatarUrl: null,
  status: 'active',
  createdAt: new Date(),
})

const mediaRow = (id: string): Media => ({
  id,
  orgId: 'org-1',
  type: 'image',
  r2Key: `org-1/${id}.png`,
  url: `https://example.com/${id}.png`,
  mimeType: 'image/png',
  sizeBytes: 100,
  durationSeconds: null,
  width: null,
  height: null,
  createdAt: new Date(),
})

describe('PostsService.create — mediaIds org scoping', () => {
  beforeEach(() => {
    findAllForOrgSocialAccounts.mockReset()
    findByIdSocialAccount.mockReset()
    findByIdsMedia.mockReset()
    createPost.mockReset()
    createTargets.mockReset()
    updateTarget.mockReset()

    findByIdSocialAccount.mockResolvedValue(account('acct-1'))
    createPost.mockResolvedValue({
      id: 'post-1', orgId: 'org-1', status: 'publishing', mediaIds: [],
    })
    createTargets.mockResolvedValue([{ id: 'target-1', postId: 'post-1', socialAccountId: 'acct-1', platform: 'bluesky', status: 'pending' }])
  })

  it('rejects a mediaId that does not belong to the org', async () => {
    const { PostsService } = await import('./posts.service.js')
    const { ApiError } = await import('../../../errors/index.js')
    const service = new PostsService()

    findByIdsMedia.mockResolvedValue([]) // org-scoped lookup finds nothing

    await expect(service.create('org-1', 'user-1', {
      caption: 'hi',
      mediaIds: ['11111111-1111-1111-1111-111111111111'],
      socialAccountIds: ['acct-1'],
    })).rejects.toThrow(ApiError)

    expect(createPost).not.toHaveBeenCalled()
  })

  it('accepts mediaIds that belong to the org', async () => {
    const { PostsService } = await import('./posts.service.js')
    const service = new PostsService()

    findByIdsMedia.mockResolvedValue([mediaRow('11111111-1111-1111-1111-111111111111')])

    await service.create('org-1', 'user-1', {
      caption: 'hi',
      mediaIds: ['11111111-1111-1111-1111-111111111111'],
      socialAccountIds: ['acct-1'],
    })

    expect(createPost).toHaveBeenCalled()
  })
})
