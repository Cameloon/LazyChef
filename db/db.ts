import { existsSync } from 'fs';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

import { isAbsolute, join } from 'path';

// Support dynamic DB path selection. Tests set `process.env.LAZYCHEF_DB_PATH`
// before importing DB modules; when the path changes at runtime we re-initialize
// the underlying sqlite/drizzle instances so different test files don't
// interfere via a shared, stale connection.

// Maintain a cache of connections per DB path to avoid closing/replacing
// sqlite instances during test runs where multiple DB paths are used.
const connections: Map<
  string,
  {
    sqlite: Database;
    drizzle: ReturnType<typeof drizzle>;
    initPromise: Promise<void> | null;
  }
> = new Map();

let drizzleInstance: ReturnType<typeof drizzle> | null = null;
let currentPathUsed: string | null = null;

const computePathToDB = (): string => {
  const configuredDbPath = process.env.LAZYCHEF_DB_PATH;
  return configuredDbPath
    ? isAbsolute(configuredDbPath)
      ? configuredDbPath
      : join(import.meta.dir, configuredDbPath)
    : join(import.meta.dir, 'LazychefDB.sqlite');
};

const createConnection = (pathToDB: string, dbFileExisted: boolean | null = null) => {
  if (connections.has(pathToDB)) {
    const existing = connections.get(pathToDB)!;
    drizzleInstance = existing.drizzle;
    currentPathUsed = pathToDB;
    return;
  }

  // Check whether the file exists before Database may create it.
  const fileExisted = dbFileExisted === null ? existsSync(pathToDB) : dbFileExisted;

  console.log(`[db] Creating sqlite instance for path=${pathToDB}`);
  const sqliteInstance = new Database(pathToDB);
  // Enable FK enforcement per connection
  try {
    sqliteInstance.run('PRAGMA foreign_keys = ON;');
  } catch {}

  const newDrizzle = drizzle(sqliteInstance, { schema });
  connections.set(pathToDB, { sqlite: sqliteInstance, drizzle: newDrizzle, initPromise: null });
  drizzleInstance = newDrizzle;
  currentPathUsed = pathToDB;
  // Store whether the file existed for migration/seeding logic.
  (connections.get(pathToDB) as any).fileExisted = fileExisted;
};

const runMigrationsAndSeed = async (pathToDB: string) => {
  // Read whether the file existed from the connection (checked before DB creation).
  const entry = connections.get(pathToDB);
  const dbFileExisted = entry && 'fileExisted' in entry ? entry.fileExisted : existsSync(pathToDB);
  console.log(`Using DB file: ${pathToDB}`);
  try {
    const migrationsFolder = join(import.meta.dir, '..', 'drizzle');
    console.log(`Running migrations (folder=${migrationsFolder}, existed=${dbFileExisted})`);

    // Use the drizzle instance associated with this path
    if (!entry) throw new Error('No drizzle instance for path when running migrations');
    await migrate(entry.drizzle, { migrationsFolder });
    console.log('Migrationen ausgeführt.');

    const inventoryCountRow = entry.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(schema.inventory)
      .get();
    const recipesCountRow = entry.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(schema.recipes)
      .get();
    const inventoryCount = Number(inventoryCountRow?.count ?? 0);
    const recipesCount = Number(recipesCountRow?.count ?? 0);
    const shouldRunSeed = !dbFileExisted || (inventoryCount === 0 && recipesCount === 0);

    if (shouldRunSeed) {
      console.log(
        'Seed wird ausgeführt (neue DB oder leere Seed-Tabellen inventory/recipes erkannt)...',
      );
      try {
        const seedModule = await import('./seed.ts');
        if (seedModule && typeof seedModule.runSeed === 'function') {
          await seedModule.runSeed();
        } else {
          console.warn('Seed-Modul exportiert keine runSeed-Funktion.');
        }
      } catch (err) {
        console.error('Konnte Seed-Modul nicht importieren oder ausführen:', err);
      }
      console.log('Seeding abgeschlossen.');
    } else {
      console.log(
        `Seed übersprungen (inventory=${inventoryCount}, recipes=${recipesCount}, dbExisted=${dbFileExisted}).`,
      );
    }
  } catch (err) {
    console.error('Fehler beim Anwenden der Migrationen oder Seed:', err);
    throw err;
  }
};

const ensureInitialized = (): void => {
  const path = computePathToDB();
  if (!drizzleInstance || currentPathUsed !== path) {
    console.log(
      `[db] ensureInitialized: reinitializing for path=${path} (current=${currentPathUsed})`,
    );
    // create connection synchronously; run migrations asynchronously
    createConnection(path);
    const entry = connections.get(path)!;
    entry.initPromise = runMigrationsAndSeed(path).catch((err) => {
      throw err;
    });
    // expose the active drizzle instance for immediate usage
    drizzleInstance = entry.drizzle;
  }
};

// Exported Proxy so existing imports `import { db } from './db'` keep working.
export const db: any = new Proxy(
  {},
  {
    get(_, prop: PropertyKey) {
      ensureInitialized();
      const inst: any = drizzleInstance as any;
      if (!inst) throw new Error('Database instance not initialized');
      const value = inst[prop as any];
      if (typeof value === 'function') return value.bind(inst);
      return value;
    },
    has(_, prop: PropertyKey) {
      ensureInitialized();
      const inst: any = drizzleInstance as any;
      return prop in inst;
    },
  },
);

// Expose a promise that resolves when the current initialization (migrations/seed)
// has completed. Tests may await this if they need to ensure schema is applied.
const awaitCurrentInit = async (): Promise<void> => {
  const entry = currentPathUsed ? connections.get(currentPathUsed) : undefined;
  if (entry && entry.initPromise) await entry.initPromise;
};

export const initDb = (async () => {
  ensureInitialized();
  await awaitCurrentInit();
})();

// Explicit helper to initialize/await the currently configured DB path.
// Useful for tests that need to switch `LAZYCHEF_DB_PATH` at runtime.
export const ensureInitDb = async (): Promise<void> => {
  ensureInitialized();
  await awaitCurrentInit();
};

// Helper for debugging: return the currently used DB path (may trigger init)
export const getCurrentDbPath = (): string | null => {
  try {
    ensureInitialized();
    return currentPathUsed;
  } catch {
    return currentPathUsed;
  }
};
