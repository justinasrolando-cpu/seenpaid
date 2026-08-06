import { Router, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { verifyApiKey } from '../../auth/single-user.js'
import { buildMcpServer } from './build-server.js'
import { log } from '../../observability/logger.js'

const router = Router()

function bearerToken(req: Request): string | undefined {
  const h = req.header('authorization')
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

// Stateless streamable-HTTP MCP endpoint. Each request authenticates via the
// same API_KEY the REST API uses (Bearer token), spins up a fresh MCP server
// + transport, handles the JSON-RPC request, and tears them down when the
// response closes. No server-side session state — every request stands
// alone. Point your agent's MCP client at POST <APP_URL>/mcp with
// `Authorization: Bearer <API_KEY>`.
router.post('/', async (req: Request, res: Response) => {
  const ctx = await verifyApiKey(bearerToken(req))
  if (!ctx) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: provide your API_KEY as a Bearer token.' }, id: null })
    return
  }
  const server = buildMcpServer(ctx)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { void transport.close(); void server.close() })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    log.error({ err }, 'MCP request failed')
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  }
})

// GET (SSE) and DELETE (session teardown) are only meaningful in stateful mode.
const notAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null })
router.get('/', notAllowed)
router.delete('/', notAllowed)

export default router
