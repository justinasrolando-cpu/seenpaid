import { XAdapter } from './x.adapter.js'
import { BlueskyAdapter } from './bluesky.adapter.js'
import { LinkedInAdapter } from './linkedin.adapter.js'
import { InstagramAdapter } from './instagram.adapter.js'
import { FacebookAdapter } from './facebook.adapter.js'
import { TikTokAdapter } from './tiktok.adapter.js'
import { DiscordAdapter } from './discord.adapter.js'
import { TelegramAdapter } from './telegram.adapter.js'
import { MastodonAdapter } from './mastodon.adapter.js'
import { NostrAdapter } from './nostr.adapter.js'
import { DevtoAdapter } from './devto.adapter.js'
import { HashnodeAdapter } from './hashnode.adapter.js'
import { MediumAdapter } from './medium.adapter.js'
import { RedditAdapter } from './reddit.adapter.js'
import { ThreadsAdapter } from './threads.adapter.js'
import { TumblrAdapter } from './tumblr.adapter.js'
import { PinterestAdapter } from './pinterest.adapter.js'
import { VkAdapter } from './vk.adapter.js'
import { SlackAdapter } from './slack.adapter.js'
import { WordpressAdapter } from './wordpress.adapter.js'
import { GhostAdapter } from './ghost.adapter.js'
import { LemmyAdapter } from './lemmy.adapter.js'
import { WebhookAdapter } from './webhook.adapter.js'
import { MicroblogAdapter } from './microblog.adapter.js'
import { MatrixAdapter } from './matrix.adapter.js'
import type { PlatformAdapter, PlatformId } from './types.js'

const registry: Record<PlatformId, PlatformAdapter> = {
  x: new XAdapter(),
  bluesky: new BlueskyAdapter(),
  linkedin: new LinkedInAdapter(),
  instagram: new InstagramAdapter(),
  facebook: new FacebookAdapter(),
  tiktok: new TikTokAdapter(),
  discord: new DiscordAdapter(),
  telegram: new TelegramAdapter(),
  mastodon: new MastodonAdapter(),
  nostr: new NostrAdapter(),
  devto: new DevtoAdapter(),
  hashnode: new HashnodeAdapter(),
  medium: new MediumAdapter(),
  reddit: new RedditAdapter(),
  threads: new ThreadsAdapter(),
  tumblr: new TumblrAdapter(),
  pinterest: new PinterestAdapter(),
  vk: new VkAdapter(),
  slack: new SlackAdapter(),
  wordpress: new WordpressAdapter(),
  ghost: new GhostAdapter(),
  lemmy: new LemmyAdapter(),
  webhook: new WebhookAdapter(),
  microblog: new MicroblogAdapter(),
  matrix: new MatrixAdapter(),
}

export function getPlatformAdapter(platform: PlatformId): PlatformAdapter {
  return registry[platform]
}
