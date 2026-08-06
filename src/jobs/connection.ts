// Shared BullMQ/ioredis connection config — single source of truth so
// queue.ts (API process) and worker.ts (worker process) can't drift.
export const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
}
