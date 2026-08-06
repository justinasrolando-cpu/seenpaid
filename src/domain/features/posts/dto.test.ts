import { describe, expect, it } from 'vitest'
import { CreatePostSchema } from './dto.js'

describe('CreatePostSchema', () => {
  it('accepts a valid immediate post', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'Hello world',
      socialAccountIds: ['550e8400-e29b-41d4-a716-446655440000'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a post with no target accounts', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'Hello world',
      socialAccountIds: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a caption over 3000 characters', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'x'.repeat(3001),
      socialAccountIds: ['550e8400-e29b-41d4-a716-446655440000'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects scheduling in the past', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'Hello',
      socialAccountIds: ['550e8400-e29b-41d4-a716-446655440000'],
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(result.success).toBe(false)
  })

  it('accepts scheduling in the future', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'Hello',
      socialAccountIds: ['550e8400-e29b-41d4-a716-446655440000'],
      scheduledFor: new Date(Date.now() + 60_000 * 60).toISOString(),
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate socialAccountIds', () => {
    // Duplicates would otherwise create two post_targets rows for the same
    // account — two independent BullMQ jobs double-publishing the same
    // post to the same platform account.
    const result = CreatePostSchema.safeParse({
      caption: 'Hello world',
      socialAccountIds: [
        '550e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440000',
      ],
    })
    expect(result.success).toBe(false)
  })

  it('accepts distinct socialAccountIds', () => {
    const result = CreatePostSchema.safeParse({
      caption: 'Hello world',
      socialAccountIds: [
        '550e8400-e29b-41d4-a716-446655440000',
        '660e8400-e29b-41d4-a716-446655440001',
      ],
    })
    expect(result.success).toBe(true)
  })
})
