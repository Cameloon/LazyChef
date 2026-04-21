import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

const testDbPath = join(import.meta.dir, '.test-data', 'db.init.seed-empty.sqlite');

const removeTestDb = () => {
  try {
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  } catch {
    // Best-effort cleanup for deterministic tests.
  }
};

afterAll(() => {
  delete process.env.LAZYCHEF_DB_PATH;
  removeTestDb();
});

describe('db init', () => {
  it('runs seed automatically when existing DB has empty inventory and recipes tables', async () => {
    const dataDir = dirname(testDbPath);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    removeTestDb();

    const schemaMod = await import('./schema');
    const sqlite = new Database(testDbPath);
    try {
      const migrationsFolder = join(import.meta.dir, '..', 'drizzle');
      await migrate(drizzle(sqlite, { schema: schemaMod }), { migrationsFolder });
    } finally {
      sqlite.close();
    }

    process.env.LAZYCHEF_DB_PATH = testDbPath;
    const dbModule = await import('./db');
    await dbModule.ensureInitDb();

    const verify = new Database(testDbPath);
    try {
      const verifyDb = drizzle(verify, { schema: schemaMod });
      const inventoryCount = Number(
        verifyDb
          .select({ count: sql<number>`count(*)` })
          .from(schemaMod.inventory)
          .get()?.count ?? 0,
      );
      const recipesCount = Number(
        verifyDb
          .select({ count: sql<number>`count(*)` })
          .from(schemaMod.recipes)
          .get()?.count ?? 0,
      );

      expect(inventoryCount).toBeGreaterThan(0);
      expect(recipesCount).toBeGreaterThan(0);
    } finally {
      verify.close();
    }
  });
});
