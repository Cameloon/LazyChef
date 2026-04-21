import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

type ShoppingListsRepoModule = typeof import('./shoppingListsRepo');
type DbModule = typeof import('./db');
type SchemaModule = typeof import('./schema');

const testDbPath = join(import.meta.dir, '.test-data', 'LazychefDB.test.sqlite');
let repo: ShoppingListsRepoModule;
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

  // Do NOT delete the DB file — the db.ts singleton may already hold a live
  // connection to it (cached from another test file in the same bun test run).
  process.env.LAZYCHEF_DB_PATH = testDbPath;
  ensureSchema();

  repo = await import('./shoppingListsRepo');
  dbModule = await import('./db');
  schema = await import('./schema');
});

beforeEach(() => {
  // Clean all tables before each test
  dbModule.db.delete(schema.shoppingListItems).run();
  dbModule.db.delete(schema.shoppingLists).run();
  dbModule.db.delete(schema.recipeIngredients).run();
  dbModule.db.delete(schema.recipes).run();
  dbModule.db.delete(schema.inventory).run();
});

afterAll(() => {
  // Clean up process-level overrides; keep the DB file intact so the
  // cached db.ts singleton (shared across test files) isn't invalidated.
  delete process.env.LAZYCHEF_DB_PATH;
});

describe('shoppingListsRepo', () => {
  it('creates a shopping list and reads it back', () => {
    const id = repo.createShoppingList('Weekly Groceries');
    const lists = repo.getAllShoppingLists();

    expect(lists.length).toBe(1);
    expect(lists[0]!.name).toBe('Weekly Groceries');
    expect(lists[0]!.id).toBe(id);
  });

  it('deletes a shopping list and cascades items', () => {
    const listId = repo.createShoppingList('Temp List');
    repo.addItemToList(listId, { name: 'Milk', quantity: 2, unit: 'L' });

    repo.deleteShoppingList(listId);

    expect(repo.getAllShoppingLists().length).toBe(0);
    expect(repo.getShoppingListById(listId)).toBeNull();
  });

  it('adds, updates, and deletes items within a list', () => {
    const listId = repo.createShoppingList('My List');
    const itemId = repo.addItemToList(listId, { name: 'Eggs', quantity: 12, unit: 'pcs' });

    let detail = repo.getShoppingListById(listId);
    expect(detail?.items.length).toBe(1);
    expect(detail?.items[0]!.name).toBe('Eggs');

    repo.updateListItem(itemId, { name: 'Free-range Eggs', quantity: 6 });
    detail = repo.getShoppingListById(listId);
    expect(detail?.items[0]!.name).toBe('Free-range Eggs');
    expect(detail?.items[0]!.quantity).toBe(6);

    repo.deleteListItem(itemId);
    detail = repo.getShoppingListById(listId);
    expect(detail?.items.length).toBe(0);
  });

  it('generates a shopping list with low-stock inventory items', () => {
    // Insert inventory items — only low-stock essentials should appear
    dbModule.db
      .insert(schema.inventory)
      .values({ name: 'Flour', category: 'Essentials', quantity: 0, unit: 'kg' })
      .run();
    dbModule.db
      .insert(schema.inventory)
      .values({ name: 'Sugar', category: 'Essentials', quantity: 5, unit: 'kg' })
      .run();
    dbModule.db
      .insert(schema.inventory)
      .values({ name: 'Milk', category: 'Liquid', quantity: 0, unit: 'L' })
      .run();
    dbModule.db
      .insert(schema.inventory)
      .values({ name: 'Salt', category: null, quantity: 0, unit: 'g' })
      .run();

    const id = repo.generateShoppingList();
    const list = repo.getShoppingListById(id);

    expect(list).not.toBeNull();
    expect(list!.items.length).toBe(1);
    expect(list!.items.some((i) => i.name === 'Flour')).toBe(true);
    expect(list!.items.some((i) => i.name === 'Sugar')).toBe(false);
    expect(list!.items.some((i) => i.name === 'Milk')).toBe(false);
    // No category set -> should not be included when generating essentials-only list
    expect(list!.items.some((i) => i.name === 'Salt')).toBe(false);
  });

  it('returns null for non-existent list', () => {
    expect(repo.getShoppingListById(999)).toBeNull();
  });
});
