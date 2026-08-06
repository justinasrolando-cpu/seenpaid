import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/data-access/schema/index.ts',
  out: './src/data-access/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
