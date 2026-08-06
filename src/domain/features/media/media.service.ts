import { MediaRepository } from '../../../data-access/repositories/media.repository.js'
import { buildMediaKey, getPresignedUploadUrl, getPublicUrl, uploadBytes } from '../../../lib/r2.js'
import { mediaTypeFromMime, type PresignUploadDto, type RegisterMediaDto } from './dto.js'
import { ApiError } from '../../../errors/index.js'
import type { Media } from '../../../data-access/schema/index.js'

const mediaRepo = new MediaRepository()

// Pollinations — free, keyless text-to-image. $0 to run. FLUX model, square
// by default. Fully optional; posts work fine without ever calling this.
const AI_IMAGE_SIZE = 1024

export class MediaService {
  // Step 1 of 2: client asks for a place to upload; we hand back a
  // presigned PUT URL scoped to this org's key prefix.
  async createUploadUrl(orgId: string, dto: PresignUploadDto): Promise<{ uploadUrl: string; r2Key: string }> {
    const r2Key = buildMediaKey(orgId, dto.filename)
    const uploadUrl = await getPresignedUploadUrl(r2Key, dto.mimeType)
    return { uploadUrl, r2Key }
  }

  // Step 2 of 2: client confirms the upload finished and reports the
  // metadata it read client-side (dimensions/duration) so we don't need to
  // download the file server-side just to inspect it.
  async register(orgId: string, dto: RegisterMediaDto): Promise<Media> {
    // r2Key is client-supplied (echoed back from createUploadUrl) — without
    // this check, one org could register a media row pointing at another
    // org's object-store key/URL (buildMediaKey always prefixes with
    // `${orgId}/`), so an org-scoped media row could still resolve to a
    // different tenant's uploaded object.
    if (!dto.r2Key.startsWith(`${orgId}/`)) {
      throw new ApiError(403, 'r2Key does not belong to this organization')
    }

    return mediaRepo.create({
      orgId,
      type: mediaTypeFromMime(dto.mimeType),
      r2Key: dto.r2Key,
      url: getPublicUrl(dto.r2Key),
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      durationSeconds: dto.durationSeconds,
      width: dto.width,
      height: dto.height,
    })
  }

  // Generate an image from a text prompt and store it as a normal media row,
  // so it attaches to posts and publishes to every platform like any upload.
  async generateImage(orgId: string, prompt: string): Promise<Media> {
    const clean = prompt.trim().slice(0, 1000)
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(clean)}`
      + `?width=${AI_IMAGE_SIZE}&height=${AI_IMAGE_SIZE}&nologo=true&model=flux`

    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
    } catch {
      throw new ApiError(504, 'Image generation timed out — try again in a moment')
    }
    if (!res.ok) throw new ApiError(502, `Image generation failed: ${res.status}`)

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) throw new ApiError(502, 'Image generation returned no image')

    const mimeType = 'image/jpeg'
    const r2Key = buildMediaKey(orgId, 'ai-image.jpg')
    await uploadBytes(r2Key, mimeType, buf)

    return mediaRepo.create({
      orgId,
      type: 'image',
      r2Key,
      url: getPublicUrl(r2Key),
      mimeType,
      sizeBytes: buf.byteLength,
      width: AI_IMAGE_SIZE,
      height: AI_IMAGE_SIZE,
    })
  }
}
