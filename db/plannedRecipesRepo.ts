import { asc } from 'drizzle-orm';
import { db } from './db';
import { plannedRecipeEntries } from './schema';

export type PlannedRecipeEntry = {
  recipeId: number;
  servings: number;
};

// Keep servings safe and consistent across UI and DB
const toNormalizedServings = (value: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
};

export const getPlannedRecipeEntries = (): PlannedRecipeEntry[] => {
  // Preserve insertion order using explicit position
  const rows = db
    .select()
    .from(plannedRecipeEntries)
    .orderBy(asc(plannedRecipeEntries.position), asc(plannedRecipeEntries.id))
    .all();

  return rows.map((row) => ({
    recipeId: row.recipeId,
    servings: toNormalizedServings(row.servings),
  }));
};

export const replacePlannedRecipeEntries = (entries: PlannedRecipeEntry[]): void => {
  // Replace full snapshot so order and deletions stay in sync
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.delete(plannedRecipeEntries).run();

    for (const [position, entry] of entries.entries()) {
      tx.insert(plannedRecipeEntries)
        .values({
          position,
          recipeId: entry.recipeId,
          servings: toNormalizedServings(entry.servings),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });
};
