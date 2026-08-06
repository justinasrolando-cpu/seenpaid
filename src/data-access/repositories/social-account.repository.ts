import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../connection.js'
import {
  oauthTokens, socialAccounts,
  type NewOauthToken, type NewSocialAccount, type SocialAccount,
} from '../schema/index.js'

export interface ExpiringToken {
  socialAccountId: string
  orgId: string
  platform: SocialAccount['platform']
  refreshTokenEnc: string | null
  expiresAt: Date | null
}

export class SocialAccountRepository {
  async findAllForOrg(orgId: string): Promise<SocialAccount[]> {
    return db.select().from(socialAccounts).where(eq(socialAccounts.orgId, orgId))
  }

  async findById(orgId: string, id: string): Promise<SocialAccount | undefined> {
    const [row] = await db.select().from(socialAccounts)
      .where(and(eq(socialAccounts.id, id), eq(socialAccounts.orgId, orgId)))
      .limit(1)
    return row
  }

  async create(data: NewSocialAccount): Promise<SocialAccount> {
    const [row] = await db.insert(socialAccounts).values(data).returning()
    return row! // insert().returning() always yields exactly one row here
  }

  // (orgId, platform, externalAccountId) is unique — used to detect a
  // reconnect (same account, e.g. after reauth_required) vs. a genuinely
  // new connection.
  async findByExternal(orgId: string, platform: SocialAccount['platform'], externalAccountId: string): Promise<SocialAccount | undefined> {
    const [row] = await db.select().from(socialAccounts)
      .where(and(
        eq(socialAccounts.orgId, orgId),
        eq(socialAccounts.platform, platform),
        eq(socialAccounts.externalAccountId, externalAccountId),
      ))
      .limit(1)
    return row
  }

  async update(orgId: string, id: string, data: Partial<NewSocialAccount>): Promise<SocialAccount | undefined> {
    const [row] = await db.update(socialAccounts).set(data)
      .where(and(eq(socialAccounts.id, id), eq(socialAccounts.orgId, orgId)))
      .returning()
    return row
  }

  async setStatus(orgId: string, id: string, status: SocialAccount['status']) {
    const [row] = await db.update(socialAccounts).set({ status })
      .where(and(eq(socialAccounts.id, id), eq(socialAccounts.orgId, orgId)))
      .returning()
    return row
  }

  async delete(orgId: string, id: string) {
    await db.delete(socialAccounts).where(and(eq(socialAccounts.id, id), eq(socialAccounts.orgId, orgId)))
  }

  async upsertTokens(socialAccountId: string, data: Omit<NewOauthToken, 'socialAccountId'>) {
    const [row] = await db.insert(oauthTokens)
      .values({ socialAccountId, ...data })
      .onConflictDoUpdate({
        target: oauthTokens.socialAccountId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning()
    return row
  }

  async findTokens(socialAccountId: string) {
    const [row] = await db.select().from(oauthTokens)
      .where(eq(oauthTokens.socialAccountId, socialAccountId))
      .limit(1)
    return row
  }

  // Feeds the token-refresh background job, which runs independently of any
  // request context. Only active accounts with a refresh token are
  // candidates; reauth_required accounts are already flagged and skipped
  // until the user reconnects.
  async findTokensExpiringSoon(before: Date): Promise<ExpiringToken[]> {
    const rows = await db.select({
      socialAccountId: socialAccounts.id,
      orgId: socialAccounts.orgId,
      platform: socialAccounts.platform,
      refreshTokenEnc: oauthTokens.refreshTokenEnc,
      expiresAt: oauthTokens.expiresAt,
    })
      .from(oauthTokens)
      .innerJoin(socialAccounts, eq(oauthTokens.socialAccountId, socialAccounts.id))
      .where(and(
        eq(socialAccounts.status, 'active'),
        isNotNull(oauthTokens.expiresAt),
        lte(oauthTokens.expiresAt, before),
      ))
    return rows
  }
}
