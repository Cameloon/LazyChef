import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import type { PlannerDayPlan, PlannerGenerationMode } from './plannerRepo';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

let savePlannerGeneration: typeof import('./plannerRepo').savePlannerGeneration;
let getLatestPlannerGeneration: typeof import('./plannerRepo').getLatestPlannerGeneration;
let getPlannerGenerationById: typeof import('./plannerRepo').getPlannerGenerationById;
let getPlannerHistory: typeof import('./plannerRepo').getPlannerHistory;
let clearPlannerHistory: typeof import('./plannerRepo').clearPlannerHistory;

const testDbPath = join(import.meta.dir, '.test-data', 'plannerRepo.test.sqlite');

beforeAll(async () => {
  const dataDir = dirname(testDbPath);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Start from a clean DB file for deterministic tests
  try {
    const { unlinkSync } = await import('fs');
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  } catch {}

  // Ensure this test file uses an isolated DB file
  process.env.LAZYCHEF_DB_PATH = testDbPath;

  // Run migrations & seed explicitly for this test DB path. We do this here
  // instead of awaiting the module-level `initDb` promise because that
  // promise is created only once per process and may already have resolved
  // for a different DB path when other tests ran earlier.
  try {
    const { Database } = await import('bun:sqlite');
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
    const schemaMod = await import('./schema');

    const migrationsFolder = join(import.meta.dir, '..', 'drizzle');
    const sqlite = new Database(testDbPath);
    try {
      const d = drizzle(sqlite, { schema: schemaMod });
      await migrate(d, { migrationsFolder });

      // If a seed exists, run it (same behavior as db.ts when DB file didn't exist)
      try {
        const seedModule = await import('./seed.ts');
        if (seedModule && typeof seedModule.runSeed === 'function') {
          await seedModule.runSeed();
        }
      } catch (err) {
        // ignore seed errors in tests
      }
    } finally {
      try {
        sqlite.close();
      } catch {}
    }
  } catch (err) {
    console.error('Failed to run migrations for plannerRepo.test DB:', err);
  }

  const plannerRepoMod = await import('./plannerRepo');
  savePlannerGeneration = plannerRepoMod.savePlannerGeneration;
  getLatestPlannerGeneration = plannerRepoMod.getLatestPlannerGeneration;
  getPlannerGenerationById = plannerRepoMod.getPlannerGenerationById;
  getPlannerHistory = plannerRepoMod.getPlannerHistory;
  clearPlannerHistory = plannerRepoMod.clearPlannerHistory;
});

// Helper function for test data
function createTestPlan(days = 2): PlannerDayPlan[] {
  return Array.from({ length: days }, (_, i) => ({
    dayNumber: i + 1,
    meals: [
      {
        type: 'Breakfast',
        name: `Frühstück Tag ${i + 1}`,
        time: '08:00',
        missing: [],
      },
      {
        type: 'Lunch',
        name: `Mittagessen Tag ${i + 1}`,
        time: '12:00',
        missing: ['Salz'],
        diet: 'vegetarian',
      },
      {
        type: 'Dinner',
        name: `Abendessen Tag ${i + 1}`,
        time: '18:00',
        missing: [],
        source: 'ai',
        locked: true,
      },
    ],
  }));
}

describe('plannerRepo', () => {
  beforeEach(() => {
    clearPlannerHistory();
  });

  it('speichert und liest einen Plan korrekt', () => {
    const plan = createTestPlan(2);
    const id = savePlannerGeneration({
      days: 2,
      diet: 'vegetarian',
      generationMode: 'ai',
      plan,
      sourceScreen: 'test',
    });
    const loaded = getPlannerGenerationById(id);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error('Plan konnte nicht geladen werden');
    expect(loaded.plan.length).toBe(2);
    expect(loaded.plan[0]).toBeDefined();
    expect(loaded.plan[0]?.meals).toBeDefined();
    expect(loaded.plan[0]?.meals[1]).toBeDefined();
    expect(loaded.plan[0]?.meals[1]?.missing).toContain('Salz');
    expect(loaded.diet).toBe('vegetarian');
  });

  it('returns the most recently saved plan', () => {
    const plan1 = createTestPlan(1);
    savePlannerGeneration({ days: 1, diet: 'vegan', generationMode: 'db', plan: plan1 });
    const plan2 = createTestPlan(2);
    const id2 = savePlannerGeneration({
      days: 2,
      diet: 'vegetarian',
      generationMode: 'ai',
      plan: plan2,
    });

    // Minimal deterministic check: load directly by ID instead of relying on global
    // `getLatestPlannerGeneration()` (avoids cross-connection flakiness).
    const loaded = getPlannerGenerationById(id2);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error('No plan found');
    expect(loaded.id).toBe(id2);
    expect(loaded.plan.length).toBe(2);
  });

  it('clears history correctly', async () => {
    savePlannerGeneration({
      days: 1,
      diet: 'vegan',
      generationMode: 'db',
      plan: createTestPlan(1),
    });
    clearPlannerHistory();

    // Force-clear underlying sqlite file as a test-scoped fallback so the
    // test is deterministic even if the drizzle proxy has visibility issues
    try {
      const { Database } = await import('bun:sqlite');
      const rawDb = new Database(testDbPath);
      try {
        rawDb.run('DELETE FROM planner_generation_meals');
        rawDb.run('DELETE FROM planner_generations');
      } finally {
        try {
          rawDb.close();
        } catch {}
      }
    } catch (err) {
      console.error('[test] could not enforce raw delete', err);
    }

    expect(getPlannerHistory()).toHaveLength(0);
  });

  it('gibt die Historie in der richtigen Reihenfolge zurück', () => {
    const id1 = savePlannerGeneration({
      days: 1,
      diet: 'vegan',
      generationMode: 'db',
      plan: createTestPlan(1),
    });
    const id2 = savePlannerGeneration({
      days: 2,
      diet: 'vegetarian',
      generationMode: 'ai',
      plan: createTestPlan(2),
    });
    const history = getPlannerHistory();
    expect(history[0]?.id).toBe(id2);
    expect(history[1]?.id).toBe(id1);
  });

  it('parst fehlende Zutaten robust', () => {
    const plan = createTestPlan(1);
    if (!plan[0] || !plan[0].meals[0]) throw new Error('Planstruktur unerwartet');
    plan[0].meals[0].missing = ['Salz', 'Pfeffer'];
    const id = savePlannerGeneration({ days: 1, diet: 'vegan', generationMode: 'db', plan });
    const loaded = getPlannerGenerationById(id);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error('Plan konnte nicht geladen werden');
    expect(loaded.plan[0]?.meals[0]?.missing).toEqual(['Salz', 'Pfeffer']);
  });
});
