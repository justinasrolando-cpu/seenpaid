import { describe, expect, it } from 'vitest'
import { MediaService } from './media.service.js'
import { ApiError } from '../../../errors/index.js'

// register() is tenant-scoped by r2Key prefix (buildMediaKey always writes
// `${orgId}/...`); only the rejection path is exercised here since it
// throws before touching the DB or the object store, so it doesn't need
// live infra.
describe('MediaService.register — org-scoped r2Key', () => {
  const mediaService = new MediaService()

  it('rejects an r2Key belonging to a different org', async () => {
    const orgId = 'org-a'
    const foreignKey = 'org-b/some-uuid.png'

    await expect(mediaService.register(orgId, {
      r2Key: foreignKey,
      mimeType: 'image/png',
      sizeBytes: 1024,
    })).rejects.toThrow(ApiError)
  })

  it('rejects an r2Key with no org prefix at all', async () => {
    await expect(mediaService.register('org-a', {
      r2Key: 'not-scoped-at-all.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    })).rejects.toThrow(ApiError)
  })
})
