import { Redis } from 'ioredis'
import { redisConnection } from './connection.js'
import { log } from '../observability/logger.js'

// Worker liveness signal.
//
// The worker is the single most dangerous silent failure in a scheduler: if
// it dies, the API keeps answering 200, the dashboard/MCP tools look fine,
// and posts simply never go out. Nothing in the system notices. So the
// worker stamps a timestamp into Redis on a timer, and GET /health/deep
// reports how old it is.
export const WORKER_HEARTBEAT_KEY = 'seenpaid:worker:heartbeat'

// Beat every 30s. Treat >3 minutes (≈6 missed beats) as dead — long enough to
// ride out a normal restart without crying wolf, short enough that a
// genuinely dead worker is caught on the next monitor pass.
export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_STALE_MS = 3 * 60_000

// Called once at worker boot. Returns a stop function for clean shutdown.
export function startWorkerHeartbeat(): () => Promise<void> {
  const redis = new Redis(redisConnection)

  const beat = () => {
    // 15-minute TTL: if the worker dies, the key expires rather than lingering
    // as a stale "it was alive once" value forever.
    redis
      .set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 900)
      .catch((err: unknown) => log.warn({ err }, 'Worker heartbeat write failed'))
  }

  beat()
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  // Don't hold the event loop open on shutdown — the BullMQ workers own the
  // process lifetime, not this timer.
  timer.unref?.()

  return async () => {
    clearInterval(timer)
    await redis.quit().catch(() => { /* shutting down anyway */ })
  }
}

export type WorkerLiveness =
  | { status: 'ok'; ageSeconds: number }
  | { status: 'stale'; ageSeconds: number }
  | { status: 'unknown' }

// Reads the heartbeat using an already-open Redis client (BullMQ's), so the
// API doesn't open a second connection just to answer a health check.
export async function readWorkerLiveness(client: {
  get(key: string): Promise<string | null>
}): Promise<WorkerLiveness> {
  const raw = await client.get(WORKER_HEARTBEAT_KEY)
  // No key at all = never seen a beat. That's also the state right after
  // first boot (worker not started yet), so it is deliberately NOT an error.
  if (!raw) return { status: 'unknown' }

  const ageMs = Date.now() - Number(raw)
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000))
  return ageMs > HEARTBEAT_STALE_MS ? { status: 'stale', ageSeconds } : { status: 'ok', ageSeconds }
}
