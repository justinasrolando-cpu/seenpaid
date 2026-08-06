import { and, eq, inArray } from 'drizzle-orm'
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
}
