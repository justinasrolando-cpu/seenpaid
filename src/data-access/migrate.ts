import 'dotenv/config'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db } from './connection.js'
import { log } from '../observability/logger.js'

// Migration runner. Run this once after `docker compose up` (or any time you
// change the schema) — Postgres does NOT migrate itself. See SELF_HOST.md.
//
// The advisory lock serialises concurrent runs — harmless here (single
// instance) but cheap insurance if you ever run the API and worker as
// separate processes that could both try to migrate on boot.
const MIGRATION_LOCK_ID = 4827301

try {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`)
  try {
    await migrate(db, { migrationsFolder: './src/data-access/migrations' })
    log.info('Migrations applied')
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`)
  }
  process.exit(0)
} catch (err) {
  log.error({ err }, 'Migration FAILED')
  process.exit(1)
}
