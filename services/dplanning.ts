import type { RecipeAggregate } from '../db/recipesRepo';
import { convertAmount } from './unitConversion';

export type InventoryPlanningItem = {
  name: string;
  quantity: number;
  unit: string;
};

export type MissingIngredient = {
  name: string;
  required: number;
  available: number;
  missing: number;
  unit: string;
};

export type RecipeSuggestion = {
  recipeId: number;
  recipeName: string;
  possibleServings: number;
  baseServings: number;
  limitingIngredient: string;
  missingIngredients: MissingIngredient[];
  cookableNow: boolean;
};

export type LowStockItem = {
  name: string;
  quantity: number;
  unit: string;
};

const normalizeKey = (value: string): string => value.trim().toLowerCase();

export const buildRecipeSuggestions = (
  inventoryItems: InventoryPlanningItem[],
  recipes: RecipeAggregate[],
): RecipeSuggestion[] => {
  const inventoryMap = new Map<string, InventoryPlanningItem>();

  for (const item of inventoryItems) {
    inventoryMap.set(normalizeKey(item.name), item);
  }

  return recipes.map((recipe) => {
    const baseServings = recipe.servings && recipe.servings > 0 ? recipe.servings : 1;

    let possibleRecipeRuns = Number.POSITIVE_INFINITY;
    let limitingIngredient = '';
    const missingIngredients: MissingIngredient[] = [];

    for (const ingredient of recipe.ingredients) {
      const stock = inventoryMap.get(normalizeKey(ingredient.name));
      const available = stock?.quantity ?? 0;
      const stockUnit = stock?.unit ?? ingredient.unit;
      const availableConverted = convertAmount(available, stockUnit, ingredient.unit);

      if (availableConverted === null) {
        possibleRecipeRuns = 0;

        missingIngredients.push({
          name: ingredient.name,
          required: ingredient.amount,
          available,
          missing: Math.max(ingredient.amount - available, ingredient.amount),
          unit: ingredient.unit,
        });

        if (!limitingIngredient) {
          limitingIngredient = ingredient.name;
        }

        continue;
      }

      const required = ingredient.amount;
      const runsForIngredient = required > 0 ? Math.floor(availableConverted / required) : 0;

      if (runsForIngredient < possibleRecipeRuns) {
        possibleRecipeRuns = runsForIngredient;
        limitingIngredient = ingredient.name;
      }

      if (availableConverted < required) {
        missingIngredients.push({
          name: ingredient.name,
          required,
          available: availableConverted,
          missing: required - availableConverted,
          unit: ingredient.unit,
        });
      }
    }

    if (!Number.isFinite(possibleRecipeRuns)) {
      possibleRecipeRuns = 0;
    }

    return {
      recipeId: recipe.id,
      recipeName: recipe.title,
      possibleServings: possibleRecipeRuns * baseServings,
      baseServings,
      limitingIngredient,
      missingIngredients,
      cookableNow: missingIngredients.length === 0 && possibleRecipeRuns > 0,
    };
  });
};

export const getLowStockItems = (
  inventoryItems: InventoryPlanningItem[],
  threshold = 2,
): LowStockItem[] => {
  return inventoryItems
    .filter((item) => item.quantity <= threshold)
    .sort((a, b) => a.quantity - b.quantity)
    .map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
    }));
};
