import { log } from '../observability/logger.js'

// Fail fast at boot if a security-critical secret is missing in production,
// rather than silently falling back to an insecure default. Without this, a
// missing TOKEN_ENCRYPTION_KEY or API_KEY would boot fine and either encrypt
// every stored OAuth token with the publicly-known dev key (see
// src/auth/crypto.ts) or leave the API totally unauthenticated. In
// development these may be unset — the code has local dev fallbacks for
// that case, so the check only runs in production.
export function assertRequiredSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing: string[] = []
  if (!process.env.TOKEN_ENCRYPTION_KEY) missing.push('TOKEN_ENCRYPTION_KEY')
  if (!process.env.API_KEY) missing.push('API_KEY')

  if (missing.length > 0) {
    log.error({ missing }, 'Missing required production secrets — refusing to start')
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}. See SELF_HOST.md.`)
  }
}
