import { beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';

const testDbPath = join(import.meta.dir, '.test-data', 'seed.test.sqlite');

let runSeed: typeof import('./seed').runSeed;
let db: typeof import('./db').db;
let schema: typeof import('./schema');

beforeAll(async () => {
  const dataDir = dirname(testDbPath);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (existsSync(testDbPath)) unlinkSync(testDbPath);

  process.env.LAZYCHEF_DB_PATH = testDbPath;

  const dbModule = await import('./db');
  await dbModule.ensureInitDb();

  runSeed = (await import('./seed')).runSeed;
  db = dbModule.db;
  schema = await import('./schema');
});

describe('seed inventory items', () => {
  it('uses plain English item names without descriptive suffixes', async () => {
    await runSeed();

    const items = db.select({ name: schema.inventory.name }).from(schema.inventory).all();
    const names = items.map((item) => item.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('Mehl Type 405');
    expect(names).not.toContain('Vollmilch 3.5%');
    expect(names).not.toContain('Rotwein (Primitivo)');

    for (const name of names) {
      expect(name).not.toContain('Vol.');
      expect(name).toMatch(/^[a-z ]+$/);
    }
  });

  it('uses english units in seeded inventory data', async () => {
    await runSeed();

    const items = await db.select({ unit: schema.inventory.unit }).from(schema.inventory).all();
    const units = items.map((item) => item.unit);

    expect(units.length).toBeGreaterThan(0);
    expect(units).toContain('pcs');
    expect(units).toContain('pkg');
    expect(units).not.toContain('Stk');
    expect(units).not.toContain('Pkg');
  });
});
