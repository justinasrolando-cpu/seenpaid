import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { requestLogger } from '../../observability/logger.js'
import { globalErrorHandler } from '../../errors/index.js'
import postsRoutes from './routes/posts.routes.js'
import accountsRoutes from './routes/accounts.routes.js'
import mediaRoutes from './routes/media.routes.js'
import healthRoutes from './routes/health.routes.js'
import mcpRoutes from '../mcp/mcp.routes.js'

// Explicit allowlist, not a wildcard — the API accepts an Authorization
// header, so `Access-Control-Allow-Origin: *` would be unsafe even without
// cookies. Defaults to local dev; set ALLOWED_ORIGINS (comma-separated) for
// any browser-based client (e.g. a self-built dashboard) in production.
function getAllowedOrigins(): string[] {
  const configured = process.env.ALLOWED_ORIGINS
  if (configured) return configured.split(',').map((o) => o.trim())
  return ['http://localhost:3000']
}

// req.ip must reflect the real client, not the fronting proxy, for the rate
// limiter (and request logs) to work. `trust proxy` is the NUMBER of proxy
// hops to trust — deliberately NOT `true`, which express-rate-limit rejects
// as unsafe. Defaults to 1 (a single reverse proxy in front, e.g.
// Caddy/nginx/Railway). Set TRUST_PROXY=0 for local / no-proxy runs.
function trustProxySetting(): number {
  const raw = process.env.TRUST_PROXY
  if (raw === undefined) return 1
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 1
}

const apiRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
})

export function createApp() {
  const app = express()
  // Don't advertise the framework — trims a trivial recon signal for attackers.
  app.disable('x-powered-by')
  app.set('trust proxy', trustProxySetting())

  app.use(cors({
    origin: getAllowedOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
  }))
  app.use(express.json({ limit: '2mb' }))
  app.use(requestLogger())

  // Shallow liveness — answers without touching anything.
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  // Deep health — actually exercises Postgres, Redis, and the worker
  // heartbeat. Public/unauthenticated so an external monitor can hit it.
  app.use('/health/deep', healthRoutes)

  // AI-agent access over MCP (Model Context Protocol). Authenticates per
  // request via API_KEY (Bearer token). Kept at the app root so the connect
  // URL is a clean <APP_URL>/mcp.
  app.use('/mcp', mcpRoutes)

  // API-wide rate limit (backstop against a single client hammering the
  // API). Mounted after the public health/mcp paths.
  app.use(apiRateLimiter)

  app.use('/api/posts', postsRoutes)
  app.use('/api/accounts', accountsRoutes)
  app.use('/api/media', mediaRoutes)

  // Registered LAST — see src/errors/index.ts
  app.use(globalErrorHandler)

  return app
}
