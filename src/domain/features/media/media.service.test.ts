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

// ingestFromUrl fetches on the caller's behalf — an agent hands it a URL, the
// server downloads it. Without a hostname check that's a direct SSRF path
// into the private network and the cloud metadata endpoint. These assert the
// rejection happens before any network call, so the guard can't be bypassed
// by a slow/hanging target either.
describe('MediaService.ingestFromUrl — SSRF guard', () => {
  const mediaService = new MediaService()

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata endpoint'],
    ['http://127.0.0.1:8080/', 'loopback'],
    ['http://localhost/', 'localhost'],
    ['http://10.0.0.5/', 'RFC1918 10/8'],
    ['http://172.16.0.1/', 'RFC1918 172.16/12'],
    ['http://192.168.1.1/', 'RFC1918 192.168/16'],
    ['http://internal-service.internal/', '.internal hostname'],
  ])('rejects %s (%s)', async (url) => {
    await expect(mediaService.ingestFromUrl('org-a', url)).rejects.toThrow(ApiError)
  })

  it('rejects non-http(s) protocols', async () => {
    await expect(mediaService.ingestFromUrl('org-a', 'file:///etc/passwd')).rejects.toThrow(ApiError)
  })

  it('rejects a malformed URL with a clear message rather than throwing unhandled', async () => {
    await expect(mediaService.ingestFromUrl('org-a', 'not a url')).rejects.toThrow(ApiError)
  })
})
