import type { Job } from 'bullmq'
import { PostRepository } from '../data-access/repositories/post.repository.js'
import { SocialAccountRepository } from '../data-access/repositories/social-account.repository.js'
import { MediaRepository } from '../data-access/repositories/media.repository.js'
import { sendEmail, publishFailedEmail } from '../lib/email.js'
import { decryptToken } from '../auth/crypto.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { log } from '../observability/logger.js'
import type { PublishTargetJob } from './queue.js'

// NOTE on what's missing vs. the hosted seenpaid.com cloud product this was
// extracted from: the cloud version rewrites the caption's URL into a
// tracked short link right before publish (and registers a bio-page link
// for platforms that can't render an in-post link), so it can later match a
// Stripe sale back to the exact post that drove it. That's the revenue
// attribution engine (src/attribution/ upstream) — closed-source, cloud
// only, and deliberately not part of this repo. This version publishes the
// caption exactly as written, with no rewriting and no tracking of any
// kind. See this repo's README, "what this repo is NOT".

const postRepo = new PostRepository()
const socialAccountRepo = new SocialAccountRepository()
const mediaRepo = new MediaRepository()

// Best-effort email alert on a permanent publish failure. Never allowed to
// throw into the job's failure handling — a bad email must not mask the
// real publish error. Set OWNER_EMAIL to receive these; if unset, failures
// are still logged (see the 'failed' handler in worker.ts).
async function emailPublishFailure(
  platformLabel: string | null, reason: string, postId: string,
): Promise<void> {
  const to = process.env.OWNER_EMAIL
  if (!to) return
  try {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3001'
    const mail = publishFailedEmail(appUrl, platformLabel, reason, postId)
    await sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text })
  } catch (e) {
    log.warn({ err: e, postId }, 'Failed to send publish-failure email')
  }
}

// One job = one (post, platform) pair. Runs independently per platform so
// e.g. a TikTok token expiry doesn't block the X/Bluesky/LinkedIn posts.
export async function handlePublishTarget(job: Job<PublishTargetJob>) {
  const { postId, postTargetId, orgId } = job.data

  // Captured for the catch's log fields. Everything else stays scoped INSIDE
  // the try so that ANY failure — including a missing account or token —
  // lands in the catch below and writes an errorMessage instead of leaving
  // the target marked failed with no recorded reason.
  let platform: string | undefined

  try {
    const post = await postRepo.findById(orgId, postId)
    if (!post) throw new Error(`Post ${postId} not found for org ${orgId}`)

    const targets = await postRepo.findTargetsForPost(orgId, postId)
    const target = targets.find((t) => t.id === postTargetId)
    if (!target) throw new Error(`Post target ${postTargetId} not found`)
    platform = target.platform

    const account = await socialAccountRepo.findById(orgId, target.socialAccountId)
    if (!account) throw new Error(`Social account ${target.socialAccountId} not found`)

    await postRepo.updateTarget(orgId, target.id, { status: 'publishing' })

    const tokens = await socialAccountRepo.findTokens(account.id)
    if (!tokens) throw new Error(`No OAuth tokens stored for account ${account.id}`)

    const mediaAssets = await mediaRepo.findByIds(orgId, post.mediaIds)
    const adapter = getPlatformAdapter(target.platform)

    // Per-platform caption override (post_targets.caption) falls back to the
    // parent post's shared caption when not set. Published as-is — no
    // rewriting (see file header note above).
    const caption = target.caption ?? post.caption

    // X BYOK accounts store their 4 OAuth 1.0a keys as an encrypted
    // `byok1:`-prefixed JSON blob in the same token column (no schema
    // change); everything else stores a bearer token as before.
    const decrypted = decryptToken(tokens.accessTokenEnc)
    const byok = decrypted.startsWith('byok1:')
      ? JSON.parse(decrypted.slice(6)) as { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string }
      : undefined

    // X is BYOK-only. A stored X token that ISN'T a byok1: blob is a stale
    // pre-BYOK OAuth-2 connection — X rejects it for posting with a cryptic
    // 403 ("OAuth 2.0 Application-Only is forbidden for this endpoint").
    // Detect it up front: flag the account reauth_required and fail with an
    // actionable reason instead of a confusing platform error.
    if (target.platform === 'x' && !byok) {
      await socialAccountRepo.setStatus(orgId, account.id, 'reauth_required')
      throw new Error('Your X connection is out of date. Reconnect X with your own API keys (paste-your-own-keys) — X no longer accepts the old connection for posting.')
    }

    const result = await adapter.publish({
      caption,
      media: mediaAssets.map((m) => ({ url: m.url, mimeType: m.mimeType, type: m.type })),
      accessToken: byok ? '' : decrypted,
      externalAccountId: account.externalAccountId,
      ...(byok ? { oauth1: byok } : {}),
    })

    await postRepo.updateTarget(orgId, target.id, {
      status: 'published',
      externalPostId: result.externalPostId,
      externalUrl: result.externalUrl,
      publishedAt: new Date(),
    })
    await finalizePostIfAllTargetsDone(orgId, postId)
  } catch (err) {
    // Distinguish "will retry" from "exhausted, terminal failure" so the
    // exhausted case is loud in the logs without spamming error-level logs
    // for every mid-retry attempt. job.attemptsMade is 1-indexed as of the
    // attempt currently running (BullMQ increments it before invoking the
    // processor), so comparing it to the configured `attempts` (queue.ts)
    // tells us whether this was the last try.
    const attemptsMade = job.attemptsMade
    const maxAttempts = job.opts.attempts ?? 1
    const exhausted = attemptsMade >= maxAttempts
    const logFields = {
      err,
      postId,
      postTargetId,
      orgId,
      platform,
      jobId: job.id,
      attemptsMade,
      maxAttempts,
    }

    if (exhausted) {
      log.error(logFields, 'Publish target permanently failed — retries exhausted')
      const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : null
      await emailPublishFailure(
        platformLabel,
        err instanceof Error ? err.message : 'The platform rejected the post. Reconnect the account and try again.',
        postId,
      )
    } else {
      log.warn(logFields, 'Publish target attempt failed — will retry')
    }

    // Record the reason on the target from the trusted job payload
    // (postTargetId) rather than a looked-up row, so even a pre-flight
    // failure (missing account/token) surfaces instead of a blank "failed"
    // status. A postTargetId matching no row is a harmless no-op.
    await postRepo.updateTarget(orgId, postTargetId, {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    })
    // A target can transiently read 'failed' here and then flip back to
    // 'publishing' on the next attempt — finalizePostIfAllTargetsDone only
    // commits once every target is in a terminal state, so a mid-retry read
    // here doesn't lock in a premature post.status. Once retries are
    // exhausted, the target's 'failed' status IS terminal and this call is
    // what lets the rollup finalize the parent post correctly.
    await finalizePostIfAllTargetsDone(orgId, postId)
    throw err // let BullMQ retry with backoff (or mark the job failed if exhausted)
  }
}

// Rolls per-platform post_targets up into the parent post's overall status.
// Only fires once every target has reached a terminal state (published or
// failed) — 'published' if at least one target succeeded, 'failed' only if
// all of them did.
// Exported for direct unit testing of the rollup/race-guard logic below.
export async function finalizePostIfAllTargetsDone(orgId: string, postId: string): Promise<void> {
  const targets = await postRepo.findTargetsForPost(orgId, postId)
  const stillRunning = targets.some((t) => t.status === 'pending' || t.status === 'publishing')
  if (stillRunning) return

  // The post can be cancelled while one of its targets is already mid-publish
  // (status 'publishing', BullMQ job no longer cancellable — see
  // PostsService.cancel). That in-flight target still finishes here and would
  // otherwise clobber the cancellation back to 'published'/'failed'.
  // 'cancelled' is a terminal, user-initiated state that this target-driven
  // rollup must never override.
  const post = await postRepo.findById(orgId, postId)
  if (!post || post.status === 'cancelled') return

  const anyPublished = targets.some((t) => t.status === 'published')
  await postRepo.update(orgId, postId, {
    status: anyPublished ? 'published' : 'failed',
    publishedAt: anyPublished ? new Date() : null,
  })
}
