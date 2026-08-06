import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

// Any S3-compatible object store works here — Cloudflare R2 (zero egress
// fees, what the hosted seenpaid.com cloud uses), AWS S3, MinIO (good local
// self-host default, see docker-compose.yml), Backblaze B2, etc. Point
// R2_ACCOUNT_ID-style env vars at whichever you run.
const client = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  endpoint: process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : process.env.S3_ENDPOINT, // e.g. http://minio:9000 for the docker-compose default
  forcePathStyle: !!process.env.S3_ENDPOINT, // required for MinIO / most non-R2 S3-compatible stores
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY ?? '',
  },
})

const BUCKET = process.env.R2_BUCKET ?? process.env.S3_BUCKET ?? 'seenpaid-media'
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL ?? process.env.S3_PUBLIC_BASE_URL

export function buildMediaKey(orgId: string, filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop() : undefined
  return `${orgId}/${randomUUID()}${ext ? `.${ext}` : ''}`
}

// Client PUTs directly to this URL — video/image bytes never transit the API
// server, which keeps upload size limits and memory use off the table.
export async function getPresignedUploadUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType })
  return getSignedUrl(client, command, { expiresIn: 15 * 60 })
}

// Server-side upload for bytes produced server-side (no browser to presign a
// PUT to).
export async function uploadBytes(key: string, contentType: string, body: Buffer): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, Body: body }))
}

export function getPublicUrl(key: string): string {
  if (!PUBLIC_BASE_URL) {
    throw new Error('R2_PUBLIC_BASE_URL (or S3_PUBLIC_BASE_URL) is not set — configure a public bucket domain before serving media. See SELF_HOST.md.')
  }
  return `${PUBLIC_BASE_URL}/${key}`
}
