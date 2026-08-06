import { eq } from 'drizzle-orm'
import { db } from '../connection.js'
import { organizations, type Organization } from '../schema/index.js'

// Single-operator mode: there is exactly one organization row, created on
// first boot (see src/auth/single-user.ts). This repository is intentionally
// tiny compared to the upstream cloud product's — no plan/billing/Stripe
// fields exist on this schema at all.
export class OrganizationRepository {
  async findById(id: string): Promise<Organization | undefined> {
    const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1)
    return row
  }

  async findFirst(): Promise<Organization | undefined> {
    const [row] = await db.select().from(organizations).limit(1)
    return row
  }

  async create(name = 'My Workspace'): Promise<Organization> {
    const [row] = await db.insert(organizations).values({ name }).returning()
    return row!
  }

  async updateName(id: string, name: string): Promise<Organization | undefined> {
    const [row] = await db.update(organizations).set({ name }).where(eq(organizations.id, id)).returning()
    return row
  }
}
