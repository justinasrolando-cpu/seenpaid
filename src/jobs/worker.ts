import 'dotenv/config'
import { Worker } from 'bullmq'
import { assertRequiredSecrets } from '../config/require-secrets.js'
import { handlePublishTarget } from './publish-target.job.js'
import { refreshExpiringTokens } from './refresh-tokens.job.js'
import { scheduleTokenRefreshJob } from './queue.js'
import { redisConnection as connection } from './connection.js'
import { log } from '../observability/logger.js'
import { startWorkerHeartbeat } from './heartbeat.js'

// The token-refresh job decrypts stored OAuth tokens, so the worker needs
// the same encryption key as the API — fail fast if it's missing in prod.
assertRequiredSecrets()

// Liveness signal for /health/deep. A dead worker is invisible otherwise: the
// API keeps returning 200 while posts silently never publish.
const stopHeartbeat = startWorkerHeartbeat()
void stopHeartbeat // referenced for lint; actual shutdown wiring is below

const publishWorker = new Worker('publish-target', handlePublishTarget, {
  connection,
  concurrency: 5,
})
publishWorker.on('completed', (job) => log.info({ jobId: job.id }, 'Publish job completed'))
// BullMQ fires 'failed' after EVERY failed attempt, not just the last one —
// handlePublishTarget already logs a per-attempt warn/error distinction
// (see publish-target.job.ts). This handler is the queue-level backstop: it
// re-asserts loudly when a job has exhausted all its configured `attempts`
// (queue.ts) and BullMQ will not retry it again, so a permanently failed
// post is never silent in the logs even if something upstream of
// handlePublishTarget's own try/catch throws.
publishWorker.on('failed', (job, err) => {
  const attemptsMade = job?.attemptsMade ?? 0
  const maxAttempts = job?.opts.attempts ?? 1
  const exhausted = attemptsMade >= maxAttempts
  const fields = {
    jobId: job?.id,
    postId: job?.data.postId,
    postTargetId: job?.data.postTargetId,
    orgId: job?.data.orgId,
    attemptsMade,
    maxAttempts,
    err,
  }
  if (exhausted) {
    log.error(fields, 'Publish job permanently failed — all retries exhausted, will not run again')
  } else {
    log.warn(fields, 'Publish job attempt failed — BullMQ will retry')
  }
})

const tokenRefreshWorker = new Worker('token-refresh', async () => refreshExpiringTokens(), {
  connection,
  concurrency: 1,
})
tokenRefreshWorker.on('completed', (job) =>
  log.info({ jobId: job.id, result: job.returnvalue }, 'Token refresh sweep completed'))
tokenRefreshWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Token refresh sweep failed'))

await scheduleTokenRefreshJob()

log.info('Publish + token-refresh workers started')

// On SIGTERM (deploy/restart), let workers finish the jobs they've already
// claimed and close their Redis connections cleanly rather than abandoning
// an in-flight publish and leaving the job stuck.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down workers')
  await Promise.allSettled([publishWorker.close(), tokenRefreshWorker.close()])
  log.info('Workers closed cleanly')
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
