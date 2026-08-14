import { MediaRepository } from '../../../data-access/repositories/media.repository.js'
import { buildMediaKey, getPresignedUploadUrl, getPublicUrl, uploadBytes } from '../../../lib/r2.js'
import { mediaTypeFromMime, type PresignUploadDto, type RegisterMediaDto } from './dto.js'
import { ApiError } from '../../../errors/index.js'
import type { Media } from '../../../data-access/schema/index.js'

const mediaRepo = new MediaRepository()

// Pollinations — free, keyless text-to-image. $0 to run. FLUX model, square
// by default. Fully optional; posts work fine without ever calling this.
const AI_IMAGE_SIZE = 1024

const ALL_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
const MAX_INGEST_BYTES = 100 * 1024 * 1024 // 100MB — below the 500MB upload cap

// Blocks the obvious SSRF targets: loopback, link-local (incl. the cloud
// metadata endpoint at 169.254.169.254), and RFC1918 space. Hostname-based, so
// it does not stop a public DNS name that resolves to a private IP — a full fix
// needs resolve-then-check-then-pin. Worth doing if this ever accepts untrusted
// input beyond an authenticated org's own agent.
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return (
    a === 0 || a === 127 ||                    // this-host, loopback
    a === 10 ||                                // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||       // 172.16.0.0/12
    (a === 192 && b === 168) ||                // 192.168.0.0/16
    (a === 169 && b === 254) ||                // link-local + cloud metadata
    (a === 100 && b >= 64 && b <= 127)         // carrier-grade NAT
  )
}

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

  // Ingest a publicly-reachable image or video into this org's library.
  //
  // Not the same as `register`, which only records a row for bytes already
  // PUT to a presigned key. An agent has no browser to upload from, so this
  // is the only way it can attach an image it didn't generate itself. The
  // bytes are copied in rather than the URL stored as-is: a remote URL can
  // rot, and several platform APIs refuse to fetch media from arbitrary
  // hosts at publish time.
  async ingestFromUrl(orgId: string, sourceUrl: string): Promise<Media> {
    let parsed: URL
    try { parsed = new URL(sourceUrl) } catch { throw new ApiError(400, 'That is not a valid URL') }
    // Only http(s), and never a URL the server itself can reach internally —
    // this fetches on the caller's behalf, so without this it's an SSRF hole
    // straight into the private network and cloud metadata service.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'Only http and https URLs can be ingested')
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new ApiError(400, 'That host is not reachable from here')
    }

    let res: Response
    try {
      res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
    } catch {
      throw new ApiError(504, 'Could not download that URL — it timed out or is unreachable')
    }
    if (!res.ok) throw new ApiError(400, `Could not download that URL (HTTP ${res.status})`)

    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!ALL_ALLOWED_TYPES.includes(mimeType)) {
      throw new ApiError(400, `Unsupported media type "${mimeType || 'unknown'}". Allowed: ${ALL_ALLOWED_TYPES.join(', ')}.`)
    }

    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) throw new ApiError(400, 'That URL returned an empty file')
    if (buf.byteLength > MAX_INGEST_BYTES) {
      throw new ApiError(400, `That file is ${Math.round(buf.byteLength / 1024 / 1024)}MB — the limit is ${MAX_INGEST_BYTES / 1024 / 1024}MB`)
    }

    const type = mediaTypeFromMime(mimeType)
    const ext = mimeType.split('/')[1] ?? 'bin'
    const r2Key = buildMediaKey(orgId, `ingested.${ext}`)
    await uploadBytes(r2Key, mimeType, buf)

    return mediaRepo.create({
      orgId, type, r2Key, url: getPublicUrl(r2Key), mimeType, sizeBytes: buf.byteLength,
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
