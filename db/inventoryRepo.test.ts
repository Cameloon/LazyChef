import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

type InventoryRepoModule = typeof import('./inventoryRepo');
type DbModule = typeof import('./db');
type SchemaModule = typeof import('./schema');

const testDbPath = join(import.meta.dir, '.test-data', 'LazychefDB.inventoryRepo.test.sqlite');
let repo: InventoryRepoModule;
let dbModule: DbModule;
let schema: SchemaModule;

const ensureSchema = (): void => {
  const sqlite = new Database(testDbPath);

  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      quantity REAL DEFAULT 0 NOT NULL,
      unit TEXT DEFAULT 'pcs' NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_name TEXT NOT NULL UNIQUE,
      target_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      servings INTEGER,
      duration INTEGER,
      difficulty TEXT,
      habits TEXT,
      categories TEXT,
      ingredients TEXT,
      instructions TEXT
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL,
      unit TEXT NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipe_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      step_text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shopping_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shopping_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      quantity REAL DEFAULT 1 NOT NULL,
      unit TEXT DEFAULT 'pcs' NOT NULL
    );
  `);

  sqlite.close();
};

beforeAll(async () => {
  const dataDir = dirname(testDbPath);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  process.env.LAZYCHEF_DB_PATH = testDbPath;
  ensureSchema();

  repo = await import('./inventoryRepo');
  dbModule = await import('./db');
  schema = await import('./schema');
});

beforeEach(() => {
  dbModule.db.delete(schema.inventory).run();
  dbModule.db.delete(schema.itemAliases).run();
});

afterAll(() => {
  delete process.env.LAZYCHEF_DB_PATH;
});

describe('inventoryRepo', () => {
  it('inserts a new inventory item when none exists', () => {
    repo.addOrUpdateInventoryItem({ name: 'Flour', quantity: 2, unit: 'kg' });

    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Flour');
    expect(rows[0]!.quantity).toBe(2);
    expect(rows[0]!.unit).toBe('kg');
  });

  it('increases quantity for an existing inventory item', () => {
    dbModule.db.insert(schema.inventory).values({ name: 'Milk', quantity: 3, unit: 'L' }).run();

    repo.addOrUpdateInventoryItem({ name: 'Milk', quantity: 2, unit: 'L' });

    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.quantity).toBe(5);
  });

  it('merges similar interpreted item names to avoid duplicates', () => {
    dbModule.db.insert(schema.inventory).values({ name: 'Milch', quantity: 1, unit: 'L' }).run();

    repo.addOrUpdateInventoryItem({ name: 'Bio Milch', quantity: 2, unit: 'L' });

    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Milch');
    expect(rows[0]!.quantity).toBe(3);
  });

  it('does not merge similar names when units differ', () => {
    dbModule.db.insert(schema.inventory).values({ name: 'Milch', quantity: 1, unit: 'L' }).run();

    repo.addOrUpdateInventoryItem({ name: 'Bio Milch', quantity: 500, unit: 'ml' });

    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(2);
  });

  it('resolves aliases from itemAliases table', () => {
    dbModule.db
      .insert(schema.itemAliases)
      .values({ scannedName: 'Oatly Barista', targetName: 'Hafermilch (Oatly)' })
      .run();

    const resolved = repo.resolveAlias('Oatly Barista');
    expect(resolved).toBe('Hafermilch (Oatly)');
  });

  it('returns original name when no alias exists', () => {
    const resolved = repo.resolveAlias('Unknown Product');
    expect(resolved).toBe('Unknown Product');
  });

  it('adds multiple items to inventory in batch', () => {
    const count = repo.addItemsToInventory([
      { name: 'Eggs', quantity: 12, unit: 'pcs' },
      { name: 'Butter', quantity: 1, unit: 'Pkg' },
    ]);

    expect(count).toBe(2);
    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(2);
  });

  it('parses receipt line with quantity and unit', () => {
    const parsed = repo.parseReceiptLine('2 kg Flour');
    expect(parsed).not.toBeNull();
    expect(parsed!.quantity).toBe(2);
    expect(parsed!.unit).toBe('kg');
    expect(parsed!.name).toBe('Flour');
  });

  it('parses receipt line with quantity only (no unit)', () => {
    const parsed = repo.parseReceiptLine('3x Milk');
    expect(parsed).not.toBeNull();
    expect(parsed!.quantity).toBe(3);
    expect(parsed!.unit).toBe('pcs');
    expect(parsed!.name).toBe('Milk');
  });

  it('parses receipt line with name only', () => {
    const parsed = repo.parseReceiptLine('Butter');
    expect(parsed).not.toBeNull();
    expect(parsed!.quantity).toBe(1);
    expect(parsed!.unit).toBe('pcs');
    expect(parsed!.name).toBe('Butter');
  });

  it('returns null for empty receipt lines', () => {
    expect(repo.parseReceiptLine('')).toBeNull();
    expect(repo.parseReceiptLine('   ')).toBeNull();
  });

  it('resolves aliases during receipt parsing', () => {
    dbModule.db
      .insert(schema.itemAliases)
      .values({ scannedName: 'Oatly Barista', targetName: 'Hafermilch (Oatly)' })
      .run();

    const parsed = repo.parseReceiptLine('2 L Oatly Barista');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Hafermilch (Oatly)');
    expect(parsed!.quantity).toBe(2);
    expect(parsed!.unit).toBe('L');
  });

  it('processes multiline receipt text', () => {
    const receiptText = '2 kg Flour\n3 L Milk\nButter';
    const count = repo.processReceiptText(receiptText);

    expect(count).toBe(3);
    const rows = dbModule.db.select().from(schema.inventory).all();
    expect(rows.length).toBe(3);
  });
});
