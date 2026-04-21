import type { RecipeAggregate } from '../db/recipesRepo';

// Share recipe view types and defaults across the recipes screen
export type FocusPane = 'recipes' | 'planned';

export type RecipesViewProps = {
  onNavigationLockChange?: (locked: boolean) => void;
  onActiveRecipeTitleChange?: (title: string | null) => void;
  viewportRows?: number;
  language?: string;
};

export type ViewRecipe = {
  id: number;
  name: string;
  servings: number;
  duration: number;
  difficulty: string;
  habits: string[];
  diets: string[];
  categories: string[];
  ingredients: { amount: number; unit: string; name: string }[];
  steps: string[];
};

// Default values for recipe filter

export const defaultFilterOption = 'all';
export const defaultHabit = defaultFilterOption;
export const defaultDifficulty = defaultFilterOption;
export const favoriteCategory = 'favorite';

// Enumerated values for selectable create-form fields
export const recipeDifficultyOptions = ['easy', 'medium', 'hard', 'unknown'] as const;

// Keep create-form options centralized so extending values is a one-line change
export const recipeHabitOptions = ['all', 'vegetarian', 'vegan'] as const;
export const recipeCategoryOptions = [
  'all',
  'breakfast',
  'lunch',
  'dinner',
  'salad',
  'dessert',
] as const;
// Diet options mirror Planner.tsx (lowercase canonical values)
export const recipeDietOptions = ['standard', 'lactose-free', 'gluten-free'] as const;
export const recipeIngredientUnitOptions = ['g', 'ml', 'pcs', 'tbsp', 'tsp', 'pinch'] as const;

export type AddRecipeEditorMode = 'form' | 'ingredients' | 'steps';
export type IngredientDraftField = 'amount' | 'unit' | 'name';

export type IngredientDraft = {
  amount: string;
  unit: string;
  name: string;
};

export type NewRecipeFormField =
  | 'title'
  | 'servings'
  | 'duration'
  | 'difficulty'
  | 'habits'
  | 'categories'
  | 'ingredients'
  | 'steps'
  | 'save';

export type NewRecipeForm = {
  title: string;
  servings: string;
  duration: string;
  difficulty: string;
  habits: string;
  categories: string;
};

export const newRecipeFieldLabels: Record<NewRecipeFormField, string> = {
  title: 'Title',
  servings: 'Servings',
  duration: 'Duration (minutes)',
  difficulty: 'Difficulty',
  habits: 'Habits',
  categories: 'Categories',
  ingredients: 'Ingredients',
  steps: 'Preparation steps',
  save: 'Save',
};

export const newRecipeFields: NewRecipeFormField[] = [
  'title',
  'servings',
  'duration',
  'difficulty',
  'habits',
  'categories',
  'ingredients',
  'steps',
  'save',
];

// Defaults align with list-filter defaults so a new recipe is visible immediately
export const createDefaultNewRecipeForm = (): NewRecipeForm => ({
  title: '',
  servings: '1',
  duration: '',
  difficulty: 'unknown',
  habits: recipeHabitOptions[0],
  categories: recipeCategoryOptions[0],
});

export const createEmptyIngredientDraft = (): IngredientDraft => ({
  amount: '',
  unit: recipeIngredientUnitOptions[0],
  name: '',
});

export type PlannedRecipeEntry = {
  id: number;
  // Servings stored per planner entry independent from recipe detail view
  servings: number;
};

export type PlannedRecipeView = {
  id: number;
  servings: number;
  recipe: ViewRecipe;
};

export const toViewRecipe = (recipe: RecipeAggregate): ViewRecipe => ({
  id: recipe.id,
  name: recipe.title,
  servings: recipe.servings ?? 0,
  duration: recipe.duration ?? 0,
  difficulty: recipe.difficulty ?? 'unknown',
  // Use DB tags and keep "all" as a safe fallback
  habits: recipe.habits.length > 0 ? recipe.habits : [defaultHabit],
  // Use DB diets and keep "standard" as a safe fallback
  diets: recipe.diets.length > 0 ? recipe.diets : ['standard'],
  categories: recipe.categories.length > 0 ? recipe.categories : [defaultFilterOption],
  ingredients: recipe.ingredients,
  steps: recipe.steps,
});
