import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../connection.js'
import { media, type Media, type NewMedia } from '../schema/index.js'

export class MediaRepository {
  async create(data: NewMedia): Promise<Media> {
    const [row] = await db.insert(media).values(data).returning()
    return row! // insert().returning() always yields exactly one row here
  }

  async findByIds(orgId: string, ids: string[]): Promise<Media[]> {
    if (ids.length === 0) return []
    return db.select().from(media).where(and(eq(media.orgId, orgId), inArray(media.id, ids)))
  }

  // The media library, newest first. Bounded by `limit` so an agent asking
  // "what images do I have" can't pull an org's entire upload history.
  async findAllForOrg(orgId: string, limit = 50): Promise<Media[]> {
    return db.select().from(media)
      .where(eq(media.orgId, orgId))
      .orderBy(desc(media.createdAt))
      .limit(limit)
  }
}
