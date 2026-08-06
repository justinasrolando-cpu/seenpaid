import { Router } from 'express'
import { sql } from 'drizzle-orm'
import { db } from '../../../data-access/connection.js'
import { publishQueue } from '../../../jobs/queue.js'
import { readWorkerLiveness, type WorkerLiveness } from '../../../jobs/heartbeat.js'
import { log } from '../../../observability/logger.js'

// Deep health check — PUBLIC and unauthenticated (a monitor can't hold an
// API key), but it exposes only booleans and an age in seconds, never data.
//
// This exists because the shallow `/health` lies: it answers {status:'ok'}
// without touching anything. A health check that can't fail is not a health
// check.
//
// Severity is deliberately split:
//   • db / redis down  → 503. The API genuinely cannot serve.
//   • worker stale     → 200 with worker.status='stale'. The API is fine, but
//                        posts aren't publishing. A monitor should treat this
//                        as an alarm; keeping it off the HTTP status stops a
//                        dead worker from also looking like a dead API.
const router = Router()

const TIMEOUT_MS = 4000

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    ),
  ])
}

router.get('/', async (_req, res) => {
  const checks: {
    db: boolean
    redis: boolean
    worker: WorkerLiveness
  } = { db: false, redis: false, worker: { status: 'unknown' } }

  const errors: Record<string, string> = {}

  // Postgres — the real one. `select 1` proves the pool can round-trip.
  try {
    await withTimeout(db.execute(sql`select 1`), 'db')
    checks.db = true
  } catch (err) {
    errors.db = err instanceof Error ? err.message : 'unknown error'
  }

  // Redis + worker liveness, over BullMQ's existing connection (no second client).
  try {
    const client = await withTimeout(publishQueue.client, 'redis')
    // Reading the heartbeat key IS the Redis round-trip — a successful GET
    // (even one returning null) proves the connection is live, so there's no
    // need for a separate PING.
    checks.worker = await withTimeout(readWorkerLiveness(client), 'redis')
    checks.redis = true
  } catch (err) {
    errors.redis = err instanceof Error ? err.message : 'unknown error'
  }

  const serving = checks.db && checks.redis
  const body = {
    status: serving ? 'ok' : 'error',
    checks,
    ...(Object.keys(errors).length ? { errors } : {}),
  }

  if (!serving) {
    log.error({ checks, errors }, 'Deep health check FAILED')
  } else if (checks.worker.status === 'stale') {
    log.error({ worker: checks.worker }, 'Worker heartbeat is stale — posts are not publishing')
  }

  res.status(serving ? 200 : 503).json(body)
})

export default router
