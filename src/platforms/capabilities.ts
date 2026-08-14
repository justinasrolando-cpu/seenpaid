import type { PlatformId } from './types.js'

// Per-platform publishing constraints, so an agent (or the MCP validate_post
// tool) can answer "will this actually post?" before burning a publish
// attempt. Every number here is a real, verified platform limit taken from
// the adapters in this directory — none of it is estimated.

export const CAPTION_LIMITS: Record<PlatformId, number> = {
  x: 280,
  bluesky: 300,
  linkedin: 3000,
  instagram: 2200,
  facebook: 63206,
  tiktok: 2200,
  discord: 2000,
  telegram: 4096,
  mastodon: 500,
  nostr: 10000,
  devto: 250000,
  hashnode: 250000,
  medium: 250000,
  reddit: 40000,
  threads: 500,
  tumblr: 4096,
  pinterest: 800,
  vk: 16000,
  slack: 3000,
  wordpress: 250000,
  ghost: 250000,
  lemmy: 40000,
  webhook: 250000,
  microblog: 10000,
  matrix: 30000,
}

/** Platforms where a text-only post will be rejected by the platform itself. */
export const REQUIRES_MEDIA: Partial<Record<PlatformId, boolean>> = {
  instagram: true,
  tiktok: true,
  pinterest: true,
}

/** Behaviour worth knowing BEFORE publishing rather than discovering after. */
export const PLATFORM_NOTES: Partial<Record<PlatformId, string>> = {
  x: 'X charges for API posting (their pricing, not ours). Without credits on your own X developer account, publishing fails.',
  tiktok: 'TikTok lands as a DRAFT in your inbox — their API forbids direct publishing. You must open TikTok and tap Post yourself. Requires a video (not an image), 64MB or under.',
  instagram: 'Instagram requires at least one image or video; text-only posts are not supported by their API.',
  pinterest: 'Pinterest requires an image to create a Pin.',
}
