import { Queue } from 'bullmq'
import { redisConnection as connection } from './connection.js'

export interface PublishTargetJob {
  postId: string
  postTargetId: string
  orgId: string
}

export const publishQueue = new Queue<PublishTargetJob>('publish-target', { connection })

// Schedules one job per post_target so a failure on one platform doesn't
// block or retry the others — each platform gets independent retry/backoff.
// 5 attempts with exponential backoff (5s, 10s, 20s, 40s between attempts)
// so a transient platform/API blip (rate limit, momentary 5xx, network
// hiccup) doesn't permanently fail a scheduled post. removeOnFail keeps
// exhausted-retry jobs around in Redis (not purged immediately) so they
// stay inspectable via BullMQ's failed-job APIs, not just the structured
// log line emitted in publish-target.job.ts + worker.ts's 'failed' handler.
export async function schedulePublish(job: PublishTargetJob, runAt: Date) {
  const delay = Math.max(0, runAt.getTime() - Date.now())
  return publishQueue.add('publish', job, {
    delay,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  })
}

export async function cancelPublish(bullJobId: string) {
  const job = await publishQueue.getJob(bullJobId)
  if (job) await job.remove()
}

export const tokenRefreshQueue = new Queue('token-refresh', { connection })

// Runs every 15 minutes; refresh-tokens.job.ts only touches tokens expiring
// within the next hour, so this cadence comfortably beats any single
// platform's token lifetime (shortest is Bluesky's ~2h session JWT).
export async function scheduleTokenRefreshJob() {
  await tokenRefreshQueue.upsertJobScheduler(
    'refresh-expiring-tokens',
    { every: 15 * 60 * 1000 },
    { name: 'refresh', opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
  )
}
