import { and, eq, exists, getTableColumns, lte, sql } from 'drizzle-orm'
import { db } from '../connection.js'
import {
  postTargets, posts, platformEnum,
  type NewPost, type NewPostTarget, type Post, type PostTarget,
} from '../schema/index.js'

export class PostRepository {
  async findAllForOrg(orgId: string): Promise<Post[]> {
    return db.select().from(posts).where(eq(posts.orgId, orgId)).orderBy(posts.createdAt)
  }

  // One row per target in the org — used to attach the list of platforms each
  // post went to AND, for failed targets, the reason it failed (so the post
  // card can tell the user WHY instead of a dead "failed" badge).
  async platformsForOrg(orgId: string): Promise<{ postId: string; platform: string; status: string; errorMessage: string | null }[]> {
    return db.select({
      postId: postTargets.postId,
      platform: postTargets.platform,
      status: postTargets.status,
      errorMessage: postTargets.errorMessage,
    })
      .from(postTargets)
      .innerJoin(posts, eq(posts.id, postTargets.postId))
      .where(eq(posts.orgId, orgId))
  }

  async countForOrg(orgId: string): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)::int` })
      .from(posts).where(eq(posts.orgId, orgId))
    return row?.count ?? 0
  }

  async publishedCountByPlatform(orgId: string): Promise<{ platform: (typeof platformEnum.enumValues)[number]; count: number }[]> {
    return db.select({ platform: postTargets.platform, count: sql<number>`count(*)::int` })
      .from(postTargets)
      .innerJoin(posts, eq(postTargets.postId, posts.id))
      .where(and(eq(posts.orgId, orgId), eq(postTargets.status, 'published')))
      .groupBy(postTargets.platform)
  }

  async findById(orgId: string, id: string): Promise<Post | undefined> {
    const [row] = await db.select().from(posts)
      .where(and(eq(posts.id, id), eq(posts.orgId, orgId)))
      .limit(1)
    return row
  }

  async create(data: NewPost): Promise<Post> {
    const [row] = await db.insert(posts).values(data).returning()
    return row! // insert().returning() always yields exactly one row here
  }

  async update(orgId: string, id: string, data: Partial<NewPost>): Promise<Post | undefined> {
    const [row] = await db.update(posts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(posts.id, id), eq(posts.orgId, orgId)))
      .returning()
    return row
  }

  async delete(orgId: string, id: string) {
    await db.delete(posts).where(and(eq(posts.id, id), eq(posts.orgId, orgId)))
  }

  // Picked up by the scheduler's polling tick / BullMQ delayed-job fallback.
  async findDuePosts(before: Date): Promise<Post[]> {
    return db.select().from(posts)
      .where(and(eq(posts.status, 'scheduled'), lte(posts.scheduledFor, before)))
  }

  async createTargets(data: NewPostTarget[]): Promise<PostTarget[]> {
    if (data.length === 0) return []
    return db.insert(postTargets).values(data).returning()
  }

  // Defense-in-depth: post_targets carry no orgId of their own (they hang off
  // a post via postId — see schema), so tenant isolation is enforced by
  // joining to the parent post and constraining posts.orgId.
  async findTargetsForPost(orgId: string, postId: string): Promise<PostTarget[]> {
    return db.select(getTableColumns(postTargets)).from(postTargets)
      .innerJoin(posts, eq(postTargets.postId, posts.id))
      .where(and(eq(postTargets.postId, postId), eq(posts.orgId, orgId)))
  }

  // Same tenant guard as findTargetsForPost, expressed as an EXISTS subquery
  // because UPDATE can't JOIN in Postgres.
  async updateTarget(orgId: string, id: string, data: Partial<NewPostTarget>): Promise<PostTarget | undefined> {
    const [row] = await db.update(postTargets).set(data)
      .where(and(
        eq(postTargets.id, id),
        exists(db.select({ one: posts.id }).from(posts)
          .where(and(eq(posts.id, postTargets.postId), eq(posts.orgId, orgId)))),
      ))
      .returning()
    return row
  }
}
