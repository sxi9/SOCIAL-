import { defineConfig } from 'drizzle-kit';

// Migrations are hand-written SQL in src/db/migrations and applied by
// src/db/migrate.ts (journal table). drizzle-kit is used for schema
// diffing/inspection only.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/socialchat',
  },
});
