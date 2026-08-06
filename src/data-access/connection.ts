import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema/index.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
})

export const db = drizzle(pool, { schema })
