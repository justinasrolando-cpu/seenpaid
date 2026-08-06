import { z } from 'zod'

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const

export const PresignUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum([...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES]),
})
export type PresignUploadDto = z.infer<typeof PresignUploadSchema>

export const RegisterMediaSchema = z.object({
  r2Key: z.string().min(1),
  mimeType: z.enum([...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES]),
  sizeBytes: z.number().int().positive().max(500 * 1024 * 1024), // 500MB cap
  durationSeconds: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})
export type RegisterMediaDto = z.infer<typeof RegisterMediaSchema>

// AI image generation from a text prompt (free, keyless — via Pollinations).
export const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(1000),
})
export type GenerateImageDto = z.infer<typeof GenerateImageSchema>

export function mediaTypeFromMime(mimeType: string): 'image' | 'video' {
  return (ALLOWED_VIDEO_TYPES as readonly string[]).includes(mimeType) ? 'video' : 'image'
}
