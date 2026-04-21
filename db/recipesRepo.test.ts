import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

type RecipesRepoModule = typeof import('./recipesRepo');
type DbModule = typeof import('./db');
type SchemaModule = typeof import('./schema');

type RecipeInput = {
  title: string;
  servings?: number | null;
  duration?: number | null;
  difficulty?: string | null;
  habits?: string[];
  categories?: string[];
  ingredients: { amount: number; unit: string; name: string }[];
  steps: string[];
};

const testDbPath = join(import.meta.dir, '.test-data', 'LazychefDB.test.sqlite');
let recipesRepo: RecipesRepoModule;
let dbModule: DbModule;
let schema: SchemaModule;

const ensureSchema = (): void => {
  // Build only the tables needed for repository tests
  const sqlite = new Database(testDbPath);

  sqlite.exec(`
    PRAGMA foreign_keys = ON;

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

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      quantity REAL DEFAULT 0 NOT NULL,
      unit TEXT DEFAULT 'pcs' NOT NULL
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

const buildRecipeInput = (overrides: Partial<RecipeInput> = {}): RecipeInput => ({
  title: 'Test Pasta',
  servings: 2,
  duration: 20,
  difficulty: 'easy',
  habits: ['all'],
  categories: ['dinner'],
  ingredients: [
    { amount: 200, unit: 'g', name: 'Pasta' },
    { amount: 150, unit: 'ml', name: 'Tomato sauce' },
  ],
  steps: ['Boil pasta', 'Add sauce'],
  ...overrides,
});

beforeAll(async () => {
  const dataDir = dirname(testDbPath);
  // Ensure the local test-data directory exists before opening SQLite
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Point the repository layer to an isolated DB file for deterministic tests
  process.env.LAZYCHEF_DB_PATH = testDbPath;
  // Create minimal schema for the tests and then ensure migrations/seed
  ensureSchema();
  dbModule = await import('./db');
  if (dbModule && dbModule.initDb) await dbModule.initDb;

  recipesRepo = await import('./recipesRepo');
  schema = await import('./schema');
});

beforeEach(() => {
  // Reset all recipe tables so each test starts from a clean state
  dbModule.db.delete(schema.recipeIngredients).run();
  dbModule.db.delete(schema.recipeSteps).run();
  dbModule.db.delete(schema.recipes).run();
});

afterAll(() => {
  // Clean up process-level overrides; keep the DB file intact so the
  // cached db.ts singleton (shared across test files) isn't invalidated.
  delete process.env.LAZYCHEF_DB_PATH;
});

describe('recipesRepo', () => {
  it('creates a recipe and reads it back with ordered ingredients and steps', () => {
    const recipeId = recipesRepo.createRecipe(buildRecipeInput());

    const created = recipesRepo.getRecipeById(recipeId);
    expect(created).not.toBeNull();
    expect(created?.title).toBe('Test Pasta');
    expect(created?.ingredients).toEqual([
      { amount: 200, unit: 'g', name: 'Pasta' },
      { amount: 150, unit: 'ml', name: 'Tomato sauce' },
    ]);
    expect(created?.steps).toEqual(['Boil pasta', 'Add sauce']);
  });

  it('rejects createRecipe when title is empty after trim', () => {
    expect(() => recipesRepo.createRecipe(buildRecipeInput({ title: '   ' }))).toThrow(
      'Recipe title must not be empty.',
    );
  });

  it('replaces recipe content and removes previous child rows', () => {
    const recipeId = recipesRepo.createRecipe(buildRecipeInput());

    recipesRepo.replaceRecipeContent(
      recipeId,
      buildRecipeInput({
        title: 'Updated Soup',
        ingredients: [{ amount: 1, unit: 'l', name: 'Vegetable broth' }],
        steps: ['Heat broth'],
      }),
    );

    const updated = recipesRepo.getRecipeById(recipeId);
    expect(updated?.title).toBe('Updated Soup');
    expect(updated?.ingredients).toEqual([{ amount: 1, unit: 'l', name: 'Vegetable broth' }]);
    expect(updated?.steps).toEqual(['Heat broth']);
  });

  it('updates categories and supports normalized title existence check', () => {
    const recipeId = recipesRepo.createRecipe(buildRecipeInput({ title: '  Chili  ' }));

    expect(recipesRepo.recipeExistsByTitle('Chili')).toBe(true);
    expect(recipesRepo.recipeExistsByTitle('  Chili  ')).toBe(true);

    recipesRepo.updateRecipeCategoriesById(recipeId, ['favorite', 'dinner']);
    const updated = recipesRepo.getRecipeById(recipeId);
    expect(updated?.categories).toEqual(['favorite', 'dinner']);
  });

  it('returns empty arrays for malformed stored habits/categories JSON', () => {
    const recipeId = recipesRepo.createRecipe(buildRecipeInput());

    // Simulate legacy malformed payloads to verify safe fallback parsing
    dbModule.db
      .update(schema.recipes)
      .set({
        habits: '{broken-json',
        categories: '{broken-json',
      })
      .where(eq(schema.recipes.id, recipeId))
      .run();

    const recipe = recipesRepo.getRecipeById(recipeId);
    expect(recipe?.habits).toEqual([]);
    expect(recipe?.categories).toEqual([]);
  });
});
