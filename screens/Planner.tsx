import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { createWriteStream, writeFileSync } from 'fs';
import { join } from 'path';
import { db } from '../db/db';
import { allergens, inventory, recipes } from '../db/schema';
import {
  clearPlannerHistory,
  getLatestPlannerGeneration,
  savePlannerGeneration,
  type PlannerDayPlan,
} from '../db/plannerRepo';
import { getPlannedRecipeEntries } from '../db/plannedRecipesRepo';
import {
  getAllShoppingLists,
  getShoppingListById,
  addItemToList,
  createShoppingList,
  type ShoppingListItemRow,
} from '../db/shoppingListsRepo';
import {
  areSimilarItemNames,
  computeMissingForIngredients,
  isMissingCoveredByShoppingList,
} from '../services/ingredientCoverage';
import { syncRecipeDietsFromIngredients } from '../db/recipesRepo';
import { t } from '../services/i18n';

// Data model for a single meal entry in one day
interface Meal {
  type: 'Breakfast' | 'Lunch' | 'Dinner';
  name: string;
  time: string;
  missing: string[];
  diet?: string;
  source?: 'ai' | 'manual' | 'db' | 'mixed' | 'self-planned' | 'stock';
  locked?: boolean;
}

// Data model for one day in the weekly plan
interface DayPlan {
  dayNumber: number;
  meals: Meal[];
}

// Optional props for Planner screen
interface PlannerProps {
  inventory?: any[];
  language?: string;
}

export const computeTruncatedDayRenderStart = (
  mealLineEstimates: number[],
  focusedMealIndex: number | null,
  allowedLines: number,
  isTruncated: boolean,
): number => {
  if (!isTruncated || focusedMealIndex === null) return 0;

  const boundedFocusedIndex = Math.max(0, Math.min(mealLineEstimates.length - 1, focusedMealIndex));
  const mealLineCapacity = Math.max(1, allowedLines - 1); // header line already used
  let renderStartIndex = boundedFocusedIndex;
  let usedLines = mealLineEstimates[boundedFocusedIndex] || 0;

  while (renderStartIndex > 0) {
    const prevMealLines = mealLineEstimates[renderStartIndex - 1] || 0;
    if (usedLines + prevMealLines > mealLineCapacity) break;
    renderStartIndex -= 1;
    usedLines += prevMealLines;
  }

  return renderStartIndex;
};

export const shouldShowBottomTruncationEllipsis = (
  isTruncated: boolean,
  clippedBottom: boolean,
): boolean => isTruncated && clippedBottom;

// Supported diets and generation modes
const DIETS = ['Standard', 'Lactose-Free', 'Gluten-Free'] as const;
const PLAN_HABITS = ['all', 'vegetarian', 'vegan'] as const;
const GENERATION_MODES = ['db', 'ai', 'mixed', 'self-planned', 'stock'] as const;
const STOCK_OPTIONS = ['db', 'ai'] as const;

type GenerationMode = (typeof GENERATION_MODES)[number];
type StockOption = (typeof STOCK_OPTIONS)[number];
type RecipeRow = typeof recipes.$inferSelect;
type InventoryRow = typeof inventory.$inferSelect;
type MealType = Meal['type'];
type RecipeCategory = 'breakfast' | 'lunch' | 'dinner';

type InternetRecipeCandidate = {
  title: string;
  category?: string;
  area?: string;
  ingredients: string[];
  sourceUrl?: string;
};
type AiMealItem = { type?: string; name?: string; time?: string };
type AiDayItem = { dayNumber?: number; meals?: AiMealItem[] };
type AiStockMealItem = { type?: string; name?: string; time?: string; ingredients?: unknown };
type AiStockDayItem = { dayNumber?: number; meals?: AiStockMealItem[] };
type MealAction = 'manual' | 'ai' | 'db';
type HabitFilter = 'all' | 'vegetarian' | 'vegan';
type DietFilter = 'standard' | 'lactose-free' | 'gluten-free';

const DB_RECIPE_PICKER_WINDOW_SIZE = 8;
const EDIT_SLOT_HABIT_FILTERS: HabitFilter[] = ['all', 'vegetarian', 'vegan'];
const EDIT_SLOT_DIET_FILTERS = ['standard', 'lactose-free', 'gluten-free'] as const;

// Default display times by meal type
const DEFAULT_TIME_BY_TYPE: Record<MealType, string> = {
  Breakfast: '08:00',
  Lunch: '13:00',
  Dinner: '19:00',
};

// Returns array element using circular indexing
const pickCircular = <T,>(arr: T[], idx: number): T => arr[idx % arr.length]!;

// Parses ingredients from array, JSON string, or comma-separated text
const parseIngredients = (recipe: any): string[] => {
  const raw = recipe?.ingredients;
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(typeof x === 'object' && x?.name ? x.name : x).trim())
      .filter(Boolean);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => String(typeof x === 'object' && x?.name ? x.name : x).trim())
          .filter(Boolean);
      }
    } catch {}

    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
};

type ParsedIngredientAmount = {
  name: string;
  amount: number;
  unit: string;
};

const parseIngredientAmounts = (recipe: any): ParsedIngredientAmount[] => {
  const raw = recipe?.ingredients;
  if (!raw) return [];

  const toRows = (items: unknown[]): ParsedIngredientAmount[] =>
    items
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const source = item as { name?: unknown; amount?: unknown; unit?: unknown };
          const name = String(source.name || '').trim();
          if (!name) return null;

          const amountRaw = Number(source.amount ?? 0);
          const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 1;
          const unit = String(source.unit || 'pcs').trim() || 'pcs';
          return { name, amount, unit };
        }

        const name = String(item || '').trim();
        if (!name) return null;
        return { name, amount: 1, unit: 'pcs' };
      })
      .filter((row): row is ParsedIngredientAmount => row !== null);

  if (Array.isArray(raw)) {
    return toRows(raw);
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return toRows(parsed);
      }
    } catch {}

    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((name) => ({ name, amount: 1, unit: 'pcs' }));
  }

  return [];
};

// Infer meal type from recipe title/category text
const parseRecipeCategories = (recipe: RecipeRow): string[] => {
  const raw = recipe.categories;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  } catch {
    return raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
};

const parseRecipeHabits = (recipe: RecipeRow): string[] => {
  const raw = recipe.habits;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  } catch {
    return raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
};

const parseRecipeDiets = (recipe: RecipeRow): string[] => {
  const raw = recipe.diets;

  const deriveFromKnownAllergens = (): string[] => {
    const normalizedIngredientNames = Array.from(
      new Set(
        parseIngredients(recipe)
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      ),
    );

    if (normalizedIngredientNames.length === 0) return ['standard'];

    const allergenRows = db.select().from(allergens).all() as (typeof allergens.$inferSelect)[];
    const allergenByIngredient = new Map(
      allergenRows.map((row) => [
        String(row.ingredientName || '')
          .trim()
          .toLowerCase(),
        row,
      ]),
    );

    let hasLactose = false;
    let hasGluten = false;
    let hasUnknownIngredient = false;

    for (const ingredientName of normalizedIngredientNames) {
      const info = allergenByIngredient.get(ingredientName);
      if (!info) {
        hasUnknownIngredient = true;
        continue;
      }

      if (info.hasLactose === 1) hasLactose = true;
      if (info.hasGluten === 1) hasGluten = true;
    }

    const diets = ['standard'];
    if (!hasUnknownIngredient && !hasLactose) diets.push('lactose-free');
    if (!hasUnknownIngredient && !hasGluten) diets.push('gluten-free');
    return diets;
  };

  if (!raw) return deriveFromKnownAllergens();

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ['standard'];
    const normalized = parsed
      .map((value) =>
        String(value || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    return normalized.length > 0 ? normalized : deriveFromKnownAllergens();
  } catch {
    const normalized = raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : deriveFromKnownAllergens();
  }
};

// Resolve one primary habit label for planner display
const resolvePrimaryHabit = (recipe: RecipeRow): string => {
  const habits = parseRecipeHabits(recipe);
  if (habits.includes('vegan')) return 'vegan';
  if (habits.includes('vegetarian')) return 'vegetarian';
  if (habits.includes('all')) return 'all';
  return 'all';
};

const mapDietLabelToHabit = (diet: string | undefined): string | null => {
  const normalized = String(diet || '')
    .trim()
    .toLowerCase();

  if (normalized === 'vegan') return 'vegan';
  if (normalized === 'vegetarian') return 'vegetarian';
  if (normalized === 'standard') return 'all';
  return null;
};

const toDietFilter = (diet: string): DietFilter => {
  const normalized = String(diet || '')
    .trim()
    .toLowerCase();

  if (normalized === 'lactose-free') return 'lactose-free';
  if (normalized === 'gluten-free') return 'gluten-free';
  return 'standard';
};

const recipeMatchesPlanningHabit = (recipe: RecipeRow, habit: HabitFilter): boolean => {
  if (habit === 'all') return true;

  const habits = parseRecipeHabits(recipe);
  if (habit === 'vegan') return habits.includes('vegan');
  return habits.includes('vegetarian') || habits.includes('vegan');
};

const recipeMatchesPlanningDiet = (recipe: RecipeRow, diet: DietFilter): boolean => {
  if (diet === 'standard') return true;
  const diets = parseRecipeDiets(recipe);
  return diets.includes(diet);
};

const mapHabitToDietLabel = (habit: HabitFilter): string => {
  if (habit === 'vegan') return 'Vegan';
  if (habit === 'vegetarian') return 'Vegetarian';
  return 'Standard';
};

const toHabitFilter = (value: string | undefined): HabitFilter => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (normalized === 'vegan') return 'vegan';
  if (normalized === 'vegetarian') return 'vegetarian';
  return 'all';
};

const containsAnyIngredientKeyword = (ingredients: string[], keywords: string[]): boolean => {
  return ingredients.some((ingredient) => {
    const normalized = ingredient.trim().toLowerCase();
    if (!normalized) return false;
    return keywords.some((keyword) => normalized.includes(keyword));
  });
};

const inferHabitFromIngredientNames = (ingredients: string[]): HabitFilter => {
  const meatOrFishKeywords = [
    'beef',
    'pork',
    'chicken',
    'turkey',
    'lamb',
    'bacon',
    'ham',
    'sausage',
    'salami',
    'fish',
    'tuna',
    'salmon',
    'anchovy',
    'shrimp',
    'prawn',
    'huhn',
    'rind',
    'schwein',
    'lamm',
    'fisch',
    'thunfisch',
    'lachs',
    'garnel',
  ];

  if (containsAnyIngredientKeyword(ingredients, meatOrFishKeywords)) {
    return 'all';
  }

  const vegetarianOnlyKeywords = [
    'egg',
    'eggs',
    'milk',
    'cream',
    'yoghurt',
    'yogurt',
    'cheese',
    'butter',
    'honey',
    'parmesan',
    'mozzarella',
    'feta',
    'ei',
    'eier',
    'milch',
    'sahne',
    'käse',
    'kaese',
    'butter',
    'honig',
    'joghurt',
  ];

  if (containsAnyIngredientKeyword(ingredients, vegetarianOnlyKeywords)) {
    return 'vegetarian';
  }

  return 'vegan';
};

// Assign each planned recipe to one allowed category using load balancing
const distributeRecipesAcrossCategories = (
  items: RecipeRow[],
): Record<RecipeCategory, RecipeRow[]> => {
  const pools: Record<RecipeCategory, RecipeRow[]> = {
    breakfast: [],
    lunch: [],
    dinner: [],
  };

  const counts: Record<RecipeCategory, number> = {
    breakfast: 0,
    lunch: 0,
    dinner: 0,
  };

  // Rotate tie resolution so equal categories are chosen in turn
  const tieOrder: RecipeCategory[] = ['breakfast', 'lunch', 'dinner'];
  let nextTieCursor = 0;

  for (const recipe of items) {
    const allowed = parseRecipeCategories(recipe).filter(
      (category): category is RecipeCategory =>
        category === 'breakfast' || category === 'lunch' || category === 'dinner',
    );

    if (allowed.length === 0) continue;

    const minCount = Math.min(...allowed.map((category) => counts[category]));
    const candidates = allowed.filter((category) => counts[category] === minCount);

    let target = candidates[0]!;
    if (candidates.length > 1) {
      for (let offset = 0; offset < tieOrder.length; offset += 1) {
        const preferred = tieOrder[(nextTieCursor + offset) % tieOrder.length]!;
        if (candidates.includes(preferred)) {
          target = preferred;
          nextTieCursor = (nextTieCursor + offset + 1) % tieOrder.length;
          break;
        }
      }
    } else {
      const selectedIndex = tieOrder.indexOf(target);
      if (selectedIndex >= 0) {
        nextTieCursor = (selectedIndex + 1) % tieOrder.length;
      }
    }

    pools[target].push(recipe);
    counts[target] += 1;
  }

  return pools;
};

const toMealTypeFromCategory = (category: string): MealType | null => {
  const normalized = category.trim().toLowerCase();
  if (normalized === 'breakfast') return 'Breakfast';
  if (normalized === 'lunch') return 'Lunch';
  if (normalized === 'dinner') return 'Dinner';
  return null;
};

const guessMealType = (r: RecipeRow): MealType => {
  const categoryBasedType = parseRecipeCategories(r)
    .map(toMealTypeFromCategory)
    .find((value): value is MealType => value !== null);
  if (categoryBasedType) return categoryBasedType;

  const txt = `${r.title ?? ''}`.toLowerCase();

  if (
    txt.includes('breakfast') ||
    txt.includes('frühstück') ||
    txt.includes('porridge') ||
    txt.includes('müsli') ||
    txt.includes('omelett')
  ) {
    return 'Breakfast';
  }

  if (
    txt.includes('dinner') ||
    txt.includes('abend') ||
    txt.includes('suppe') ||
    txt.includes('curry')
  ) {
    return 'Dinner';
  }

  return 'Lunch';
};

// Normalizes free-text meal type from AI output
const normalizeMealType = (value: string | undefined, fallback: MealType): MealType => {
  const txt = String(value || '')
    .toLowerCase()
    .trim();
  if (txt.startsWith('break')) return 'Breakfast';
  if (txt.startsWith('lunch')) return 'Lunch';
  if (txt.startsWith('dinner')) return 'Dinner';
  return fallback;
};

// Extracts the first JSON array from a raw AI response string
const extractJsonArray = (input: string): string | null => {
  const firstBracket = input.indexOf('[');
  const lastBracket = input.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) return null;
  return input.slice(firstBracket, lastBracket + 1);
};

// Normalizes recipe titles for comparison/search matching
const normalizeRecipeTitle = (value: string | undefined): string =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const Planner: React.FC<PlannerProps> = ({ language = 'en' }) => {
  // Terminal size and layout calculations for responsive Ink rendering

  const { stdout } = useStdout();

  const [currentGenerationId, setCurrentGenerationId] = useState<number | null>(null);

  // UI state: loading indicator, generated plan, day count, selected diet
  const [loading, setLoading] = useState(false);
  const [weeklyPlan, setWeeklyPlan] = useState<DayPlan[] | null>(null);
  const [days, setDays] = useState(3);
  const [dietIndex, setDietIndex] = useState(0);
  const [habitFilterIndex, setHabitFilterIndex] = useState(0);

  // Error message display and database data cache
  const [error, setError] = useState<string | null>(null);
  const [dbRecipes, setDbRecipes] = useState<RecipeRow[]>([]);
  const [dbInventory, setDbInventory] = useState<InventoryRow[]>([]);
  const [todayListItems, setTodayListItems] = useState<ShoppingListItemRow[]>([]);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Add all missing ingredients for all planned meals to the shopping list.
  // Collects all missing ingredients from the plan, including quantity/unit from the recipe.
  const getAllMissingIngredientsFromPlan = (): {
    name: string;
    quantity: number;
    unit: string;
  }[] => {
    if (!weeklyPlan) return [];
    const missingMap = new Map<string, { name: string; quantity: number; unit: string }>();
    for (const day of weeklyPlan) {
      for (const meal of day.meals) {
        // Find the matching recipe
        const recipe = dbRecipes.find(
          (r) => r.title && r.title.trim().toLowerCase() === meal.name.trim().toLowerCase(),
        );
        let ingredientAmounts: { name: string; amount: number; unit: string }[] = [];
        if (recipe) {
          ingredientAmounts = parseIngredientAmounts(recipe);
        }
        for (const missingName of meal.missing) {
          const key = missingName.trim().toLowerCase();
          // Try to find quantity/unit from the recipe
          const found = ingredientAmounts.find((ing) => ing.name.trim().toLowerCase() === key);
          const quantity = found?.amount ?? 1;
          const unit = found?.unit ?? 'pcs';
          if (!missingMap.has(key)) {
            missingMap.set(key, { name: missingName, quantity, unit });
          }
        }
      }
    }
    return Array.from(missingMap.values());
  };

  const addAllMissingToShoppingList = () => {
    const itemsToAdd = getAllMissingIngredientsFromPlan();
    if (itemsToAdd.length === 0) {
      setStatusMessage('Keine fehlenden Zutaten zum Hinzufügen.');
      return;
    }
    const lists = getAllShoppingLists();
    const todayPrefix = new Date().toISOString().slice(0, 10);

    // Exclude receipt/import and Recipes Planner lists – planner items should
    // remain distinguishable. Prefer a Planner list created today; otherwise
    // create a dedicated Planner list for today.
    const nonReceiptLists = lists.filter(
      (l) =>
        !String(l.name || '')
          .toLowerCase()
          .includes('receipt') &&
        !String(l.name || '')
          .toLowerCase()
          .startsWith('recipes planner '),
    );

    const todayNonReceipt = nonReceiptLists
      .filter((l) => (l.createdAt ?? '').startsWith(todayPrefix))
      .sort((a, b) => b.id - a.id);

    // Prefer a today list from Planner
    const todayShopping = todayNonReceipt.find((l) =>
      String(l.name || '')
        .toLowerCase()
        .startsWith('planner '),
    );

    const listId = todayShopping
      ? todayShopping.id
      : createShoppingList(`Planner ${new Date().toLocaleDateString()}`);

    const listAggregate = getShoppingListById(listId);
    const existingItems = listAggregate?.items ?? [];
    for (const item of itemsToAdd) {
      const exists = existingItems.find(
        (ei) =>
          String(ei.name || '')
            .trim()
            .toLowerCase() === item.name.trim().toLowerCase(),
      );
      if (!exists) {
        addItemToList(listId, item);
      }
    }
    setStatusMessage('Fehlende Zutaten wurden zur Einkaufsliste hinzugefügt.');
    loadTodayShoppingListItems();
  };

  // Meal slot focus tracking (day number and meal index within that day)
  const [focusIndex, setFocusIndex] = useState<{ day: number; meal: number } | null>(null);

  // Manual meal name input UI state
  const [isEditingMealName, setIsEditingMealName] = useState(false);
  const [mealNameInput, setMealNameInput] = useState('');

  // Meal action popup UI state (manual, AI, or DB replacement)
  const [isChoosingMealAction, setIsChoosingMealAction] = useState(false);
  const [mealActionIndex, setMealActionIndex] = useState(0);
  // Track recipe picker state for manual DB slot replacement
  const [isChoosingDbRecipe, setIsChoosingDbRecipe] = useState(false);
  const [dbRecipeChoiceIndex, setDbRecipeChoiceIndex] = useState(0);
  const [showAllDbRecipes, setShowAllDbRecipes] = useState(false);
  const [dbHabitFilter, setDbHabitFilter] = useState<HabitFilter>('all');
  const [dbDietFilter, setDbDietFilter] = useState<string>('standard');
  const [isChoosingAiHabit, setIsChoosingAiHabit] = useState(false);
  const [aiHabitChoiceIndex, setAiHabitChoiceIndex] = useState(0);
  const [aiDietChoiceIndex, setAiDietChoiceIndex] = useState(0);
  const [aiPickerActiveLine, setAiPickerActiveLine] = useState(0); // 0 = habit, 1 = diet
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0); // Pagination state for grid-based day card layout
  // Generation mode tracking
  const [generationMode, setGenerationMode] = useState<GenerationMode>('mixed');
  const [stockOption, setStockOption] = useState<StockOption>('db');

  // Get currently selected diet name from the diet inde
  const selectedGlobalDiet = DIETS[dietIndex] || 'Standard';
  const selectedPlanningHabit = PLAN_HABITS[habitFilterIndex] || 'all';
  const selectedStockOption = STOCK_OPTIONS.includes(stockOption) ? stockOption : 'db';

  // Calculate responsive screen dimensions based on terminal size
  const terminalColumns = stdout?.columns || 80;
  const terminalRows = stdout?.rows || 24;
  const screenWidth = Math.max(50, Math.floor(terminalColumns * 0.8));
  const screenHeight = Math.max(14, Math.floor(terminalRows * 0.7));
  const ROOT_PAD_LEFT = 2;
  const ROOT_PAD_RIGHT = 1;
  const contentWidth = Math.max(20, screenWidth - ROOT_PAD_LEFT - ROOT_PAD_RIGHT);

  // Layout height calculations for header, body, footer, and status areas
  const HEADER_HEIGHT = 1;
  const FOOTER_HEIGHT = 1;
  const STATUS_HEIGHT = loading || error || statusMessage ? 1 : 0;
  const TOP_GAP = 0;
  const bodyHeight = Math.max(
    1,
    screenHeight - HEADER_HEIGHT - FOOTER_HEIGHT - STATUS_HEIGHT - TOP_GAP,
  );

  // Day card grid dimensions and responsive column/row calculations
  const DAY_CARD_WIDTH = 28;
  const DAY_CARD_HEIGHT = 24;
  const GRID_GAP_X = 4;
  const GRID_GAP_Y = 4;
  const gridCols = Math.max(1, Math.floor(contentWidth / (DAY_CARD_WIDTH + GRID_GAP_X)));

  // Reserve vertical space for the bottom hints/legend so day cards never overlap them.
  // When a weekly plan is present we render a small hint block below the grid (hint + spacer + legend).
  const bottomReservedHeight = weeklyPlan ? 4 : 0; // conservative: margin + hint + blank + legend

  // Use an "effective" body height that excludes reserved bottom space.
  const effectiveBodyHeight = Math.max(1, bodyHeight - bottomReservedHeight);

  const gridRowsPerPage = Math.max(
    1,
    Math.floor(effectiveBodyHeight / (DAY_CARD_HEIGHT + GRID_GAP_Y)),
  );
  const itemsPerPage = gridCols * gridRowsPerPage;

  // Compute the maximum allowed card height per row so cards don't overlap footer hints.
  const maxCardHeight =
    gridRowsPerPage > 0
      ? Math.max(
          DAY_CARD_HEIGHT,
          Math.floor((effectiveBodyHeight - (gridRowsPerPage - 1) * GRID_GAP_Y) / gridRowsPerPage),
        )
      : DAY_CARD_HEIGHT;

  // Estimate required height (in lines) for a given day card based on meal names and missing items.
  const estimateDayCardHeight = (day: DayPlan): number => {
    const outerMealWidth = DAY_CARD_WIDTH - 4; // subtract border and padding
    const innerWidth = Math.max(10, outerMealWidth - 2); // content width for wrapping

    let lines = 0;
    // Day header
    lines += 1;

    for (const meal of day.meals) {
      // marginTop for each meal
      lines += 1;

      // meal type line, metadata line
      lines += 2;

      // meal name (wrap)
      const nameLen = String(meal.name || '').length;
      lines += Math.max(1, Math.ceil(nameLen / innerWidth));

      // missing ingredients — estimate full list length (safe upper bound)
      if (meal.missing && meal.missing.length > 0) {
        const missingLabel = t('planner.missing', language);
        const missingText = meal.missing.join(', ');
        const missingLen = missingLabel.length + 1 + missingText.length;
        lines += Math.max(1, Math.ceil(missingLen / innerWidth));
      }
    }

    // Small padding/border
    lines += 1;
    return Math.max(DAY_CARD_HEIGHT, lines);
  };

  // Loads recipes and inventory from the local database
  const loadDbData = () => {
    try {
      // Backfill recipe diets once so planner diet filtering works for old rows.
      syncRecipeDietsFromIngredients();
      const recipesData = db.select().from(recipes).all() as RecipeRow[];
      const inventoryData = db.select().from(inventory).all() as InventoryRow[];
      setDbRecipes(recipesData);
      setDbInventory(inventoryData);
      return { recipesData, inventoryData };
    } catch {
      setError('Could not load recipes/inventory from DB.');
      return { recipesData: [] as RecipeRow[], inventoryData: [] as InventoryRow[] };
    }
  };

  const loadTodayShoppingListItems = () => {
    try {
      // Use the latest Planner list created today as the active list
      const lists = getAllShoppingLists();
      const todayPrefix = new Date().toISOString().slice(0, 10);
      const todayLists = lists
        .filter(
          (list) =>
            String(list.createdAt || '').startsWith(todayPrefix) &&
            String(list.name || '')
              .toLowerCase()
              .startsWith('planner '),
        )
        .sort((a, b) => b.id - a.id);

      const todayListId = todayLists[0]?.id;
      if (!todayListId) {
        setTodayListItems([]);
        return;
      }

      const aggregate = getShoppingListById(todayListId);
      setTodayListItems(aggregate?.items ?? []);
    } catch {
      setTodayListItems([]);
    }
  };

  const persistPlanSnapshot = (
    plan: DayPlan[],
    mode: GenerationMode,
    diet: string,
    dayCount: number,
  ) => {
    try {
      const generationId = savePlannerGeneration({
        days: dayCount,
        diet,
        generationMode: mode,
        plan: plan as PlannerDayPlan[],
        sourceScreen: 'planner',
      });

      setCurrentGenerationId(generationId);
    } catch {
      setError('Plan was generated, but history could not be saved.');
    }
  };

  useEffect(() => {
    loadDbData();
    loadTodayShoppingListItems();

    try {
      const latest = getLatestPlannerGeneration();

      if (latest) {
        setWeeklyPlan(latest.plan as DayPlan[]);
        setDays(latest.days);
        setGenerationMode(latest.generationMode);
        setFocusIndex({ day: 1, meal: 0 });
        setCurrentGenerationId(latest.id);

        const restoredDietIndex = DIETS.findIndex((diet) => diet === latest.diet);
        if (restoredDietIndex >= 0) {
          setDietIndex(restoredDietIndex);
        }
      }
    } catch {
      setError('Could not restore latest planner history.');
    }
  }, []);

  // Set of normalized inventory names for quick "missing ingredients" checks
  const inventoryNameSet = useMemo(() => {
    return new Set(
      dbInventory
        .map((i) =>
          String(i.name || '')
            .toLowerCase()
            .trim(),
        )
        .filter(Boolean),
    );
  }, [dbInventory]);

  const filteredPlanningRecipes = useMemo(() => {
    const dietFilter = toDietFilter(selectedGlobalDiet);
    return dbRecipes.filter(
      (recipe) =>
        recipeMatchesPlanningHabit(recipe, selectedPlanningHabit) &&
        recipeMatchesPlanningDiet(recipe, dietFilter),
    );
  }, [dbRecipes, selectedPlanningHabit, selectedGlobalDiet]);

  // Groups DB recipes by inferred meal type. If no recipes match a type, fallback to filtered/all recipes
  const recipesByMealType = useMemo(() => {
    const grouped: Record<MealType, RecipeRow[]> = {
      Breakfast: [],
      Lunch: [],
      Dinner: [],
    };

    for (const r of filteredPlanningRecipes) grouped[guessMealType(r)].push(r);

    const fallbackPool = filteredPlanningRecipes.length > 0 ? filteredPlanningRecipes : dbRecipes;
    if (grouped.Breakfast.length === 0) grouped.Breakfast = fallbackPool;
    if (grouped.Lunch.length === 0) grouped.Lunch = fallbackPool;
    if (grouped.Dinner.length === 0) grouped.Dinner = fallbackPool;

    return grouped;
  }, [filteredPlanningRecipes, dbRecipes]);

  const selfPlannedPreview = useMemo(() => {
    // Read persisted planner entries from RecipesView
    const recipesById = new Map<number, RecipeRow>(dbRecipes.map((recipe) => [recipe.id, recipe]));
    const plannedEntries = getPlannedRecipeEntries();
    const categorizedRecipes: RecipeRow[] = [];

    for (const entry of plannedEntries) {
      const recipe = recipesById.get(entry.recipeId);
      if (!recipe) continue;

      const allowed = parseRecipeCategories(recipe).some(
        (category) => category === 'breakfast' || category === 'lunch' || category === 'dinner',
      );
      if (!allowed) continue;

      if (!recipeMatchesPlanningHabit(recipe, selectedPlanningHabit)) continue;
      if (!recipeMatchesPlanningDiet(recipe, toDietFilter(selectedGlobalDiet))) continue;

      categorizedRecipes.push(recipe);
    }

    const distributedPools = distributeRecipesAcrossCategories(categorizedRecipes);
    const breakfast = distributedPools.breakfast.length;
    const lunch = distributedPools.lunch.length;
    const dinner = distributedPools.dinner.length;

    const daysFromPlanned = Math.max(breakfast, lunch, dinner);
    const filledSlots = breakfast + lunch + dinner;

    return {
      breakfast,
      lunch,
      dinner,
      daysFromPlanned,
      filledSlots,
    };
  }, [dbRecipes, currentGenerationId, selectedPlanningHabit, selectedGlobalDiet]);

  // Build DB recipe candidates for the currently focused meal slot
  const dbRecipeCandidates = useMemo(() => {
    const sorted = [...dbRecipes].sort((a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''), undefined, {
        sensitivity: 'base',
      }),
    );

    const habitFiltered =
      dbHabitFilter === 'all'
        ? sorted
        : sorted.filter((recipe) => parseRecipeHabits(recipe).includes(dbHabitFilter));

    // Apply diet filter after habit filter. Treat 'standard' as no-op (show all).
    const dietFiltered =
      dbDietFilter === 'standard'
        ? habitFiltered
        : habitFiltered.filter((recipe) => parseRecipeDiets(recipe).includes(dbDietFilter));

    if (showAllDbRecipes) {
      return dietFiltered;
    }

    if (!focusIndex || !weeklyPlan) return dietFiltered;

    const slotType = weeklyPlan[focusIndex.day - 1]?.meals[focusIndex.meal]?.type;
    if (!slotType) return dietFiltered;

    const filtered = dietFiltered.filter((recipe) => guessMealType(recipe) === slotType);
    return filtered.length > 0 ? filtered : dietFiltered;
  }, [dbRecipes, focusIndex, weeklyPlan, showAllDbRecipes, dbHabitFilter, dbDietFilter]);

  // Detect whether category filtering can be toggled against a larger all-recipes list
  const canToggleDbRecipeScope = useMemo(() => {
    if (!focusIndex || !weeklyPlan) return false;

    const sorted = [...dbRecipes].sort((a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''), undefined, {
        sensitivity: 'base',
      }),
    );

    const slotType = weeklyPlan[focusIndex.day - 1]?.meals[focusIndex.meal]?.type;
    if (!slotType) return false;

    const matchingCount = sorted.filter((recipe) => guessMealType(recipe) === slotType).length;
    return matchingCount > 0 && matchingCount < sorted.length;
  }, [dbRecipes, focusIndex, weeklyPlan]);

  // Keep the selected DB recipe index inside valid bounds
  useEffect(() => {
    if (!isChoosingDbRecipe) return;
    if (dbRecipeCandidates.length === 0) {
      setDbRecipeChoiceIndex(0);
      return;
    }

    if (dbRecipeChoiceIndex >= dbRecipeCandidates.length) {
      setDbRecipeChoiceIndex(dbRecipeCandidates.length - 1);
    }
  }, [isChoosingDbRecipe, dbRecipeCandidates, dbRecipeChoiceIndex]);

  const dbRecipeWindowStart = useMemo(() => {
    if (dbRecipeCandidates.length <= DB_RECIPE_PICKER_WINDOW_SIZE) return 0;

    const centered = dbRecipeChoiceIndex - Math.floor(DB_RECIPE_PICKER_WINDOW_SIZE / 2);
    const maxStart = Math.max(0, dbRecipeCandidates.length - DB_RECIPE_PICKER_WINDOW_SIZE);
    return Math.max(0, Math.min(maxStart, centered));
  }, [dbRecipeCandidates.length, dbRecipeChoiceIndex]);

  const visibleDbRecipeCandidates = useMemo(
    () =>
      dbRecipeCandidates.slice(
        dbRecipeWindowStart,
        dbRecipeWindowStart + DB_RECIPE_PICKER_WINDOW_SIZE,
      ),
    [dbRecipeCandidates, dbRecipeWindowStart],
  );

  // Computes ingredients missing from current inventory for a recipe
  const computeMissing = (recipe: RecipeRow): string[] => {
    const ingredients = parseIngredients(recipe);
    if (ingredients.length === 0) return [];
    return ingredients.filter((ing) => !inventoryNameSet.has(ing.toLowerCase()));
  };

  type RecipeStockCoverage = {
    recipe: RecipeRow;
    missingNames: string[];
    coverageScore: number;
    missingCount: number;
  };

  const computeRecipeStockCoverage = (recipe: RecipeRow): RecipeStockCoverage => {
    const ingredientRows = parseIngredientAmounts(recipe);
    if (ingredientRows.length === 0) {
      return {
        recipe,
        missingNames: [],
        coverageScore: 0,
        missingCount: 0,
      };
    }

    const baseServingsRaw = Number(recipe.servings ?? 1);
    const baseServings =
      Number.isFinite(baseServingsRaw) && baseServingsRaw > 0 ? baseServingsRaw : 1;

    const missingItems = computeMissingForIngredients({
      ingredients: ingredientRows,
      inventoryItems: dbInventory,
      targetServings: baseServings,
      baseServings,
      useSimilarNameForOnListCount: true,
    });

    const missingNames = Array.from(
      new Set(missingItems.map((item) => String(item?.name ?? '').trim()).filter(Boolean)),
    );

    const missingCount = missingNames.length;
    const coverageScore = Math.max(
      0,
      (ingredientRows.length - missingCount) / ingredientRows.length,
    );

    return {
      recipe,
      missingNames,
      coverageScore,
      missingCount,
    };
  };

  const getRankedStockRecipesByType = (type: MealType): RecipeStockCoverage[] => {
    const basePool = recipesByMealType[type] || [];

    return basePool
      .map((recipe) => computeRecipeStockCoverage(recipe))
      .sort((a, b) => {
        if (b.coverageScore !== a.coverageScore) return b.coverageScore - a.coverageScore;
        if (a.missingCount !== b.missingCount) return a.missingCount - b.missingCount;
        return String(a.recipe.title || '').localeCompare(String(b.recipe.title || ''), undefined, {
          sensitivity: 'base',
        });
      });
  };

  const buildMealFromStockCoverage = (
    type: MealType,
    dayIdx: number,
    usedRecipeIds: Set<number>,
    diet: string,
  ): Meal => {
    const ranked = getRankedStockRecipesByType(type);

    if (ranked.length === 0) {
      return {
        type,
        name: `${type} Recipe`,
        time: DEFAULT_TIME_BY_TYPE[type],
        missing: [],
        diet,
        source: 'stock',
        locked: false,
      };
    }

    const baseIndex = dayIdx % ranked.length;
    let selected = ranked[baseIndex]!;

    for (let offset = 0; offset < ranked.length; offset += 1) {
      const candidate = ranked[(baseIndex + offset) % ranked.length]!;
      if (!usedRecipeIds.has(candidate.recipe.id)) {
        selected = candidate;
        break;
      }
    }

    usedRecipeIds.add(selected.recipe.id);

    return {
      type,
      name: selected.recipe.title || `${type} Recipe`,
      time: DEFAULT_TIME_BY_TYPE[type],
      missing: selected.missingNames,
      diet,
      source: 'stock',
      locked: false,
    };
  };

  const buildStockDbPlan = (diet: string): DayPlan[] =>
    Array.from({ length: days }, (_, i) => {
      const usedRecipeIds = new Set<number>();
      return {
        dayNumber: i + 1,
        meals: [
          buildMealFromStockCoverage('Breakfast', i, usedRecipeIds, diet),
          buildMealFromStockCoverage('Lunch', i, usedRecipeIds, diet),
          buildMealFromStockCoverage('Dinner', i, usedRecipeIds, diet),
        ],
      };
    });

  // Preserves user-locked/manual meals when regenerating plans
  const mergePlanWithManualMeals = (
    newPlan: DayPlan[],
    existingPlan: DayPlan[] | null,
  ): DayPlan[] => {
    if (!existingPlan) return newPlan;

    return newPlan.map((day) => {
      const existingDay = existingPlan.find((item) => item.dayNumber === day.dayNumber);
      if (!existingDay) return day;

      return {
        ...day,
        meals: day.meals.map((meal, mealIdx) => {
          const existingMeal = existingDay.meals[mealIdx];
          if (existingMeal?.locked || existingMeal?.source === 'manual') return existingMeal;
          return meal;
        }),
      };
    });
  };

  // Builds one meal from DB recipes (with fallback if pool is empty)
  const buildMealFromRecipe = (
    type: MealType,
    dayIdx: number,
    offset: number,
    diet: string,
    source: Meal['source'] = 'db',
  ): Meal => {
    const pool = recipesByMealType[type];
    if (!pool || pool.length === 0) {
      return {
        type,
        name: `${type} Recipe`,
        time: DEFAULT_TIME_BY_TYPE[type],
        missing: [],
        diet,
        source,
        locked: false,
      };
    }

    const recipe = pickCircular<RecipeRow>(pool, dayIdx + offset);
    return {
      type,
      name: recipe.title || `${type} Recipe`,
      time: DEFAULT_TIME_BY_TYPE[type],
      missing: computeMissing(recipe),
      diet,
      source,
      locked: false,
    };
  };

  // Builds a full day-by-day plan only from DB recipes
  const buildDbPlan = (diet: string): DayPlan[] =>
    Array.from({ length: days }, (_, i) => ({
      dayNumber: i + 1,
      meals: [
        buildMealFromRecipe('Breakfast', i, 0, diet, 'db'),
        buildMealFromRecipe('Lunch', i, 1, diet, 'db'),
        buildMealFromRecipe('Dinner', i, 2, diet, 'db'),
      ],
    }));

  const buildEmptySelfPlannedMeal = (type: MealType, diet: string): Meal => ({
    type,
    name: 'No planned recipe',
    time: DEFAULT_TIME_BY_TYPE[type],
    missing: [],
    diet,
    source: 'self-planned',
    locked: false,
  });

  const buildSelfPlannedPlan = (): {
    plan: DayPlan[];
    dayCount: number;
    filledSlots: number;
    diet: (typeof DIETS)[number];
  } => {
    // Query recipes directly to avoid stale screen cache
    const liveRecipes = db.select().from(recipes).all() as RecipeRow[];
    const plannedEntries = getPlannedRecipeEntries();
    const recipesById = new Map<number, RecipeRow>(
      liveRecipes.map((recipe) => [recipe.id, recipe]),
    );

    const candidateRecipes: RecipeRow[] = [];

    for (const entry of plannedEntries) {
      const recipe = recipesById.get(entry.recipeId);
      if (!recipe) continue;

      const matchedCategory = parseRecipeCategories(recipe).find(
        (category): category is RecipeCategory =>
          category === 'breakfast' || category === 'lunch' || category === 'dinner',
      );

      if (!matchedCategory) continue;
      if (!recipeMatchesPlanningHabit(recipe, selectedPlanningHabit)) continue;
      if (!recipeMatchesPlanningDiet(recipe, toDietFilter(selectedGlobalDiet))) continue;
      // Preserve user-defined order from RecipesView before balancing
      candidateRecipes.push(recipe);
    }

    const pools = distributeRecipesAcrossCategories(candidateRecipes);

    const dayCount = Math.max(pools.breakfast.length, pools.lunch.length, pools.dinner.length);
    const filledSlots = pools.breakfast.length + pools.lunch.length + pools.dinner.length;
    const diet = selectedGlobalDiet;

    if (dayCount === 0 || filledSlots === 0) {
      throw new Error(
        'No planned recipes with categories breakfast/lunch/dinner found in Recipes view.',
      );
    }

    // Pick one recipe per slot while avoiding duplicate recipe ids in the same day when possible
    const takeRecipeForDay = (
      queue: RecipeRow[],
      usedRecipeIds: Set<number>,
    ): RecipeRow | undefined => {
      if (queue.length === 0) return undefined;

      for (let attempt = 0; attempt < queue.length; attempt += 1) {
        const candidate = queue.shift()!;
        if (!usedRecipeIds.has(candidate.id)) {
          usedRecipeIds.add(candidate.id);
          return candidate;
        }
        queue.push(candidate);
      }

      const fallback = queue.shift()!;
      usedRecipeIds.add(fallback.id);
      return fallback;
    };

    const breakfastQueue = [...pools.breakfast];
    const lunchQueue = [...pools.lunch];
    const dinnerQueue = [...pools.dinner];

    const plan = Array.from({ length: dayCount }, (_, index) => {
      const usedRecipeIds = new Set<number>();
      const breakfastRecipe = takeRecipeForDay(breakfastQueue, usedRecipeIds);
      const lunchRecipe = takeRecipeForDay(lunchQueue, usedRecipeIds);
      const dinnerRecipe = takeRecipeForDay(dinnerQueue, usedRecipeIds);

      return {
        dayNumber: index + 1,
        meals: [
          breakfastRecipe
            ? ({
                type: 'Breakfast',
                name: breakfastRecipe.title || 'Breakfast Recipe',
                time: DEFAULT_TIME_BY_TYPE.Breakfast,
                missing: computeMissing(breakfastRecipe),
                diet,
                source: 'self-planned',
                locked: false,
              } as Meal)
            : buildEmptySelfPlannedMeal('Breakfast', diet),
          lunchRecipe
            ? ({
                type: 'Lunch',
                name: lunchRecipe.title || 'Lunch Recipe',
                time: DEFAULT_TIME_BY_TYPE.Lunch,
                missing: computeMissing(lunchRecipe),
                diet,
                source: 'self-planned',
                locked: false,
              } as Meal)
            : buildEmptySelfPlannedMeal('Lunch', diet),
          dinnerRecipe
            ? ({
                type: 'Dinner',
                name: dinnerRecipe.title || 'Dinner Recipe',
                time: DEFAULT_TIME_BY_TYPE.Dinner,
                missing: computeMissing(dinnerRecipe),
                diet,
                source: 'self-planned',
                locked: false,
              } as Meal)
            : buildEmptySelfPlannedMeal('Dinner', diet),
        ],
      };
    });

    return { plan, dayCount, filledSlots, diet };
  };

  // Finds the best matching DB recipe for a meal name (exact -> partial -> global fallback)
  const findRecipeForMealName = (name: string | undefined, type: MealType): RecipeRow | null => {
    const normalizedName = normalizeRecipeTitle(name);
    if (!normalizedName) return null;

    const candidates = recipesByMealType[type] || [];
    const exact = candidates.find(
      (recipe) => normalizeRecipeTitle(recipe.title) === normalizedName,
    );
    if (exact) return exact;

    const partial = candidates.find((recipe) => {
      const recipeTitle = normalizeRecipeTitle(recipe.title);
      return recipeTitle.includes(normalizedName) || normalizedName.includes(recipeTitle);
    });
    if (partial) return partial;

    return (
      dbRecipes.find((recipe) => {
        const recipeTitle = normalizeRecipeTitle(recipe.title);
        return recipeTitle.includes(normalizedName) || normalizedName.includes(recipeTitle);
      }) || null
    );
  };

  // Show persisted recipe habit under each meal type in the day grid
  const resolveMealHabitLabel = (meal: Meal): string => {
    if (meal.name === 'No planned recipe') return '-';

    if (meal.source === 'ai' || meal.source === 'mixed') {
      const aiHabit = mapDietLabelToHabit(meal.diet);
      if (aiHabit) return aiHabit;
    }

    const recipe = findRecipeForMealName(meal.name, meal.type);
    if (!recipe) return '-';
    return resolvePrimaryHabit(recipe);
  };

  const renderHabitLabel = (raw: string) => {
    if (!raw || raw === '-') return '-';
    return t(`planner.habitOption.${raw}`, language);
  };

  // Export helpers: Markdown / PDF for a focused meal (DB-backed or AI-only)
  const safeFilename = (name: string | undefined) =>
    String(name || 'recipe')
      .trim()
      .replace(/[/\\?%*:|"<>]/g, '_');

  const exportMealToMarkdown = (meal: Meal): string => {
    const recipe = findRecipeForMealName(meal.name, meal.type);
    const lines: string[] = [];

    if (recipe) {
      lines.push(`# ${recipe.title || meal.name}`);
      lines.push('');
      lines.push(`- Time: ${meal.time || DEFAULT_TIME_BY_TYPE[meal.type]}`);
      if (meal.diet) lines.push(`- Diet: ${meal.diet}`);
      lines.push('');

      const parsedIngredients = parseIngredientAmounts(recipe);
      if (parsedIngredients.length > 0) {
        lines.push('## Ingredients', '');
        for (const ing of parsedIngredients) {
          lines.push(`- ${ing.amount} ${ing.unit} ${ing.name}`);
        }
        lines.push('');
      }

      // Instructions may be persisted as JSON array or plain text
      let instructions: string[] = [];
      try {
        const parsed = JSON.parse(String((recipe as any).instructions || '[]'));
        if (Array.isArray(parsed))
          instructions = parsed.map((s) => String(s).trim()).filter(Boolean);
        else if (typeof parsed === 'string')
          instructions = String(parsed)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
      } catch {
        const raw = String((recipe as any).instructions || '');
        instructions = raw
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (instructions.length > 0) {
        lines.push('## Instructions', '');
        instructions.forEach((inst, i) => lines.push(`${i + 1}. ${inst}`));
      }
    } else {
      lines.push(`# ${meal.name}`);
      lines.push('');
      lines.push(`- Time: ${meal.time || DEFAULT_TIME_BY_TYPE[meal.type]}`);
      if (meal.diet) lines.push(`- Diet: ${meal.diet}`);
      if (meal.missing && meal.missing.length > 0) {
        lines.push('');
        lines.push('## Missing Ingredients', '');
        for (const m of meal.missing) lines.push(`- ${m}`);
      }
    }

    const filename = `${safeFilename(recipe ? recipe.title || meal.name : meal.name)}.md`;
    const filePath = join(process.cwd(), filename);
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  };

  // Read recipe instructions from JSON or plain text and normalize them to a string array.
  const parseRecipeInstructions = (recipe: RecipeRow | null): string[] => {
    if (!recipe) return [];

    let instructions: string[] = [];
    try {
      const parsed = JSON.parse(String((recipe as any).instructions || '[]'));
      if (Array.isArray(parsed)) {
        instructions = parsed.map((s) => String(s).trim()).filter(Boolean);
      } else if (typeof parsed === 'string') {
        instructions = String(parsed)
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch {
      const raw = String((recipe as any).instructions || '');
      instructions = raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return instructions;
  };

  // Render a single meal section into the current PDF document.
  const renderMealPdfSection = (doc: any, meal: Meal, options?: { showMealHeading?: boolean }) => {
    const recipe = findRecipeForMealName(meal.name, meal.type);
    const title = recipe ? recipe.title || meal.name : meal.name;

    if (options?.showMealHeading !== false) {
      doc.fontSize(14).text(`${meal.type}: ${title}`, { underline: true });
    }
    doc.moveDown(0.25);
    doc.fontSize(12).text(`Time: ${meal.time || DEFAULT_TIME_BY_TYPE[meal.type]}`);
    if (meal.diet) doc.text(`Diet: ${meal.diet}`);
    if (meal.source) doc.text(`Source: ${meal.source}`);
    doc.moveDown(0.5);

    if (recipe) {
      const parsedIngredients = parseIngredientAmounts(recipe);
      if (parsedIngredients.length > 0) {
        doc.fontSize(13).text('Ingredients');
        doc.moveDown(0.25);
        for (const ing of parsedIngredients) {
          doc.fontSize(12).text(`- ${ing.amount} ${ing.unit} ${ing.name}`);
        }
        doc.moveDown(0.5);
      }

      const instructions = parseRecipeInstructions(recipe);
      if (instructions.length > 0) {
        doc.fontSize(13).text('Instructions');
        doc.moveDown(0.25);
        instructions.forEach((inst, i) => doc.fontSize(12).text(`${i + 1}. ${inst}`));
        doc.moveDown(0.5);
      }
    } else if (meal.missing && meal.missing.length > 0) {
      doc.fontSize(13).text('Missing Ingredients');
      doc.moveDown(0.25);
      meal.missing.forEach((m) => doc.fontSize(12).text(`- ${m}`));
      doc.moveDown(0.5);
    }
  };

  // Export only the currently focused meal to a standalone PDF file.
  const exportMealToPdf = async (meal: Meal): Promise<string> => {
    const recipe = findRecipeForMealName(meal.name, meal.type);
    const { default: PDFDocument } = await import('pdfkit');

    return new Promise((resolve, reject) => {
      const filename = `${safeFilename(recipe ? recipe.title || meal.name : meal.name)}.pdf`;
      const filePath = join(process.cwd(), filename);
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const stream = createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(20).text(recipe ? recipe.title || meal.name : meal.name, { underline: true });
      doc.moveDown();
      renderMealPdfSection(doc, meal, { showMealHeading: false });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    });
  };

  // Export the full weekly plan to a single PDF file.
  const exportPlanToPdf = async (plan: DayPlan[]): Promise<string> => {
    const { default: PDFDocument } = await import('pdfkit');

    return new Promise((resolve, reject) => {
      const filename = `meal-plan-${plan.length}-days.pdf`;
      const filePath = join(process.cwd(), filename);
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const stream = createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(22).text('Weekly Meal Plan', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Days: ${plan.length}`);
      doc.text(`Generated mode: ${generationMode}`);
      doc.text(`Diet: ${selectedGlobalDiet}`);
      doc.text(`Habit filter: ${selectedPlanningHabit}`);
      doc.moveDown();

      plan.forEach((day, dayIndex) => {
        if (dayIndex > 0) {
          doc.addPage();
        }

        doc.fontSize(18).text(`Day ${day.dayNumber}`, { underline: true });
        doc.moveDown(0.75);

        day.meals.forEach((meal, mealIndex) => {
          renderMealPdfSection(doc, meal);

          if (mealIndex < day.meals.length - 1) {
            doc.moveDown(0.5);
          }
        });
      });

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    });
  };

  const isRecipeMissingCoveredByShoppingList = (recipe: RecipeRow): boolean => {
    const ingredientRows = parseIngredientAmounts(recipe);
    const missingItems = computeMissingForIngredients({
      ingredients: ingredientRows,
      inventoryItems: dbInventory,
      shoppingListItems: todayListItems,
      targetServings: 1,
      baseServings: 1,
      useSimilarNameForOnListCount: true,
    });

    return isMissingCoveredByShoppingList(missingItems, todayListItems);
  };

  // Cache list coverage status for each rendered meal slot
  const mealMissingCoveredMap = useMemo(() => {
    const result = new Map<string, boolean>();
    if (!weeklyPlan) return result;

    for (const day of weeklyPlan) {
      day.meals.forEach((meal, mealIndex) => {
        const key = `${day.dayNumber}-${mealIndex}`;
        if (meal.missing.length === 0) {
          result.set(key, false);
          return;
        }

        const recipe = findRecipeForMealName(meal.name, meal.type);
        if (recipe) {
          result.set(key, isRecipeMissingCoveredByShoppingList(recipe));
          return;
        }

        // Fallback for non-DB meals: consider a meal covered when every missing
        // ingredient has at least one similar item on today's shopping list.
        const allCovered = meal.missing.every((missingName) =>
          todayListItems.some((item) => areSimilarItemNames(String(item.name || ''), missingName)),
        );
        result.set(key, allCovered);
      });
    }

    return result;
  }, [weeklyPlan, dbInventory, todayListItems, dbRecipes]);

  // Available user actions for updating a single meal slot
  const MEAL_ACTIONS: { key: MealAction; label: string; hint: string }[] = [
    {
      key: 'manual',
      label: t('planner.action.manual.label', language),
      hint: t('planner.action.manual.hint', language),
    },
    {
      key: 'ai',
      label: t('planner.action.ai.label', language),
      hint: t('planner.action.ai.hint', language),
    },
    {
      key: 'db',
      label: t('planner.action.db.label', language),
      hint: t('planner.action.db.hint', language),
    },
  ];

  // Converts one AI meal item to internal Meal format, with fallbacks and DB matching
  const buildMealFromAiItem = (
    item: AiMealItem | undefined,
    fallbackType: MealType,
    diet: string,
    internetRecipes: InternetRecipeCandidate[],
  ): Meal => {
    // Keep slot category stable even when AI returns noisy or swapped meal types.
    const type = fallbackType;
    const recipe = findRecipeForMealName(item?.name, type);

    const internetRecipe = (() => {
      const normalizedMealName = normalizeRecipeTitle(item?.name);
      if (!normalizedMealName) return null;

      const exact = internetRecipes.find(
        (candidate) => normalizeRecipeTitle(candidate.title) === normalizedMealName,
      );
      if (exact) return exact;

      return (
        internetRecipes.find((candidate) => {
          const candidateTitle = normalizeRecipeTitle(candidate.title);
          return (
            candidateTitle.includes(normalizedMealName) ||
            normalizedMealName.includes(candidateTitle)
          );
        }) || null
      );
    })();

    const missingFromInternetRecipe = (() => {
      if (!internetRecipe || internetRecipe.ingredients.length === 0) return [];

      const missingIngredients = internetRecipe.ingredients.filter((ingredient) => {
        const normalizedIngredient = ingredient.trim().toLowerCase();
        if (!normalizedIngredient) return false;

        if (inventoryNameSet.has(normalizedIngredient)) return false;

        for (const inventoryName of inventoryNameSet) {
          if (areSimilarItemNames(normalizedIngredient, inventoryName)) return false;
        }

        return true;
      });

      return missingIngredients;
    })();

    const inferredHabit: HabitFilter = recipe
      ? toHabitFilter(resolvePrimaryHabit(recipe))
      : internetRecipe
        ? inferHabitFromIngredientNames(internetRecipe.ingredients)
        : toHabitFilter(mapDietLabelToHabit(diet) || 'all');

    return {
      type,
      name: item?.name?.trim() || recipe?.title || `${type} AI Suggestion`,
      time: item?.time?.trim() || DEFAULT_TIME_BY_TYPE[type],
      missing: recipe ? computeMissing(recipe) : missingFromInternetRecipe,
      diet: mapHabitToDietLabel(inferredHabit),
      source: 'ai',
      locked: false,
    };
  };

  const pickAiMealForType = (
    items: AiMealItem[] | undefined,
    targetType: MealType,
    fallbackIndex: number,
  ): AiMealItem | undefined => {
    if (!Array.isArray(items) || items.length === 0) return undefined;

    const exactTypeMatch = items.find(
      (item) => normalizeMealType(item?.type, targetType) === targetType,
    );
    if (exactTypeMatch) return exactTypeMatch;

    return items[fallbackIndex];
  };

  // Parses AI response content and creates a normalized DayPlan[]
  const parseAiPlan = (
    content: string,
    diet: string,
    internetRecipes: InternetRecipeCandidate[],
  ): DayPlan[] => {
    const json = extractJsonArray(content);
    if (!json) throw new Error('No JSON array returned by AI.');
    const parsed = JSON.parse(json) as AiDayItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('AI returned empty plan.');

    const fallbackTypes: MealType[] = ['Breakfast', 'Lunch', 'Dinner'];

    return Array.from({ length: days }, (_, i) => {
      const aiDay = parsed[i] || {};
      return {
        dayNumber: i + 1,
        meals: fallbackTypes.map((fallbackType, mealIdx) =>
          buildMealFromAiItem(
            pickAiMealForType(aiDay.meals, fallbackType, mealIdx),
            fallbackType,
            diet,
            internetRecipes,
          ),
        ),
      };
    });
  };

  const shuffle = <T,>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };

  const uniqueByTitle = (items: InternetRecipeCandidate[]): InternetRecipeCandidate[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.title.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const getInventoryIngredientHints = (): string[] => {
    return dbInventory
      .map((item) =>
        String(item?.name ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean)
      .slice(0, 8);
  };

  const extractMealDbIngredients = (meal: Record<string, unknown>): string[] => {
    const ingredients: string[] = [];

    for (let i = 1; i <= 20; i += 1) {
      const value = String(meal[`strIngredient${i}`] ?? '').trim();
      if (value) ingredients.push(value);
    }

    return ingredients;
  };

  const mapMealDbMeal = (meal: Record<string, unknown>): InternetRecipeCandidate => ({
    title: String(meal.strMeal ?? 'Untitled meal').trim(),
    category: String(meal.strCategory ?? '').trim() || undefined,
    area: String(meal.strArea ?? '').trim() || undefined,
    ingredients: extractMealDbIngredients(meal),
    sourceUrl: String(meal.strSource ?? meal.strYoutube ?? '').trim() || undefined,
  });

  const fetchMealDbJson = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Recipe API request failed: ${response.status}`);
    }

    return (await response.json()) as {
      meals?: Array<Record<string, unknown>> | null;
    };
  };

  const fetchInternetRecipePool = async (diet: string): Promise<InternetRecipeCandidate[]> => {
    const ingredientHints = getInventoryIngredientHints();
    const queries = shuffle(ingredientHints).slice(0, 4);

    const collected: InternetRecipeCandidate[] = [];

    for (const ingredient of queries) {
      const filterUrl = `https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(ingredient)}`;
      const filtered = await fetchMealDbJson(filterUrl);
      const meals = filtered.meals ?? [];

      for (const meal of meals.slice(0, 3)) {
        const id = String(meal.idMeal ?? '').trim();
        if (!id) continue;

        const detailUrl = `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${id}`;
        const detail = await fetchMealDbJson(detailUrl);
        const fullMeal = detail.meals?.[0];
        if (!fullMeal) continue;

        collected.push(mapMealDbMeal(fullMeal));
      }
    }

    while (collected.length < days * 3) {
      const randomData = await fetchMealDbJson(
        'https://www.themealdb.com/api/json/v1/1/random.php',
      );
      const randomMeal = randomData.meals?.[0];
      if (!randomMeal) break;
      collected.push(mapMealDbMeal(randomMeal));
    }

    return uniqueByTitle(collected).slice(0, 18);
  };

  const extractJsonArrayFromText = (value: string): string => {
    const trimmed = value.trim();

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed;
    }

    const codeBlockMatch =
      trimmed.match(/```json\s*([\s\S]*?)\s*```/i) ?? trimmed.match(/```\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
      const inner = codeBlockMatch[1].trim();
      if (inner.startsWith('[') && inner.endsWith(']')) {
        return inner;
      }
    }

    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');

    if (firstBracket >= 0 && lastBracket > firstBracket) {
      return trimmed.slice(firstBracket, lastBracket + 1);
    }

    throw new Error('No JSON array returned by AI.');
  };

  const requestAiPlan = async (diet: string): Promise<DayPlan[]> => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing.');
    }

    const internetRecipes = await fetchInternetRecipePool(diet);

    if (internetRecipes.length === 0) {
      throw new Error('No internet recipes found.');
    }

    const prompt = [
      `Create a ${days}-day meal plan for a ${diet} diet.`,
      `Habit filter: ${selectedPlanningHabit}.`,
      'Use ONLY the provided internet recipes.',
      'Return ONLY a JSON array.',
      'Do not return markdown.',
      'Do not use code fences.',
      'Do not add explanations.',
      'Each day must contain exactly 3 meals: Breakfast, Lunch, Dinner.',
      'Category fidelity is strict: breakfast must be breakfast food, lunch must be lunch food, dinner must be dinner food.',
      'Do not swap categories and do not place one recipe in the wrong meal type.',
      'Use this exact shape:',
      '[{"dayNumber":1,"meals":[{"type":"Breakfast","name":"Recipe title","time":"08:00"},{"type":"Lunch","name":"Recipe title","time":"13:00"},{"type":"Dinner","name":"Recipe title","time":"19:00"}]}]',
      `Internet recipes: ${JSON.stringify(internetRecipes)}`,
    ].join(' ');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'You are a meal planner. Return only a valid JSON array. No markdown, no prose, no code fences.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('OpenAI returned no message content.');
    }

    let parsedContent: unknown;

    try {
      parsedContent = JSON.parse(content);
    } catch {
      const extracted = extractJsonArrayFromText(content);
      return parseAiPlan(extracted, diet, internetRecipes);
    }

    if (Array.isArray(parsedContent)) {
      return parseAiPlan(JSON.stringify(parsedContent), diet, internetRecipes);
    }

    if (
      parsedContent &&
      typeof parsedContent === 'object' &&
      Array.isArray((parsedContent as { plan?: unknown }).plan)
    ) {
      return parseAiPlan(
        JSON.stringify((parsedContent as { plan: unknown[] }).plan),
        diet,
        internetRecipes,
      );
    }

    throw new Error('No JSON array returned by AI.');
  };

  const parseAiStockIngredients = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }

    return [];
  };

  const computeMissingFromIngredientNames = (ingredients: string[]): string[] => {
    if (!ingredients.length) return [];

    return ingredients.filter((ingredient) => {
      const normalizedIngredient = ingredient.trim().toLowerCase();
      if (!normalizedIngredient) return false;

      if (inventoryNameSet.has(normalizedIngredient)) return false;

      for (const inventoryName of inventoryNameSet) {
        if (areSimilarItemNames(normalizedIngredient, inventoryName)) return false;
      }

      return true;
    });
  };

  const requestAiStockPlan = async (diet: string): Promise<DayPlan[]> => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing.');
    }

    const inventoryNames = Array.from(
      new Set(dbInventory.map((item) => String(item?.name ?? '').trim()).filter(Boolean)),
    );

    if (inventoryNames.length === 0) {
      throw new Error('No inventory ingredients available for STOCK AI mode.');
    }

    const prompt = [
      `Create a ${days}-day meal plan for a ${diet} diet.`,
      `Habit filter: ${selectedPlanningHabit}.`,
      'Use ONLY ingredients from the inventory list.',
      'Do not invent additional ingredients.',
      'Return ONLY a JSON array.',
      'Do not return markdown.',
      'Do not use code fences.',
      'Do not add explanations.',
      'Each day must contain exactly 3 meals: Breakfast, Lunch, Dinner.',
      'Use this exact shape:',
      '[{"dayNumber":1,"meals":[{"type":"Breakfast","name":"Recipe title","time":"08:00","ingredients":["Eggs","Milk"]},{"type":"Lunch","name":"Recipe title","time":"13:00","ingredients":["Tomatoes"]},{"type":"Dinner","name":"Recipe title","time":"19:00","ingredients":["Rice"]}]}]',
      `Inventory ingredients: ${JSON.stringify(inventoryNames)}`,
    ].join(' ');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'You are a meal planner. Return only a valid JSON array. Use only ingredients from the provided inventory list.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI STOCK request failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('OpenAI returned no message content.');
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      const extracted = extractJsonArrayFromText(content);
      parsedContent = JSON.parse(extracted);
    }

    const parsedArray = Array.isArray(parsedContent)
      ? parsedContent
      : parsedContent &&
          typeof parsedContent === 'object' &&
          Array.isArray((parsedContent as { plan?: unknown }).plan)
        ? (parsedContent as { plan: unknown[] }).plan
        : null;

    if (!parsedArray) {
      throw new Error('No JSON array returned by AI.');
    }

    const fallbackTypes: MealType[] = ['Breakfast', 'Lunch', 'Dinner'];

    return Array.from({ length: days }, (_, i) => {
      const aiDay = (parsedArray[i] || {}) as AiStockDayItem;
      const meals = Array.isArray(aiDay.meals) ? aiDay.meals : [];

      return {
        dayNumber: i + 1,
        meals: fallbackTypes.map((fallbackType, mealIdx) => {
          const rawMeal = pickAiMealForType(meals, fallbackType, mealIdx) as
            | AiStockMealItem
            | undefined;
          const ingredientNames = parseAiStockIngredients(rawMeal?.ingredients);

          return {
            type: fallbackType,
            name: String(rawMeal?.name || `${fallbackType} Stock Suggestion`).trim(),
            time: String(rawMeal?.time || DEFAULT_TIME_BY_TYPE[fallbackType]).trim(),
            missing: computeMissingFromIngredientNames(ingredientNames),
            diet,
            source: 'ai',
            locked: false,
          };
        }),
      };
    });
  };

  //Combines DB structure with AI naming/time suggestions
  const buildMixedPlan = async (diet: string): Promise<DayPlan[]> => {
    const dbPlan = buildDbPlan(diet);
    const aiPlan = await requestAiPlan(diet);

    // Extracts JSON array from response and converts to internal DayPlan[] format
    return dbPlan.map((day, dayIdx) => ({
      ...day,
      meals: day.meals.map((dbMeal, mealIdx) => {
        const aiMeal = aiPlan[dayIdx]?.meals?.[mealIdx];
        if (!aiMeal) return { ...dbMeal, source: 'db' };

        const matchedDbRecipe = findRecipeForMealName(aiMeal.name, dbMeal.type);

        if (matchedDbRecipe) {
          return {
            ...dbMeal,
            name: matchedDbRecipe.title || aiMeal.name || dbMeal.name,
            time: aiMeal.time || dbMeal.time,
            missing: computeMissing(matchedDbRecipe),
            diet: mapHabitToDietLabel(toHabitFilter(resolvePrimaryHabit(matchedDbRecipe))),
            source: 'db',
            locked: false,
          };
        }

        return {
          ...dbMeal,
          name: aiMeal.name || dbMeal.name,
          time: aiMeal.time || dbMeal.time,
          missing: aiMeal.missing,
          diet: aiMeal.diet,
          source: 'ai',
          locked: false,
        };
      }),
    }));
  };

  // Applies generated plan and resets focus/scroll state
  const applyGeneratedPlan = (
    nextPlan: DayPlan[],
    preserveManualMeals: boolean,
    mode: GenerationMode,
    dayCount: number = days,
    dietOverride?: (typeof DIETS)[number],
  ) => {
    const mergedPlan = preserveManualMeals
      ? mergePlanWithManualMeals(nextPlan, weeklyPlan)
      : nextPlan;
    const dietToPersist = dietOverride || selectedGlobalDiet;
    setWeeklyPlan(mergedPlan);
    setFocusIndex({ day: 1, meal: 0 });
    setScrollOffset(0);
    setDays(dayCount);

    const nextDietIndex = DIETS.findIndex((diet) => diet === dietToPersist);
    if (nextDietIndex >= 0) {
      setDietIndex(nextDietIndex);
    }

    persistPlanSnapshot(mergedPlan, mode, dietToPersist, dayCount);
  };

  // Main plan generation entry point (db | ai | mixed | self-planned) with fallback handling
  const generatePlan = async (mode: GenerationMode, preserveManualMeals = false) => {
    setLoading(true);
    setError(null);
    setStatusMessage(null);

    const buildStockInsufficientNotice = (plan: DayPlan[]): string | null => {
      const totalMeals = plan.reduce((sum, day) => sum + day.meals.length, 0);
      if (totalMeals === 0) return null;

      const missingMeals = plan.reduce(
        (sum, day) => sum + day.meals.filter((meal) => meal.missing.length > 0).length,
        0,
      );

      if (missingMeals === 0) return null;

      return t('planner.stock.notice.insufficient', language, {
        missingMeals,
        totalMeals,
      });
    };

    try {
      loadDbData();

      if (mode === 'db') {
        applyGeneratedPlan(buildDbPlan(selectedGlobalDiet), preserveManualMeals, 'db');
        return;
      }

      if (mode === 'ai') {
        applyGeneratedPlan(await requestAiPlan(selectedGlobalDiet), preserveManualMeals, 'ai');
        return;
      }

      if (mode === 'self-planned') {
        // Build day slots from categorized planned recipes only
        const selfPlanned = buildSelfPlannedPlan();
        applyGeneratedPlan(
          selfPlanned.plan,
          preserveManualMeals,
          'self-planned',
          selfPlanned.dayCount,
          selfPlanned.diet,
        );

        if (selfPlanned.filledSlots < selfPlanned.dayCount * 3) {
          setError(
            'Some slots could not be auto-filled by category. Use [e] on a slot to set it manually.',
          );
        }
        return;
      }

      if (mode === 'stock') {
        if (selectedStockOption === 'ai') {
          const aiStockPlan = await requestAiStockPlan(selectedGlobalDiet);
          const stockNotice = buildStockInsufficientNotice(aiStockPlan);
          applyGeneratedPlan(aiStockPlan, preserveManualMeals, 'stock');
          if (stockNotice) setStatusMessage(stockNotice);
          return;
        }

        const dbStockPlan = buildStockDbPlan(selectedGlobalDiet);
        const stockNotice = buildStockInsufficientNotice(dbStockPlan);
        applyGeneratedPlan(dbStockPlan, preserveManualMeals, 'stock');
        if (stockNotice) setStatusMessage(stockNotice);
        return;
      }

      applyGeneratedPlan(await buildMixedPlan(selectedGlobalDiet), preserveManualMeals, 'mixed');
    } catch (err) {
      if (mode !== 'db' && mode !== 'self-planned' && mode !== 'stock') {
        applyGeneratedPlan(buildDbPlan(selectedGlobalDiet), preserveManualMeals, 'db');
        setError(
          `Mode ${mode.toUpperCase()} failed, switched to DB: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      } else if (mode === 'stock') {
        const fallbackStockPlan = buildStockDbPlan(selectedGlobalDiet);
        const stockNotice = buildStockInsufficientNotice(fallbackStockPlan);
        applyGeneratedPlan(fallbackStockPlan, preserveManualMeals, 'stock');
        setError(t('planner.error.aiFallback', language));
        if (stockNotice) setStatusMessage(stockNotice);
      } else if (mode === 'self-planned') {
        setError(err instanceof Error ? err.message : 'Self-planned generation failed.');
      } else {
        setError('Failed to generate planner data from DB.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Replaces exactly one meal slot using the selected generation mode (with AI or DB fallback)
  const replaceSingleMealWithMode = async (
    dayNum: number,
    mealIdx: number,
    newDiet: string,
    mode: 'db' | 'ai' | 'mixed' = generationMode === 'self-planned' || generationMode === 'stock'
      ? 'db'
      : generationMode,
  ) => {
    if (!weeklyPlan) return;
    setLoading(true);
    setError(null);

    try {
      const type = weeklyPlan[dayNum - 1]?.meals[mealIdx]?.type ?? 'Lunch';
      let replacement: Meal;

      if (mode === 'db') {
        replacement = buildMealFromRecipe(type, dayNum - 1, mealIdx + 3, newDiet, 'db');
      } else {
        const aiPlan = await requestAiPlan(newDiet);
        replacement =
          aiPlan[dayNum - 1]?.meals?.[mealIdx] ||
          buildMealFromRecipe(type, dayNum - 1, mealIdx + 3, newDiet, 'db');

        if (mode === 'mixed') {
          const recipe = findRecipeForMealName(replacement.name, replacement.type);
          replacement = {
            ...replacement,
            missing: recipe ? computeMissing(recipe) : replacement.missing,
            diet: recipe
              ? mapHabitToDietLabel(toHabitFilter(resolvePrimaryHabit(recipe)))
              : replacement.diet,
            source: recipe ? 'db' : 'ai',
          };
        }
      }

      let savedPlan: DayPlan[] | null = null;

      setWeeklyPlan((prev) => {
        if (!prev) return null;
        const next = [...prev];
        const day = next[dayNum - 1];
        if (!day) return next;
        const meals = [...day.meals];
        meals[mealIdx] = { ...replacement, diet: newDiet, locked: false };
        next[dayNum - 1] = { ...day, meals };
        savedPlan = next;
        return next;
      });

      if (savedPlan) {
        // Keep global plan mode stable when replacing only one slot
        persistPlanSnapshot(savedPlan, generationMode, newDiet, days);
      }
    } catch (err) {
      const fallbackType = weeklyPlan[dayNum - 1]?.meals[mealIdx]?.type ?? 'Lunch';
      const fallback = buildMealFromRecipe(fallbackType, dayNum - 1, mealIdx + 3, newDiet, 'db');

      let fallbackPlan: DayPlan[] | null = null;

      setWeeklyPlan((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        const day = next[dayNum - 1];
        if (!day) return next;
        const meals = [...day.meals];
        meals[mealIdx] = fallback;
        next[dayNum - 1] = { ...day, meals };
        fallbackPlan = next;
        return next;
      });

      if (fallbackPlan) {
        // Persist fallback inside the active plan context
        persistPlanSnapshot(fallbackPlan, generationMode, newDiet, days);
      }

      setError(err instanceof Error ? err.message : 'Meal update failed.');
    } finally {
      setLoading(false);
    }
  };

  // Handles single-slot action selection (manual edit or auto replacement)
  const handleMealAction = async (action: MealAction) => {
    if (!focusIndex || !weeklyPlan) return;

    const currentMeal = weeklyPlan[focusIndex.day - 1]?.meals[focusIndex.meal];
    const currentDiet = currentMeal?.diet || selectedGlobalDiet;

    setIsChoosingMealAction(false);

    if (action === 'manual') {
      setMealNameInput(currentMeal?.name || '');
      setIsEditingMealName(true);
      return;
    }

    if (action === 'db') {
      setDbRecipeChoiceIndex(0);
      setShowAllDbRecipes(false);
      setDbHabitFilter('all');
      setIsChoosingDbRecipe(true);
      return;
    }

    if (action === 'ai') {
      setAiHabitChoiceIndex(0);
      setIsChoosingAiHabit(true);
      return;
    }

    await replaceSingleMealWithMode(
      focusIndex.day,
      focusIndex.meal,
      currentDiet,
      generationMode === 'mixed' ? 'mixed' : generationMode === 'ai' ? 'ai' : 'ai',
    );
  };

  const confirmAiReplaceWithHabit = async () => {
    if (!focusIndex || !weeklyPlan) return;
    const selectedHabit = EDIT_SLOT_HABIT_FILTERS[aiHabitChoiceIndex] || 'all';
    const selectedDietChoice = EDIT_SLOT_DIET_FILTERS[aiDietChoiceIndex] || 'standard';

    // Habit (vegetarian/vegan) takes precedence for AI prompt. Otherwise use diet.
    const aiDietPrompt =
      selectedHabit === 'vegetarian'
        ? 'Vegetarian'
        : selectedHabit === 'vegan'
          ? 'Vegan'
          : selectedDietChoice === 'standard'
            ? 'Standard'
            : selectedDietChoice === 'lactose-free'
              ? 'Lactose-Free'
              : 'Gluten-Free';

    setIsChoosingAiHabit(false);

    await replaceSingleMealWithMode(
      focusIndex.day,
      focusIndex.meal,
      aiDietPrompt,
      generationMode === 'mixed' ? 'mixed' : 'ai',
    );
  };

  // Apply selected DB recipe directly into the focused slot
  const applySelectedDbRecipeToSlot = () => {
    if (!weeklyPlan || !focusIndex) return;
    const selectedRecipe = dbRecipeCandidates[dbRecipeChoiceIndex];
    if (!selectedRecipe) return;

    const slotType =
      weeklyPlan[focusIndex.day - 1]?.meals[focusIndex.meal]?.type ?? guessMealType(selectedRecipe);
    const currentDiet =
      weeklyPlan[focusIndex.day - 1]?.meals[focusIndex.meal]?.diet || selectedGlobalDiet;

    let savedPlan: DayPlan[] | null = null;

    setWeeklyPlan((prev) => {
      if (!prev) return prev;

      const next = [...prev];
      const day = next[focusIndex.day - 1];
      if (!day) return next;

      const meals = [...day.meals];
      meals[focusIndex.meal] = {
        type: slotType,
        name: selectedRecipe.title || `${slotType} Recipe`,
        time: DEFAULT_TIME_BY_TYPE[slotType],
        missing: computeMissing(selectedRecipe),
        diet: currentDiet,
        source: 'db',
        locked: false,
      };

      next[focusIndex.day - 1] = { ...day, meals };
      savedPlan = next;
      return next;
    });

    if (savedPlan) {
      persistPlanSnapshot(savedPlan, generationMode, currentDiet, days);
    }

    setIsChoosingDbRecipe(false);
  };

  // Toggles lock state for a specific meal slot
  const toggleMealLock = (dayNum: number, mealIdx: number) => {
    let nextPlan: DayPlan[] | null = null;

    setWeeklyPlan((prev) => {
      if (!prev) return prev;

      const updated = prev.map((day) => {
        if (day.dayNumber !== dayNum) return day;

        return {
          ...day,
          meals: day.meals.map((meal, idx) =>
            idx === mealIdx ? { ...meal, locked: !meal.locked } : meal,
          ),
        };
      });

      nextPlan = updated;
      return updated;
    });

    if (nextPlan) {
      persistPlanSnapshot(nextPlan, generationMode, selectedGlobalDiet, days);
    }
  };

  // Saves manually typed meal name and marks slot as manual + locked

  const saveManualMealName = () => {
    if (!weeklyPlan || !focusIndex) return;
    const trimmedName = mealNameInput.trim();
    if (!trimmedName) {
      setIsEditingMealName(false);
      setMealNameInput('');
      setIsChoosingMealAction(false);
      return;
    }

    let nextPlan: DayPlan[] | null = null;

    setWeeklyPlan((prev) => {
      if (!prev) return prev;

      const updated: DayPlan[] = prev.map((day): DayPlan => {
        if (day.dayNumber !== focusIndex.day) return day;

        return {
          ...day,
          meals: day.meals.map(
            (meal, idx): Meal =>
              idx === focusIndex.meal
                ? { ...meal, name: trimmedName, source: 'manual', locked: true, missing: [] }
                : meal,
          ),
        };
      });

      nextPlan = updated;
      return updated;
    });

    if (nextPlan) {
      persistPlanSnapshot(nextPlan, generationMode, selectedGlobalDiet, days);
    }

    setIsEditingMealName(false);
    setMealNameInput('');
  };

  const performPlannerReset = () => {
    try {
      // Reset must clear persisted planner history not only local state
      clearPlannerHistory();
    } catch {
      setError('Could not reset planner history.');
      return;
    }

    setWeeklyPlan(null);
    setFocusIndex(null);
    setIsEditingMealName(false);
    setMealNameInput('');
    setIsChoosingMealAction(false);
    setIsChoosingDbRecipe(false);
    setIsChoosingAiHabit(false);
    setShowAllDbRecipes(false);
    setDbHabitFilter('all');
    setStockOption('db');
    setIsConfirmingReset(false);
    setCurrentGenerationId(null);
    setScrollOffset(0);
    setError(null);
    setStatusMessage(null);
  };

  // Auto-scroll grid to keep focused day visible in viewport
  useEffect(() => {
    if (!weeklyPlan || !focusIndex) return;
    const focusedIdx = Math.max(0, focusIndex.day - 1);
    if (focusedIdx < scrollOffset) setScrollOffset(focusedIdx);
    else if (focusedIdx >= scrollOffset + itemsPerPage)
      setScrollOffset(focusedIdx - itemsPerPage + 1);
  }, [focusIndex, weeklyPlan, scrollOffset, itemsPerPage]);

  // Global keyboard handling for planner actions and navigation
  useInput((input, key) => {
    // Shortcut: Add all missing ingredients from the plan to the shopping list
    if (input === 'S') {
      addAllMissingToShoppingList();
      return;
    }
    if (loading) return; // Prevent navigation while plan is generating

    if (isConfirmingReset) {
      // Confirm dialog consumes input until user accepts or cancels
      if (input.toLowerCase() === 'y' || key.return) {
        performPlannerReset();
        return;
      }

      if (input.toLowerCase() === 'n' || key.escape) {
        setIsConfirmingReset(false);
        return;
      }

      return;
    }

    // Text input mode for manual meal name entry
    if (isEditingMealName) {
      if (key.return) return saveManualMealName();
      if (key.escape) {
        setIsEditingMealName(false);
        setMealNameInput('');
        return;
      }
      if (key.backspace || key.delete) {
        setMealNameInput((prev) => prev.slice(0, -1));
        return;
      }
      // Append typed character to meal name input
      if (!key.ctrl && !key.meta && input) setMealNameInput((prev) => prev + input);
      return;
    }

    // Handle keyboard navigation inside DB recipe picker
    if (isChoosingDbRecipe) {
      if (dbRecipeCandidates.length === 0) {
        if (key.escape || key.return) setIsChoosingDbRecipe(false);
        return;
      }

      // Toggle picker scope between matching category and all recipes
      if (input === 's' && canToggleDbRecipeScope) {
        setShowAllDbRecipes((prev) => !prev);
        setDbRecipeChoiceIndex(0);
        return;
      }

      if (input === 'h') {
        const idx = EDIT_SLOT_HABIT_FILTERS.indexOf(dbHabitFilter);
        const next = EDIT_SLOT_HABIT_FILTERS[(idx + 1) % EDIT_SLOT_HABIT_FILTERS.length] || 'all';
        setDbHabitFilter(next);
        setDbRecipeChoiceIndex(0);
        return;
      }

      // Reset DB picker filters to defaults
      if (input === 'r') {
        setDbHabitFilter('all');
        setDbDietFilter('standard');
        setShowAllDbRecipes(false);
        setDbRecipeChoiceIndex(0);
        return;
      }

      // Cycle diet filter for the DB picker
      if (input === 'd') {
        const idx = EDIT_SLOT_DIET_FILTERS.indexOf(dbDietFilter as any);
        const next = EDIT_SLOT_DIET_FILTERS[(idx + 1) % EDIT_SLOT_DIET_FILTERS.length] || 'all';
        setDbDietFilter(next as any);
        setDbRecipeChoiceIndex(0);
        return;
      }

      if (key.upArrow) {
        setDbRecipeChoiceIndex(
          (prev) => (prev - 1 + dbRecipeCandidates.length) % dbRecipeCandidates.length,
        );
        return;
      }
      if (key.downArrow) {
        setDbRecipeChoiceIndex((prev) => (prev + 1) % dbRecipeCandidates.length);
        return;
      }
      if (key.return) {
        applySelectedDbRecipeToSlot();
        return;
      }
      if (key.escape) {
        setIsChoosingDbRecipe(false);
        return;
      }
      return;
    }

    if (isChoosingAiHabit) {
      // Navigation: ↑/↓ switch active line (habit/diet), ←/→ change value, Enter confirm
      if (key.upArrow) {
        setAiPickerActiveLine((prev) => (prev - 1 + 2) % 2);
        return;
      }
      if (key.downArrow) {
        setAiPickerActiveLine((prev) => (prev + 1) % 2);
        return;
      }

      if (key.leftArrow) {
        if (aiPickerActiveLine === 0) {
          setAiHabitChoiceIndex(
            (prev) => (prev - 1 + EDIT_SLOT_HABIT_FILTERS.length) % EDIT_SLOT_HABIT_FILTERS.length,
          );
        } else {
          setAiDietChoiceIndex(
            (prev) => (prev - 1 + EDIT_SLOT_DIET_FILTERS.length) % EDIT_SLOT_DIET_FILTERS.length,
          );
        }
        return;
      }

      if (key.rightArrow) {
        if (aiPickerActiveLine === 0) {
          setAiHabitChoiceIndex((prev) => (prev + 1) % EDIT_SLOT_HABIT_FILTERS.length);
        } else {
          setAiDietChoiceIndex((prev) => (prev + 1) % EDIT_SLOT_DIET_FILTERS.length);
        }
        return;
      }

      if (key.return) {
        void confirmAiReplaceWithHabit();
        return;
      }

      if (key.escape) {
        setIsChoosingAiHabit(false);
        return;
      }

      return;
    }

    // Meal action selection menu (manual/AI/DB replacement)
    if (isChoosingMealAction) {
      if (key.upArrow) {
        setMealActionIndex((prev) => (prev - 1 + MEAL_ACTIONS.length) % MEAL_ACTIONS.length);
        return;
      }
      if (key.downArrow) {
        setMealActionIndex((prev) => (prev + 1) % MEAL_ACTIONS.length);
        return;
      }
      if (input === 'm') return void handleMealAction('manual');
      if (input === 'a') return void handleMealAction('ai');
      if (input === 'd') return void handleMealAction('db');
      if (key.return) return void handleMealAction(MEAL_ACTIONS[mealActionIndex]?.key || 'manual');
      if (key.escape) {
        setIsChoosingMealAction(false);
        return;
      }
      return;
    }

    // Pre-generation setup screen
    if (!weeklyPlan) {
      // In self-planned mode, day count is derived and cannot be adjusted manually
      if (generationMode === 'self-planned') {
        // Day adjustment is not available
      } else {
        if (input === '+') setDays((prev) => Math.min(prev + 1, 14));
        if (input === '-') setDays((prev) => Math.max(prev - 1, 1));
      }
      if (generationMode !== 'self-planned' && input === 'd')
        setDietIndex((prev) => (prev + 1) % DIETS.length);
      if (generationMode !== 'self-planned' && input === 'h')
        setHabitFilterIndex((prev) => (prev + 1) % PLAN_HABITS.length);
      if (generationMode === 'stock' && input === 'o') {
        setStockOption((prev) => (prev === 'db' ? 'ai' : 'db'));
      }
      if (input === 'm')
        setGenerationMode(
          (prev) =>
            GENERATION_MODES[
              (Math.max(0, GENERATION_MODES.indexOf(prev)) + 1) % GENERATION_MODES.length
            ]!,
        );
      if (input === 'g' || key.return) generatePlan(generationMode);
    }
    // Main meal grid navigation and editing
    else if (focusIndex && weeklyPlan) {
      const maxDay = weeklyPlan.length;

      // Navigate between days and meals using arrow keys
      if (key.rightArrow)
        setFocusIndex((p) => (p ? { ...p, day: Math.min(p.day + 1, maxDay) } : null));
      if (key.leftArrow) setFocusIndex((p) => (p ? { ...p, day: Math.max(p.day - 1, 1) } : null));
      if (key.downArrow) setFocusIndex((p) => (p ? { ...p, meal: Math.min(p.meal + 1, 2) } : null));
      if (key.upArrow) setFocusIndex((p) => (p ? { ...p, meal: Math.max(p.meal - 1, 0) } : null));

      if (input === 'e') {
        setMealActionIndex(0);
        setIsChoosingMealAction(true);
      }

      if (input === 'l') toggleMealLock(focusIndex.day, focusIndex.meal);

      // Export the focused meal with m (Markdown) or p (PDF). Use uppercase P to export the full plan.
      if (input === 'm') {
        const dayPlan = weeklyPlan[focusIndex.day - 1];
        const meal = dayPlan?.meals?.[focusIndex.meal];
        if (meal) {
          try {
            const filePath = exportMealToMarkdown(meal);
            setStatusMessage(`Exported to ${filePath}`);
          } catch {
            setStatusMessage('Export failed');
          }
          return;
        }
        // fallback: cycle generation mode when no focused meal
        setGenerationMode(
          (prev) =>
            GENERATION_MODES[
              (Math.max(0, GENERATION_MODES.indexOf(prev)) + 1) % GENERATION_MODES.length
            ]!,
        );
      }

      if (input === 'p') {
        const dayPlan = weeklyPlan[focusIndex.day - 1];
        const meal = dayPlan?.meals?.[focusIndex.meal];
        if (meal) {
          exportMealToPdf(meal).then(
            (filePath) => setStatusMessage(`Meal PDF exported to ${filePath}`),
            () => setStatusMessage('Meal PDF export failed'),
          );
          return;
        }
      }

      if (input === 'P') {
        exportPlanToPdf(weeklyPlan).then(
          (filePath) => setStatusMessage(`Plan PDF exported to ${filePath}`),
          () => setStatusMessage('Plan PDF export failed'),
        );
        return;
      }
      if (input === 'g' || key.return) generatePlan(generationMode, true);
    }

    // Reset everything and return to pre-generation screen
    if (input === 'r') {
      setIsConfirmingReset(true);
    }
  });

  // Current page slice of days based on scroll and grid capacity
  const visibleDays = weeklyPlan ? weeklyPlan.slice(scrollOffset, scrollOffset + itemsPerPage) : [];

  // Builds 2D rows for rendering day cards in a responsive grid
  const gridRows = useMemo(() => {
    if (!weeklyPlan) return [] as DayPlan[][];

    const rows: DayPlan[][] = [];
    for (let r = 0; r < gridRowsPerPage; r++) {
      const row: DayPlan[] = [];
      for (let c = 0; c < gridCols; c++) {
        const idx = r * gridCols + c;
        const day = visibleDays[idx];
        if (day) row.push(day);
      }
      if (row.length > 0) rows.push(row);
    }
    return rows;
  }, [weeklyPlan, visibleDays, gridRowsPerPage, gridCols]);

  // Determine a uniform card height based on the tallest visible day card
  const uniformCardHeight = useMemo(() => {
    if (!weeklyPlan || visibleDays.length === 0) return DAY_CARD_HEIGHT;
    const needed = Math.max(...visibleDays.map((d) => estimateDayCardHeight(d)));
    return Math.min(maxCardHeight, Math.max(DAY_CARD_HEIGHT, needed));
  }, [visibleDays, weeklyPlan, maxCardHeight]);

  const generationStatusModeLabel =
    generationMode === 'stock'
      ? `STOCK-${selectedStockOption.toUpperCase()}`
      : generationMode.toUpperCase();

  return (
    <Box
      flexDirection='column'
      height={screenHeight}
      width={screenWidth}
      paddingLeft={ROOT_PAD_LEFT}
      paddingRight={ROOT_PAD_RIGHT}
    >
      {/* Navigationshinweise ganz oben */}
      {!weeklyPlan && (
        <>
          <Box height={1} marginTop={0}>
            <Text color='dim'>
              {generationMode === 'self-planned'
                ? `${t('planner.shortcuts.daysOnly', language)} | ${t(
                    'planner.hint.selfPlanned',
                    language,
                  )}`
                : generationMode === 'stock'
                  ? `${t('planner.shortcuts.daysOnly', language)} | ${t(
                      'planner.hint.generateStock',
                      language,
                    )}`
                  : `${t('planner.shortcuts.daysOnly', language)} | ${t(
                      'planner.hint.generate',
                      language,
                    )}`}
            </Text>
          </Box>
          <Box height={1} />
        </>
      )}
      {weeklyPlan && (
        <>
          <Box height={1} marginTop={0}>
            <Text color='dim'>{t('planner.shortcuts.post', language)}</Text>
          </Box>
          <Box height={1} />
        </>
      )}
      {/* Main content area */}
      <Box flexDirection='column' height={bodyHeight} minHeight={0} marginTop={TOP_GAP}>
        {!weeklyPlan ? (
          // Pre-generation UI: show plan configuration
          <Box flexDirection='column'>
            <Text>
              {t('planner.planFor', language)}{' '}
              <Text color='cyan' bold>
                {generationMode === 'self-planned' ? selfPlannedPreview.daysFromPlanned : days}{' '}
                {t('planner.days', language)}
              </Text>
            </Text>
            <Text>
              {t('planner.diet', language)}{' '}
              <Text color='green' bold>
                {generationMode === 'self-planned'
                  ? t('planner.selfPlannedLabel', language)
                  : t(`planner.dietOption.${selectedGlobalDiet}`, language)}
              </Text>
            </Text>
            <Text>
              {t('planner.habit', language)}{' '}
              <Text color='green' bold>
                {generationMode === 'self-planned'
                  ? t('planner.selfPlannedLabel', language)
                  : t(`planner.habitOption.${selectedPlanningHabit}`, language)}
              </Text>
            </Text>
            <Text>
              {t('planner.mode', language)}{' '}
              <Text color='magenta' bold>
                {generationMode === 'stock'
                  ? `STOCK-${selectedStockOption.toUpperCase()}`
                  : generationMode.toUpperCase()}
              </Text>
            </Text>
            {generationMode === 'stock' && (
              <Text>
                {t('planner.stock.optionLabel', language)}{' '}
                <Text color='green' bold>
                  {t(`planner.stock.option.${selectedStockOption}`, language)}
                </Text>
              </Text>
            )}
            {generationMode === 'self-planned' && (
              <Box flexDirection='column'>
                <Text color='dim'>{t('planner.preview.title', language)}</Text>
                <Text color='dim'>
                  {t('planner.preview.breakfast', language)} {selfPlannedPreview.breakfast}
                </Text>
                <Text color='dim'>
                  {t('planner.preview.lunch', language)} {selfPlannedPreview.lunch}
                </Text>
                <Text color='dim'>
                  {t('planner.preview.dinner', language)} {selfPlannedPreview.dinner}
                </Text>
              </Box>
            )}
            <Box height={1} />
            <Box>
              <Text color='magenta'>
                {generationMode === 'db'
                  ? t('planner.modeDescription.db', language)
                  : generationMode === 'ai'
                    ? t('planner.modeDescription.ai', language)
                    : generationMode === 'mixed'
                      ? t('planner.modeDescription.mixed', language)
                      : generationMode === 'self-planned'
                        ? t('planner.modeDescription.selfPlanned', language)
                        : generationMode === 'stock'
                          ? selectedStockOption === 'ai'
                            ? t('planner.modeDescription.stock.ai', language)
                            : t('planner.modeDescription.stock.db', language)
                          : ''}
              </Text>
            </Box>
          </Box>
        ) : (
          // Generated plan grid: render day cards with meals
          <Box flexDirection='column' flexGrow={1} minHeight={0} overflow='hidden'>
            {gridRows.map((row, r) => (
              <Box key={`row-${r}`} height={uniformCardHeight + GRID_GAP_Y}>
                {row.map((day) => (
                  <Box
                    key={day.dayNumber}
                    flexDirection='column'
                    borderStyle='single'
                    borderColor='blue'
                    paddingX={1}
                    width={DAY_CARD_WIDTH}
                    height={uniformCardHeight}
                    overflow='hidden'
                    marginRight={GRID_GAP_X}
                  >
                    {
                      // Day header
                    }
                    <Text backgroundColor='blue' color='white' bold>
                      {' '}
                      {t('planner.dayLabel', language)} {day.dayNumber}{' '}
                    </Text>

                    {
                      // Render each meal (Breakfast, ...) but limit rendered rows so the card
                      // never grows beyond `uniformCardHeight`. If content must be truncated,
                      // reserve one line at the bottom and show an ellipsis ('...').
                    }

                    {(() => {
                      const outerMealWidth = DAY_CARD_WIDTH - 4;
                      const innerWidth = Math.max(10, outerMealWidth - 2);

                      const fullHeight = estimateDayCardHeight(day);
                      const isTruncated = fullHeight > uniformCardHeight;
                      const allowedLines = isTruncated
                        ? Math.max(1, uniformCardHeight - 1)
                        : uniformCardHeight;
                      const mealLineEstimates = day.meals.map((meal) => {
                        let mealLines = 0;
                        mealLines += 1; // marginTop
                        mealLines += 2; // meal type + metadata
                        const nameLen = String(meal.name || '').length;
                        mealLines += Math.max(1, Math.ceil(nameLen / innerWidth));

                        if (meal.missing && meal.missing.length > 0) {
                          const missingLabel = t('planner.missing', language);
                          const missingText = meal.missing.join(', ');
                          const missingLen = missingLabel.length + 1 + missingText.length;
                          mealLines += Math.max(1, Math.ceil(missingLen / innerWidth));
                        }

                        return mealLines;
                      });
                      const focusedMealIndexForDay =
                        focusIndex?.day === day.dayNumber
                          ? Math.max(0, Math.min(day.meals.length - 1, focusIndex.meal))
                          : null;
                      const renderStartIndex = computeTruncatedDayRenderStart(
                        mealLineEstimates,
                        focusedMealIndexForDay,
                        allowedLines,
                        isTruncated,
                      );

                      // We already printed the day header (1 line), so start counting there.
                      let linesUsed = 1;
                      const mealNodes: any[] = [];
                      let clippedBottom = false;

                      for (let mealIdx = renderStartIndex; mealIdx < day.meals.length; mealIdx++) {
                        const meal = day.meals[mealIdx]!;

                        const mealLines = mealLineEstimates[mealIdx] || 0;

                        if (linesUsed + mealLines <= allowedLines) {
                          const isFocused =
                            focusIndex?.day === day.dayNumber && focusIndex?.meal === mealIdx;
                          const missingCovered =
                            mealMissingCoveredMap.get(`${day.dayNumber}-${mealIdx}`) ?? false;

                          mealNodes.push(
                            <Box
                              key={mealIdx}
                              flexDirection='column'
                              marginTop={1}
                              borderStyle={isFocused ? 'single' : undefined}
                              borderColor={isFocused ? 'yellow' : undefined}
                              width={outerMealWidth}
                              alignSelf={isFocused ? 'center' : undefined}
                              flexShrink={0}
                            >
                              <Box width={innerWidth}>
                                <Text color={isFocused ? 'yellow' : 'white'} bold underline>
                                  {t(`planner.meal.${meal.type}`, language)}
                                </Text>
                              </Box>

                              <Box width={innerWidth}>
                                <Text color='cyan' dimColor italic>
                                  ({renderHabitLabel(resolveMealHabitLabel(meal))})
                                  {meal.source === 'manual'
                                    ? t('planner.meta.manual', language)
                                    : meal.source === 'self-planned'
                                      ? t('planner.meta.self', language)
                                      : meal.source === 'stock'
                                        ? t('planner.meta.stock', language)
                                        : meal.source === 'db'
                                          ? t('planner.meta.db', language)
                                          : t('planner.meta.ai', language)}
                                  {meal.locked ? t('planner.meta.locked', language) : ''}
                                </Text>
                              </Box>

                              <Box width={innerWidth}>
                                <Text wrap='wrap' color={isFocused ? 'yellow' : 'white'}>
                                  {meal.name}
                                </Text>
                              </Box>

                              {meal.missing.length > 0 && (
                                <Box width={innerWidth}>
                                  {isFocused ? (
                                    <Text
                                      color={missingCovered ? 'green' : 'red'}
                                      dimColor
                                      wrap='wrap'
                                    >
                                      {t('planner.missing', language)} {meal.missing.join(', ')}
                                    </Text>
                                  ) : (
                                    <Text
                                      color={missingCovered ? 'green' : 'red'}
                                      dimColor
                                      wrap='wrap'
                                    >
                                      {t('planner.missing', language)} {meal.missing[0]}
                                      {meal.missing.length > 1 ? ' ...' : ''}
                                    </Text>
                                  )}
                                </Box>
                              )}
                            </Box>,
                          );

                          linesUsed += mealLines;
                        } else {
                          // No space for this meal, stop rendering further meals
                          clippedBottom = true;
                          break;
                        }
                      }
                      const showBottomEllipsis = shouldShowBottomTruncationEllipsis(
                        isTruncated,
                        clippedBottom,
                      );

                      return (
                        <>
                          {mealNodes}
                          {showBottomEllipsis && (
                            <Box marginTop={1}>
                              <Text color='dim'>...</Text>
                            </Box>
                          )}
                        </>
                      );
                    })()}
                  </Box>
                ))}
              </Box>
            ))}

            {
              // Pagination indicator
            }
            {weeklyPlan.length > itemsPerPage && (
              <Box marginTop={0}>
                <Text dimColor>
                  {Math.min(scrollOffset + 1, weeklyPlan.length)}-
                  {Math.min(scrollOffset + itemsPerPage, weeklyPlan.length)}/{weeklyPlan.length}
                </Text>
              </Box>
            )}
          </Box>
        )}

        {
          // Meal action selection popup
        }
        {isChoosingMealAction && (
          <Box
            borderStyle='double'
            borderColor='yellow'
            flexDirection='column'
            paddingX={1}
            flexShrink={0}
          >
            <Text bold color='yellow'>
              {t('planner.chooseAction.title', language)}
            </Text>
            {MEAL_ACTIONS.map((action, index) => (
              <Text key={action.key} color={index === mealActionIndex ? 'cyan' : 'white'}>
                {index === mealActionIndex ? ' ● ' : ' ○ '}
                {action.label} - {action.hint}
              </Text>
            ))}
            <Text color='dim'>{t('planner.hint.select_confirm_cancel', language)}</Text>
          </Box>
        )}

        {
          // Database recipe picker popup for direct slot assignment
        }
        {isChoosingDbRecipe && (
          <Box
            borderStyle='double'
            borderColor='cyan'
            flexDirection='column'
            paddingX={1}
            flexShrink={0}
          >
            <Text bold color='cyan'>
              {t('planner.dbPicker.title', language)}
            </Text>
            <Text color='dim'>
              {t('planner.dbPicker.scope', language)}{' '}
              {showAllDbRecipes
                ? t('planner.dbPicker.all', language)
                : t('planner.dbPicker.matching', language)}{' '}
              | {t('planner.dbPicker.habitLabel', language)}{' '}
              {t(`planner.habitOption.${dbHabitFilter}`, language)}
              {' | '}
              {t('planner.dbPicker.dietLabel', language)}{' '}
              {dbDietFilter === 'all'
                ? t('planner.habitOption.all', language)
                : dbDietFilter === 'standard'
                  ? t('planner.dietOption.Standard', language)
                  : dbDietFilter === 'lactose-free'
                    ? t('planner.dietOption.Lactose-Free', language)
                    : t('planner.dietOption.Gluten-Free', language)}
            </Text>
            {dbRecipeCandidates.length === 0 ? (
              <Text color='red'>{t('planner.noDbRecipes', language)}</Text>
            ) : (
              <>
                {dbRecipeWindowStart > 0 ? (
                  <Text color='dim'>{t('recipes.moreUp', language)}</Text>
                ) : null}
                {visibleDbRecipeCandidates.map((recipe, idx) => {
                  const absoluteIndex = dbRecipeWindowStart + idx;
                  const isSelected = absoluteIndex === dbRecipeChoiceIndex;

                  return (
                    <Text
                      key={`db-recipe-${recipe.id}-${absoluteIndex}`}
                      color={isSelected ? 'cyan' : 'white'}
                    >
                      {isSelected ? ' ● ' : ' ○ '}
                      {recipe.title || 'Untitled recipe'}
                    </Text>
                  );
                })}
                {dbRecipeWindowStart + DB_RECIPE_PICKER_WINDOW_SIZE < dbRecipeCandidates.length ? (
                  <Text color='dim'>{t('recipes.moreDown', language)}</Text>
                ) : null}
              </>
            )}
            <Text color='dim'>
              {t('planner.hint.dbpicker.base', language)}
              {canToggleDbRecipeScope
                ? ` | ${t('planner.hint.dbpicker.showAllMatching', language)}`
                : ''}
              {' | '}
              {t('planner.hint.habitFilter', language)}
              {' | '}
              {t('planner.hint.dietFilter', language)}
              {' | '}
              {t('planner.hint.resetFilter', language)}
              {' | '}
              {t('planner.hint.cancel', language)}
            </Text>
          </Box>
        )}

        {isChoosingAiHabit && (
          <Box
            borderStyle='double'
            borderColor='magenta'
            flexDirection='column'
            paddingX={1}
            flexShrink={0}
          >
            <Text bold color='magenta'>
              {t('planner.ai.selectHabit', language)}
            </Text>

            <Box>
              <Text color={aiPickerActiveLine === 0 ? 'cyan' : 'white'}>
                {aiPickerActiveLine === 0 ? ' ● ' : ' ○ '}
                {t('planner.habit', language)}{' '}
                <Text color='green' bold>
                  {t(
                    `planner.habitOption.${EDIT_SLOT_HABIT_FILTERS[aiHabitChoiceIndex]}`,
                    language,
                  )}
                </Text>
              </Text>
            </Box>

            <Box>
              <Text color={aiPickerActiveLine === 1 ? 'cyan' : 'white'}>
                {aiPickerActiveLine === 1 ? ' ● ' : ' ○ '}
                {t('planner.diet', language)}{' '}
                <Text color='green' bold>
                  {EDIT_SLOT_DIET_FILTERS[aiDietChoiceIndex] === 'standard'
                    ? t('planner.dietOption.Standard', language)
                    : EDIT_SLOT_DIET_FILTERS[aiDietChoiceIndex] === 'lactose-free'
                      ? t('planner.dietOption.Lactose-Free', language)
                      : t('planner.dietOption.Gluten-Free', language)}
                </Text>
              </Text>
            </Box>

            <Text color='dim'>{t('planner.hint.aiPicker', language)}</Text>
          </Box>
        )}

        {isConfirmingReset && (
          <Box
            borderStyle='double'
            borderColor='red'
            flexDirection='column'
            paddingX={1}
            flexShrink={0}
          >
            <Text bold color='red'>
              {t('planner.confirmReset.title', language)}
            </Text>
            <Text color='dim'>{t('planner.confirmReset.yesNo', language)}</Text>
          </Box>
        )}
      </Box>

      {
        // Status
      }
      {loading && (
        <Box height={1} flexShrink={0}>
          <Text color='cyan'>
            {t('planner.generating', language, { mode: generationStatusModeLabel })}
          </Text>
        </Box>
      )}

      {!loading && error && (
        <Box height={1} flexShrink={0}>
          <Text color='red'>{error}</Text>
        </Box>
      )}

      {!loading && !error && statusMessage && weeklyPlan && (
        <Box height={1} flexShrink={0}>
          <Text color='cyan'>{statusMessage}</Text>
        </Box>
      )}

      {
        // Manual meal name input popup
      }
      {isEditingMealName && (
        <Box
          borderStyle='double'
          borderColor='green'
          flexDirection='column'
          paddingX={1}
          flexShrink={0}
        >
          <Text bold color='green'>
            {t('planner.editManual.title', language)}
          </Text>
          <Text>{mealNameInput || ' '}</Text>
          <Text color='dim'>{t('planner.hint.save_manual', language)}</Text>
        </Box>
      )}

      {weeklyPlan && (
        <Box flexDirection='column' flexShrink={0}>
          <Box height={1} marginTop={1}>
            <Text color='yellow' dimColor>
              {t('planner.addToShoppingListHint', language)}
            </Text>
          </Box>
          <Box height={1} />
          <Box height={1}>
            <Text color='dim'>{t('planner.legend.label', language)} </Text>
            <Text color='red' dimColor>
              {t('planner.legend.missingNotCovered', language)}
            </Text>
            <Text color='dim'> | </Text>
            <Text color='green' dimColor>
              {t('planner.legend.missingCovered', language)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
