import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { OrganizationRepository } from '../data-access/repositories/organization.repository.js'

// ── Single-operator auth ────────────────────────────────────────────────
//
// This is deliberately NOT the multi-tenant JWT/RBAC/org system the hosted
// seenpaid.com cloud product runs (src/auth/{jwt,rbac,middleware}.ts over
// there). Self-hosters run one instance for themselves — there is no
// concept of multiple users or organizations here, matching how tools like
// Plausible and Umami do single-operator self-hosting: one shared secret,
// set via env, checked on every request. No login UI, no sessions, no
// password hashing, no refresh tokens.
//
// Set API_KEY in your .env to a long random string (e.g. `openssl rand -hex
// 32`) and send it as `Authorization: Bearer <API_KEY>` (or `X-Api-Key:
// <API_KEY>`) on every request. The same key also authenticates the MCP
// endpoint (src/entry-points/mcp/mcp.routes.ts).
//
// The single "organization" row exists only because the schema (and the
// domain services copied over from the cloud product) is org-scoped by
// convention — see src/data-access/schema/index.ts. There is exactly one
// row, created on first boot, and its id is cached here for the lifetime of
// the process.

const orgRepo = new OrganizationRepository()
let cachedOrgId: string | undefined

export async function ensureSingleOrg(): Promise<string> {
  if (cachedOrgId) return cachedOrgId
  const existing = await orgRepo.findFirst()
  const org = existing ?? await orgRepo.create()
  cachedOrgId = org.id
  return org.id
}

function extractProvidedKey(req: Request): string | undefined {
  const header = req.header('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  const apiKeyHeader = req.header('x-api-key')
  if (apiKeyHeader) return apiKeyHeader.trim()
  return undefined
}

// Constant-time comparison so a timing side-channel can't help an attacker
// guess the key one byte at a time.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Express middleware — mount ahead of every /api/* route that isn't
// explicitly public. Populates req.orgId (the single fixed org) once the
// key checks out.
export function requireApiKey() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.API_KEY
    if (!expected) {
      res.status(500).json({ success: false, error: 'Server misconfigured: API_KEY is not set. See SELF_HOST.md.' })
      return
    }

    const provided = extractProvidedKey(req)
    if (!provided || !safeEqual(provided, expected)) {
      res.status(401).json({ success: false, error: 'Unauthorized: provide the API key as `Authorization: Bearer <key>` or `X-Api-Key: <key>`.' })
      return
    }

    req.orgId = await ensureSingleOrg()
    next()
  }
}

// Used by the MCP endpoint, which does its own auth (see mcp.routes.ts)
// rather than running as Express middleware.
export async function verifyApiKey(provided: string | undefined): Promise<{ orgId: string } | undefined> {
  const expected = process.env.API_KEY
  if (!expected || !provided || !safeEqual(provided, expected)) return undefined
  return { orgId: await ensureSingleOrg() }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string
    }
  }
}
