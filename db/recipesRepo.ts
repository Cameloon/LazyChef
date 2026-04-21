import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { allergens, recipeIngredients, recipes, recipeSteps } from './schema';

// Provide aggregate read and write operations for recipe data
export type RecipeIngredientInput = {
  amount: number;
  unit: string;
  name: string;
};

export type RecipeInput = {
  title: string;
  servings?: number | null;
  duration?: number | null;
  difficulty?: string | null;
  habits?: string[];
  diets?: string[];
  categories?: string[];
  ingredients: RecipeIngredientInput[];
  steps: string[];
};

export type RecipeAggregate = {
  id: number;
  title: string;
  servings: number | null;
  duration: number | null;
  difficulty: string | null;
  habits: string[];
  diets: string[];
  categories: string[];
  ingredients: RecipeIngredientInput[];
  steps: string[];
};

type RecipeRow = typeof recipes.$inferSelect;
type RecipeIngredientRow = typeof recipeIngredients.$inferSelect;
type RecipeStepRow = typeof recipeSteps.$inferSelect;

const normalizeTitle = (value: string) => value.trim();

const toLegacyIngredients = (items: RecipeIngredientInput[]) => JSON.stringify(items);

const toLegacyInstructions = (steps: string[]) => JSON.stringify(steps);

// Persist tag-like fields as JSON arrays in text columns
const toLegacyStringArray = (values: string[] | undefined): string => JSON.stringify(values ?? []);

const normalizeIngredientName = (value: string) => value.trim().toLowerCase();

const normalizeDietValues = (values: string[] | undefined): string[] => {
  const allowed = new Set(['standard', 'lactose-free', 'gluten-free']);
  const normalized = Array.from(
    new Set(
      (values || [])
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase(),
        )
        .filter((value) => allowed.has(value)),
    ),
  );

  // Keep standard as baseline for planner/recipes compatibility.
  if (!normalized.includes('standard')) {
    normalized.unshift('standard');
  }

  return normalized;
};

const deriveRecipeDiets = (ingredients: RecipeIngredientInput[]): string[] => {
  const normalizedIngredientNames = Array.from(
    new Set(
      ingredients.map((ingredient) => normalizeIngredientName(ingredient.name)).filter(Boolean),
    ),
  );

  if (normalizedIngredientNames.length === 0) {
    return ['standard'];
  }

  const allergenRows = db.select().from(allergens).all();
  const allergenByIngredient = new Map(
    allergenRows.map((row) => [normalizeIngredientName(row.ingredientName), row]),
  );

  let hasLactose = false;
  let hasGluten = false;

  // Heuristic fallbacks for common ingredient names that indicate lactose or gluten
  const lactoseKeywords = [
    'milk',
    'vollmilch',
    'butter',
    'cheese',
    'parmesan',
    'yogurt',
    'cream',
    'sahne',
    'käse',
  ];
  const glutenKeywords = [
    'flour',
    'mehl',
    'wheat',
    'spaghetti',
    'pasta',
    'bread',
    'noodle',
    'crumb',
    'semolina',
    'weizen',
  ];

  for (const ingredientName of normalizedIngredientNames) {
    const info = allergenByIngredient.get(ingredientName);

    if (info) {
      if (info.hasLactose === 1) hasLactose = true;
      if (info.hasGluten === 1) hasGluten = true;
    } else {
      // Apply simple keyword matching as a conservative fallback for common items
      for (const k of lactoseKeywords) {
        if (ingredientName.includes(k)) {
          hasLactose = true;
          break;
        }
      }

      for (const k of glutenKeywords) {
        if (ingredientName.includes(k)) {
          hasGluten = true;
          break;
        }
      }
    }

    if (hasLactose && hasGluten) break;
  }

  const diets = ['standard'];
  if (!hasLactose) diets.push('lactose-free');
  if (!hasGluten) diets.push('gluten-free');
  return diets;
};

// Parse stored JSON safely and ignore malformed payloads
const parseLegacyStringArray = (value: string | null): string[] => {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
};

// Reuse conversion helpers so list and detail queries map data consistently
const toIngredientInputs = (rows: RecipeIngredientRow[]): RecipeIngredientInput[] =>
  rows.map((row) => ({
    amount: row.amount,
    unit: row.unit,
    name: row.name,
  }));

const toStepTexts = (rows: RecipeStepRow[]): string[] => rows.map((row) => row.stepText);

const loadRecipeIngredientRows = (recipeId: number): RecipeIngredientRow[] =>
  db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.position))
    .all();

const loadRecipeStepRows = (recipeId: number): RecipeStepRow[] =>
  db
    .select()
    .from(recipeSteps)
    .where(eq(recipeSteps.recipeId, recipeId))
    .orderBy(asc(recipeSteps.position))
    .all();

const toRecipeAggregate = (recipeRow: RecipeRow): RecipeAggregate => {
  const ingredientRows = loadRecipeIngredientRows(recipeRow.id);
  const stepRows = loadRecipeStepRows(recipeRow.id);
  const ingredients = toIngredientInputs(ingredientRows);
  // Parse stored diets without imposing defaults so we can detect "no stored value"
  const parsedStoredDiets = parseLegacyStringArray(recipeRow.diets);
  const storedDiets = parsedStoredDiets.length > 0 ? normalizeDietValues(parsedStoredDiets) : [];
  const derivedDiets = deriveRecipeDiets(ingredients);
  const diets = storedDiets.length > 0 ? storedDiets : derivedDiets;

  // If there was no stored value, backfill the computed diets so future reads use them
  if (parsedStoredDiets.length === 0) {
    db.update(recipes)
      .set({ diets: toLegacyStringArray(diets) })
      .where(eq(recipes.id, recipeRow.id))
      .run();
  }

  return {
    id: recipeRow.id,
    title: recipeRow.title,
    servings: recipeRow.servings ?? null,
    duration: recipeRow.duration ?? null,
    difficulty: recipeRow.difficulty ?? null,
    habits: parseLegacyStringArray(recipeRow.habits),
    diets,
    categories: parseLegacyStringArray(recipeRow.categories),
    ingredients,
    steps: toStepTexts(stepRows),
  };
};

export const getAllRecipes = (): RecipeAggregate[] => {
  const recipeRows = db.select().from(recipes).orderBy(asc(recipes.title)).all();

  // Assemble aggregates from normalized rows and JSON tag fields
  return recipeRows.map(toRecipeAggregate);
};

export const getRecipeById = (id: number): RecipeAggregate | null => {
  const recipeRow = db.select().from(recipes).where(eq(recipes.id, id)).get();
  if (!recipeRow) return null;

  return toRecipeAggregate(recipeRow);
};

export const createRecipe = (input: RecipeInput): number => {
  const title = normalizeTitle(input.title);
  if (!title) {
    throw new Error('Recipe title must not be empty.');
  }

  // Insert recipe and child rows in one transaction
  return db.transaction((tx) => {
    const diets =
      input.diets && input.diets.length > 0
        ? normalizeDietValues(input.diets)
        : deriveRecipeDiets(input.ingredients);

    const insertedRecipe = tx
      .insert(recipes)
      .values({
        title,
        servings: input.servings ?? null,
        duration: input.duration ?? null,
        difficulty: input.difficulty ?? null,
        habits: toLegacyStringArray(input.habits),
        diets: toLegacyStringArray(diets),
        categories: toLegacyStringArray(input.categories),
        // Keep legacy columns populated for existing consumers
        ingredients: toLegacyIngredients(input.ingredients),
        instructions: toLegacyInstructions(input.steps),
      })
      .returning({ id: recipes.id })
      .get();

    const recipeId = insertedRecipe.id;

    for (const [position, ingredient] of input.ingredients.entries()) {
      tx.insert(recipeIngredients)
        .values({
          recipeId,
          position,
          amount: ingredient.amount,
          unit: ingredient.unit,
          name: ingredient.name,
        })
        .run();
    }

    for (const [position, stepText] of input.steps.entries()) {
      tx.insert(recipeSteps)
        .values({
          recipeId,
          position,
          stepText,
        })
        .run();
    }

    return recipeId;
  });
};

export const deleteRecipeById = (recipeId: number): void => {
  db.delete(recipes).where(eq(recipes.id, recipeId)).run();
};

export const replaceRecipeContent = (recipeId: number, input: RecipeInput): void => {
  const title = normalizeTitle(input.title);
  if (!title) {
    throw new Error('Recipe title must not be empty.');
  }

  // Replace keeps parent and child rows consistent
  db.transaction((tx) => {
    const diets =
      input.diets && input.diets.length > 0
        ? normalizeDietValues(input.diets)
        : deriveRecipeDiets(input.ingredients);

    tx.update(recipes)
      .set({
        title,
        servings: input.servings ?? null,
        duration: input.duration ?? null,
        difficulty: input.difficulty ?? null,
        habits: toLegacyStringArray(input.habits),
        diets: toLegacyStringArray(diets),
        categories: toLegacyStringArray(input.categories),
        ingredients: toLegacyIngredients(input.ingredients),
        instructions: toLegacyInstructions(input.steps),
      })
      .where(eq(recipes.id, recipeId))
      .run();

    tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).run();
    tx.delete(recipeSteps).where(eq(recipeSteps.recipeId, recipeId)).run();

    for (const [position, ingredient] of input.ingredients.entries()) {
      tx.insert(recipeIngredients)
        .values({
          recipeId,
          position,
          amount: ingredient.amount,
          unit: ingredient.unit,
          name: ingredient.name,
        })
        .run();
    }

    for (const [position, stepText] of input.steps.entries()) {
      tx.insert(recipeSteps)
        .values({
          recipeId,
          position,
          stepText,
        })
        .run();
    }
  });
};

export const updateRecipeCategoriesById = (recipeId: number, categories: string[]): void => {
  // Update tag categories directly without touching normalized child tables
  db.update(recipes)
    .set({
      categories: toLegacyStringArray(categories),
    })
    .where(eq(recipes.id, recipeId))
    .run();
};

export const recipeExistsByTitle = (title: string): boolean => {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;

  const row = db
    .select({ id: recipes.id })
    .from(recipes)
    .where(eq(recipes.title, normalized))
    .get();

  return Boolean(row);
};

export const syncRecipeDietsFromIngredients = (): void => {
  const recipeRows = db.select().from(recipes).all();

  for (const row of recipeRows) {
    const ingredientRows = loadRecipeIngredientRows(row.id);
    const ingredients = toIngredientInputs(ingredientRows);
    const nextDiets = normalizeDietValues(deriveRecipeDiets(ingredients));
    const currentDiets = normalizeDietValues(parseLegacyStringArray(row.diets));

    if (JSON.stringify(currentDiets) === JSON.stringify(nextDiets)) continue;

    db.update(recipes)
      .set({ diets: toLegacyStringArray(nextDiets) })
      .where(eq(recipes.id, row.id))
      .run();
  }
};
