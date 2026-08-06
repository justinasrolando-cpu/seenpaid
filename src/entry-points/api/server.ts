import 'dotenv/config'
import { assertRequiredSecrets } from '../../config/require-secrets.js'
import { createApp } from './app.js'
import { log } from '../../observability/logger.js'

assertRequiredSecrets()

const port = Number(process.env.PORT ?? 3001)
const app = createApp()

const server = app.listen(port, () => {
  log.info({ port }, 'seenpaid API listening')
})

// Run the BullMQ worker IN-PROCESS unless explicitly disabled. Co-locating
// the worker with the API guarantees the publish queue is always drained —
// closes the failure mode where a separate worker process is misconfigured
// (not started, wrong Redis) and jobs silently pile up as 'publishing'.
// worker.ts wires the Workers + recurring schedulers as import side-effects.
// Set RUN_INLINE_WORKER=false if you run a dedicated worker process/container
// instead (see docker-compose.yml, which does exactly that).
if (process.env.RUN_INLINE_WORKER !== 'false') {
  import('../../jobs/worker.js')
    .then(() => log.info('In-process worker started (RUN_INLINE_WORKER not disabled)'))
    .catch((err) => log.error({ err }, 'Failed to start in-process worker'))
}

// Most process managers / container platforms send SIGTERM on
// restart/stop/scale. Stop accepting new connections and let in-flight
// requests finish before exiting, instead of dropping them mid-response.
function shutdown(signal: string): void {
  log.info({ signal }, 'Shutting down API server')
  server.close(() => {
    log.info('API server closed cleanly')
    process.exit(0)
  })
  // Failsafe: don't hang forever if a connection refuses to drain.
  setTimeout(() => {
    log.error('Forced API shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
