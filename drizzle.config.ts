import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Folder where generated SQL migrations and metadata are stored
  out: './drizzle',
  // TypeScript schema definitions used as source of truth
  schema: './db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    // drizzle-kit (via libsql client) expects file: URL format for SQLite
    url: 'file:./db/LazychefDB.sqlite',
  },
  // Log SQL generation/migration steps for easier debugging
  verbose: true,
  // Fail fast if config/schema contains invalid or ambiguous settings
  strict: true,
});
