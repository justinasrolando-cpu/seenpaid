import { SocialAccountRepository } from '../data-access/repositories/social-account.repository.js'
import { encryptToken, decryptToken } from '../auth/crypto.js'
import { getPlatformAdapter } from '../platforms/registry.js'
import { log } from '../observability/logger.js'

const socialAccountRepo = new SocialAccountRepository()

// Refreshes any OAuth token expiring in the next hour. Platforms without a
// refresh flow (LinkedIn's standard grant, Meta Page tokens) throw from
// refreshTokens() by design — those accounts fall straight to
// reauth_required, which is the correct outcome: you must re-connect.
export async function refreshExpiringTokens(): Promise<{ refreshed: number; reauthRequired: number }> {
  const horizon = new Date(Date.now() + 60 * 60 * 1000)
  const expiring = await socialAccountRepo.findTokensExpiringSoon(horizon)

  let refreshed = 0
  let reauthRequired = 0

  for (const token of expiring) {
    if (!token.refreshTokenEnc) {
      await socialAccountRepo.setStatus(token.orgId, token.socialAccountId, 'reauth_required')
      reauthRequired++
      continue
    }

    try {
      const adapter = getPlatformAdapter(token.platform)
      const refreshed_ = await adapter.refreshTokens(decryptToken(token.refreshTokenEnc))
      await socialAccountRepo.upsertTokens(token.socialAccountId, {
        accessTokenEnc: encryptToken(refreshed_.accessToken),
        refreshTokenEnc: refreshed_.refreshToken ? encryptToken(refreshed_.refreshToken) : token.refreshTokenEnc,
        expiresAt: refreshed_.expiresAt,
        scope: refreshed_.scope,
      })
      refreshed++
    } catch (err) {
      log.warn({ err, socialAccountId: token.socialAccountId, platform: token.platform }, 'Token refresh failed — marking reauth_required')
      await socialAccountRepo.setStatus(token.orgId, token.socialAccountId, 'reauth_required')
      reauthRequired++
    }
  }

  return { refreshed, reauthRequired }
}
