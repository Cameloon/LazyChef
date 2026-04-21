import { desc, eq, asc } from 'drizzle-orm';
import { db } from './db';
import { plannerGenerations, plannerGenerationMeals } from './schema';

export type PlannerMeal = {
  type: 'Breakfast' | 'Lunch' | 'Dinner';
  name: string;
  time: string;
  missing: string[];
  diet?: string;
  source?: 'ai' | 'manual' | 'db' | 'mixed' | 'self-planned' | 'stock';
  locked?: boolean;
};

export type PlannerDayPlan = {
  dayNumber: number;
  meals: PlannerMeal[];
};

export type PlannerGenerationMode = 'db' | 'ai' | 'mixed' | 'self-planned' | 'stock';

export type PlannerHistoryEntry = {
  id: number;
  createdAt: string;
  days: number;
  diet: string;
  generationMode: PlannerGenerationMode;
  sourceScreen: string;
  plan: PlannerDayPlan[];
};

type PlannerGenerationRow = typeof plannerGenerations.$inferSelect;
type PlannerMealRow = typeof plannerGenerationMeals.$inferSelect;

const parseJsonStringArray = (value: string | null): string[] => {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
};

const toMeal = (row: PlannerMealRow): PlannerMeal => ({
  type: row.mealType as PlannerMeal['type'],
  name: row.name,
  time: row.time,
  missing: parseJsonStringArray(row.missing),
  diet: row.diet ?? undefined,
  source: (row.source as PlannerMeal['source']) ?? undefined,
  locked: Boolean(row.locked),
});

const toPlan = (
  generationRow: PlannerGenerationRow,
  mealRows: PlannerMealRow[],
): PlannerHistoryEntry => {
  const grouped = new Map<number, PlannerMeal[]>();

  for (const mealRow of mealRows) {
    const current = grouped.get(mealRow.dayNumber) ?? [];
    current.push(toMeal(mealRow));
    grouped.set(mealRow.dayNumber, current);
  }

  const plan: PlannerDayPlan[] = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayNumber, meals]) => ({
      dayNumber,
      meals: meals.sort((a, b) => {
        const getIndex = (type: PlannerMeal['type']) =>
          type === 'Breakfast' ? 0 : type === 'Lunch' ? 1 : 2;

        return getIndex(a.type) - getIndex(b.type);
      }),
    }));

  return {
    id: generationRow.id,
    createdAt: generationRow.createdAt,
    days: generationRow.days,
    diet: generationRow.diet,
    generationMode: generationRow.generationMode as PlannerGenerationMode,
    sourceScreen: generationRow.sourceScreen,
    plan,
  };
};

export const savePlannerGeneration = (input: {
  days: number;
  diet: string;
  generationMode: PlannerGenerationMode;
  plan: PlannerDayPlan[];
  sourceScreen?: string;
}): number => {
  return db.transaction((tx: any) => {
    const inserted = tx
      .insert(plannerGenerations)
      .values({
        createdAt: new Date().toISOString(),
        days: input.days,
        diet: input.diet,
        generationMode: input.generationMode,
        sourceScreen: input.sourceScreen ?? 'planner',
      })
      .returning({ id: plannerGenerations.id })
      .get();

    for (const day of input.plan) {
      for (const [mealIndex, meal] of day.meals.entries()) {
        tx.insert(plannerGenerationMeals)
          .values({
            generationId: inserted.id,
            dayNumber: day.dayNumber,
            mealIndex,
            mealType: meal.type,
            name: meal.name,
            time: meal.time,
            missing: JSON.stringify(meal.missing ?? []),
            diet: meal.diet ?? null,
            source: meal.source ?? null,
            locked: Boolean(meal.locked),
            recipeTitle: meal.name,
          })
          .run();
      }
    }

    return inserted.id;
  });
};

export const getPlannerGenerationById = (generationId: number): PlannerHistoryEntry | null => {
  const generationRow = db
    .select()
    .from(plannerGenerations)
    .where(eq(plannerGenerations.id, generationId))
    .get();

  if (!generationRow) return null;

  const mealRows = db
    .select()
    .from(plannerGenerationMeals)
    .where(eq(plannerGenerationMeals.generationId, generationId))
    .orderBy(asc(plannerGenerationMeals.dayNumber), asc(plannerGenerationMeals.mealIndex))
    .all();

  return toPlan(generationRow, mealRows);
};

export const getLatestPlannerGeneration = (): PlannerHistoryEntry | null => {
  // Use insertion order semantics to avoid timestamp tie edge cases
  const generationRow = db
    .select()
    .from(plannerGenerations)
    // id is monotonic and avoids timestamp tie issues on rapid consecutive saves
    .orderBy(desc(plannerGenerations.id))
    .get();

  if (!generationRow) return null;

  return getPlannerGenerationById(generationRow.id);
};

export const getPlannerHistory = (): PlannerHistoryEntry[] => {
  const generationRows = db
    .select()
    .from(plannerGenerations)
    .orderBy(desc(plannerGenerations.id))
    .all();

  return generationRows.map((row: PlannerGenerationRow) => {
    const mealRows = db
      .select()
      .from(plannerGenerationMeals)
      .where(eq(plannerGenerationMeals.generationId, row.id))
      .orderBy(asc(plannerGenerationMeals.dayNumber), asc(plannerGenerationMeals.mealIndex))
      .all();

    return toPlan(row, mealRows);
  });
};

export const clearPlannerHistory = (): void => {
  // Cascades to planner_generation_meals via foreign key relation
  db.delete(plannerGenerations).run();
};
