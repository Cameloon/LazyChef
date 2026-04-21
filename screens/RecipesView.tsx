import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Text, Box, useInput, useStdout } from 'ink';
import { createWriteStream, writeFileSync } from 'fs';
import { join } from 'path';
import {
  createRecipe,
  deleteRecipeById,
  getAllRecipes,
  syncRecipeDietsFromIngredients,
  updateRecipeCategoriesById,
} from '../db/recipesRepo';
import { db } from '../db/db';
import { inventory } from '../db/schema';
import {
  getAllShoppingLists,
  getShoppingListById,
  createShoppingList,
  addItemToList,
  updateListItem,
  type ShoppingListItemInput,
  type ShoppingListItemRow,
} from '../db/shoppingListsRepo';
import { getOrCreateAppSettings } from '../db/settingsRepo';
import { getAllergenInfo, hasAllergenConflict } from '../db/allergenRepo';
import { getPlannedRecipeEntries, replacePlannedRecipeEntries } from '../db/plannedRecipesRepo';
import { RecipeSearchPanel } from '../components/Recipes/SearchPanel';
import { applyRecipeFilters, getNextCycledFilterValue } from './recipesViewFilters';
import {
  computeAggregateMissingWithShoppingList,
  computeMissingForIngredients,
  formatAmount,
  isIngredientMissing as isIngredientMissingInInventory,
  isMissingCoveredByShoppingList,
  type MissingItem,
} from '../services/ingredientCoverage';
import {
  defaultDifficulty,
  defaultFilterOption,
  defaultHabit,
  favoriteCategory,
  newRecipeFields,
  newRecipeFieldLabels,
  recipeCategoryOptions,
  recipeDifficultyOptions,
  recipeHabitOptions,
  recipeDietOptions,
  recipeIngredientUnitOptions,
  createDefaultNewRecipeForm,
  createEmptyIngredientDraft,
  toViewRecipe,
  type AddRecipeEditorMode,
  type FocusPane,
  type IngredientDraft,
  type IngredientDraftField,
  type NewRecipeForm,
  type NewRecipeFormField,
  type PlannedRecipeEntry,
  type PlannedRecipeView,
  type RecipesViewProps,
  type ViewRecipe,
} from './recipesViewModel';

import { t } from '../services/i18n';

// Recipes view component for listing and managing recipes
// show missing ingredients compared to the current inventory
// allow adding missing ingredients to a shopping list
export const RecipesView: React.FC<RecipesViewProps> = ({
  onNavigationLockChange,
  onActiveRecipeTitleChange,
  viewportRows,
  language = 'en',
}) => {
  // Keep list data, detail state, and planner state isolated so mode switches stay explicit
  // all recipes shown on the screen
  const [recipeList, setRecipeList] = useState<ViewRecipe[]>([]);
  // null = recipe list is shown / number = recipe detail is shown
  const [activeRecipeId, setActiveRecipeId] = useState<number | null>(null);
  // ID and number of servings for planned recipes
  const [plannedRecipesState, setPlannedRecipesState] = useState<PlannedRecipeEntry[]>([]);
  // active row in filtered recipes
  const [selectedRecipeIndex, setSelectedRecipeIndex] = useState(0);
  // start index of visible window
  const [scrollOffset, setScrollOffset] = useState(0);
  // inventory snapshot from DB
  type InventoryRow = typeof inventory.$inferSelect;
  const [dbInventory, setDbInventory] = useState<InventoryRow[]>([]);
  // today's shopping list items for displaying "(x on list)"
  const [todayListItems, setTodayListItems] = useState<ShoppingListItemRow[]>([]);
  // number of rows fitting in terminal
  const [maxVisibleRecipes, setMaxVisibleRecipes] = useState(8);
  // active area -> left recipe list / right planner
  const [focusPane, setFocusPane] = useState<FocusPane>('recipes');
  // recipe list search by title
  const [searchQuery, setSearchQuery] = useState('');
  // search mode is active
  const [isSearching, setIsSearching] = useState(false);
  // value shown in search panel
  const [visualSearchValue, setVisualSearchValue] = useState('');
  // active filters in recipe list
  const [selectedDifficulty, setSelectedDifficulty] = useState(defaultDifficulty);
  const [selectedHabit, setSelectedHabit] = useState(defaultHabit);
  const [selectedCategory, setSelectedCategory] = useState(defaultFilterOption);
  const [selectedDiet, setSelectedDiet] = useState<string>(recipeDietOptions[0]);
  const [defaultHabitFilter, setDefaultHabitFilter] = useState(defaultHabit);
  const [defaultDietFilter, setDefaultDietFilter] = useState<string>(recipeDietOptions[0]);
  const [defaultRecipeServings, setDefaultRecipeServings] = useState(1);
  // overlay if "New recipe" is open
  const [isAddingRecipe, setIsAddingRecipe] = useState(false);
  // active part of recipe editor mode (form/ingredients/steps)
  const [addRecipeEditorMode, setAddRecipeEditorMode] = useState<AddRecipeEditorMode>('form');
  // recipe editor form for title, servings, duartion
  const [newRecipeForm, setNewRecipeForm] = useState<NewRecipeForm>(createDefaultNewRecipeForm());
  // active recipe editor form
  const [newRecipeFieldIndex, setNewRecipeFieldIndex] = useState(0);
  // temporary rows for ingredients
  const [ingredientDrafts, setIngredientDrafts] = useState<IngredientDraft[]>([
    createEmptyIngredientDraft(),
  ]);
  // active ingredient row
  const [selectedIngredientDraftIndex, setSelectedIngredientDraftIndex] = useState(0);
  // active column ingredient editor (amount/unit/name)
  const [selectedIngredientDraftField, setSelectedIngredientDraftField] =
    useState<IngredientDraftField>('amount');
  // temporary strings for preparation steps
  const [stepDrafts, setStepDrafts] = useState<string[]>(['']);
  // active row preparation-step editor
  const [selectedStepDraftIndex, setSelectedStepDraftIndex] = useState(0);
  // validation error in overlay (empty title, ...)
  const [addRecipeError, setAddRecipeError] = useState<string | null>(null);
  // delete dialog
  const [pendingDeleteRecipe, setPendingDeleteRecipe] = useState<ViewRecipe | null>(null);
  // number of servings in detail view of recipe
  const [detailServings, setDetailServings] = useState(1);
  // marks selection in planner
  const [selectedPlannedIndex, setSelectedPlannedIndex] = useState(0);
  const [plannedScrollOffset, setPlannedScrollOffset] = useState(0);
  const [userIntolerances, setUserIntolerances] = useState('none');
  // allergen warnings for recipes: recipeId -> warning string like "(l)" or "(g)" or "(l, g)"
  const [recipeAllergenWarnings, setRecipeAllergenWarnings] = useState<Map<number, string>>(
    new Map(),
  );
  const [detailIngredientWarnings, setDetailIngredientWarnings] = useState<Map<string, string>>(
    new Map(),
  );
  // Hold transient search input outside React state so key handling stays simple while typing
  const searchBuffer = useRef('');
  // Guard DB writes until initial planned state has been loaded
  const plannedStateHydratedRef = useRef(false);
  const { stdout } = useStdout();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const exportRecipeToMarkdown = (recipe: ViewRecipe, servings: number): string => {
    const lines: string[] = [];
    lines.push(`# ${recipe.name}`);
    lines.push('');
    lines.push(`Servings: ${servings}`);
    if (recipe.duration) lines.push(`Duration: ${recipe.duration} minutes`);
    lines.push(`Difficulty: ${recipe.difficulty}`);
    if (recipe.habits && recipe.habits.length) lines.push(`Habits: ${recipe.habits.join(', ')}`);
    if (recipe.categories && recipe.categories.length)
      lines.push(`Categories: ${recipe.categories.join(', ')}`);
    lines.push('');
    lines.push('## Ingredients');
    lines.push('');
    const baseServings = recipe.servings > 0 ? recipe.servings : 1;
    const factor = servings / baseServings;
    for (const ing of recipe.ingredients) {
      const unitLower = String(ing.unit || '').toLowerCase();
      const raw = ing.amount * factor;
      let scaledAmount: number | string;
      if (unitLower === 'g' || unitLower === 'ml') {
        if (raw >= 25) {
          scaledAmount = Math.round(raw / 25) * 25;
        } else {
          scaledAmount = Math.round(raw + Number.EPSILON);
        }
      } else {
        scaledAmount = Math.round((raw + Number.EPSILON) * 100) / 100;
      }
      lines.push(`- ${scaledAmount} ${ing.unit} ${ing.name}`);
    }
    lines.push('');
    if (recipe.steps && recipe.steps.length) {
      lines.push('## Preparation');
      lines.push('');
      recipe.steps.forEach((step, idx) => {
        lines.push(`${idx + 1}. ${step}`);
      });
    }

    const filePath = join(process.cwd(), `${recipe.name.replace(/[/\\?%*:|"<>]/g, '_')}.md`);
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  };

  const exportRecipeToPdf = async (recipe: ViewRecipe, servings: number): Promise<string> => {
    const { default: PDFDocument } = await import('pdfkit');
    return new Promise((resolve, reject) => {
      const filePath = join(process.cwd(), `${recipe.name.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`);
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const stream = createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(20).text(recipe.name, { underline: true });
      doc.moveDown();
      doc.fontSize(12).text(`Servings: ${servings}`);
      if (recipe.duration) doc.text(`Duration: ${recipe.duration} minutes`);
      doc.text(`Difficulty: ${recipe.difficulty}`);
      if (recipe.habits && recipe.habits.length) doc.text(`Habits: ${recipe.habits.join(', ')}`);
      if (recipe.categories && recipe.categories.length)
        doc.text(`Categories: ${recipe.categories.join(', ')}`);
      doc.moveDown();

      doc.fontSize(14).text('Ingredients', { underline: true });
      doc.moveDown(0.5);
      const baseServingsPdf = recipe.servings > 0 ? recipe.servings : 1;
      const factorPdf = servings / baseServingsPdf;
      for (const ing of recipe.ingredients) {
        const unitLower = String(ing.unit || '').toLowerCase();
        const raw = ing.amount * factorPdf;
        let scaledAmount: number | string;
        if (unitLower === 'g' || unitLower === 'ml') {
          if (raw >= 25) scaledAmount = Math.round(raw / 25) * 25;
          else scaledAmount = Math.round(raw + Number.EPSILON);
        } else {
          scaledAmount = Math.round((raw + Number.EPSILON) * 100) / 100;
        }
        doc.fontSize(12).text(`- ${scaledAmount} ${ing.unit} ${ing.name}`);
      }

      if (recipe.steps && recipe.steps.length) {
        doc.moveDown();
        doc.fontSize(14).text('Preparation', { underline: true });
        doc.moveDown(0.5);
        recipe.steps.forEach((step, idx) => {
          doc.fontSize(12).text(`${idx + 1}. ${step}`);
          doc.moveDown(0.3);
        });
      }

      doc.end();
      stream.on('finish', () => resolve(filePath));
      stream.on('error', reject);
    });
  };

  // Check allergens in all recipes
  useEffect(() => {
    const checkAllergensInRecipes = async () => {
      if (userIntolerances === 'none') {
        setRecipeAllergenWarnings(new Map());
        return;
      }

      const warnings = new Map<number, string>();

      for (const recipe of recipeList) {
        let lactoseConflict = false;
        let glutenConflict = false;

        for (const ingredient of recipe.ingredients || []) {
          const allergenInfo = await getAllergenInfo(ingredient.name);
          if (userIntolerances.includes('lactose') && allergenInfo.hasLactose)
            lactoseConflict = true;
          if (userIntolerances.includes('gluten') && allergenInfo.hasGluten) glutenConflict = true;
          if (lactoseConflict && glutenConflict) break;
        }

        if (lactoseConflict || glutenConflict) {
          const parts: string[] = [];
          if (lactoseConflict) parts.push('l');
          if (glutenConflict) parts.push('g');
          warnings.set(recipe.id, `(${parts.join(', ')})`);
        }
      }

      setRecipeAllergenWarnings(warnings);
    };

    void checkAllergensInRecipes();
  }, [recipeList, userIntolerances]);

  // Mirror terminal size in state so horizontal-only resize events trigger re-render.
  const [terminalColumns, setTerminalColumns] = useState(stdout?.columns ?? 80);
  const [terminalRows, setTerminalRows] = useState(stdout?.rows ?? 24);

  const screenWidth = Math.max(50, Math.floor(terminalColumns * 0.8));
  const screenHeight = Math.max(14, Math.floor((viewportRows ?? terminalRows) * 0.7));
  // Keep sub-editors bounded so long lists do not overflow the terminal viewport.
  const editorVisibleRows = Math.max(3, Math.min(8, screenHeight - 22));

  // useMemo states are calculated from primary states (not saved)

  const ingredientEditorOffset = useMemo(() => {
    if (ingredientDrafts.length <= editorVisibleRows) return 0;
    const centered = selectedIngredientDraftIndex - Math.floor(editorVisibleRows / 2);
    const maxOffset = Math.max(0, ingredientDrafts.length - editorVisibleRows);
    return Math.max(0, Math.min(maxOffset, centered));
  }, [ingredientDrafts.length, selectedIngredientDraftIndex, editorVisibleRows]);

  const visibleIngredientDrafts = useMemo(
    () =>
      ingredientDrafts.slice(ingredientEditorOffset, ingredientEditorOffset + editorVisibleRows),
    [ingredientDrafts, ingredientEditorOffset, editorVisibleRows],
  );

  const stepEditorOffset = useMemo(() => {
    if (stepDrafts.length <= editorVisibleRows) return 0;
    const centered = selectedStepDraftIndex - Math.floor(editorVisibleRows / 2);
    const maxOffset = Math.max(0, stepDrafts.length - editorVisibleRows);
    return Math.max(0, Math.min(maxOffset, centered));
  }, [stepDrafts.length, selectedStepDraftIndex, editorVisibleRows]);

  const visibleStepDrafts = useMemo(
    () => stepDrafts.slice(stepEditorOffset, stepEditorOffset + editorVisibleRows),
    [stepDrafts, stepEditorOffset, editorVisibleRows],
  );
  // calculated value for
  const activeRecipe = useMemo(
    () => recipeList.find((r) => r.id === activeRecipeId) ?? null,
    [activeRecipeId, recipeList],
  );

  useEffect(() => {
    const checkAllergensInActiveRecipe = async () => {
      if (!activeRecipe || userIntolerances === 'none') {
        setDetailIngredientWarnings(new Map());
        return;
      }

      const warnings = new Map<string, string>();

      for (const ingredient of activeRecipe.ingredients || []) {
        const normalizedName = String(ingredient.name || '')
          .trim()
          .toLowerCase();
        if (!normalizedName) continue;

        const allergenInfo = await getAllergenInfo(ingredient.name);
        const conflicts = hasAllergenConflict(allergenInfo, userIntolerances);
        if (!conflicts) continue;

        const lactoseConflict = userIntolerances.includes('lactose') && allergenInfo.hasLactose;
        const glutenConflict = userIntolerances.includes('gluten') && allergenInfo.hasGluten;

        if (lactoseConflict && glutenConflict) {
          warnings.set(normalizedName, '(l, g)');
        } else if (lactoseConflict) {
          warnings.set(normalizedName, '(l)');
        } else if (glutenConflict) {
          warnings.set(normalizedName, '(g)');
        }
      }

      setDetailIngredientWarnings(warnings);
    };

    void checkAllergensInActiveRecipe();
  }, [activeRecipe, userIntolerances]);

  useEffect(() => {
    // Reset servings to the recipe default whenever a new recipe is opened
    if (!activeRecipe) return;
    const initialServings = Math.max(1, defaultRecipeServings);
    setDetailServings(initialServings);
  }, [activeRecipe, defaultRecipeServings]);

  useEffect(() => {
    // Load recipes and inventory from the repository once when the screen mounts
    syncRecipeDietsFromIngredients();
    const rows = getAllRecipes().map(toViewRecipe);
    setRecipeList(rows);

    try {
      // Restore planned recipes so Planner can reuse this selection
      const plannedEntries = getPlannedRecipeEntries();
      setPlannedRecipesState(
        plannedEntries.map((entry) => ({
          id: entry.recipeId,
          servings: entry.servings,
        })),
      );
    } catch {
      setPlannedRecipesState([]);
    } finally {
      plannedStateHydratedRef.current = true;
    }

    try {
      const settings = getOrCreateAppSettings();
      const configuredServings = Math.max(1, Number(settings.defaultServings || 1));
      const configuredHabit = ['all', 'vegetarian', 'vegan'].includes(settings.eatingHabit)
        ? settings.eatingHabit
        : defaultHabit;
      const configuredIntolerances =
        settings.intolerances === 'lactose' ||
        settings.intolerances === 'gluten' ||
        settings.intolerances === 'lactose+gluten'
          ? settings.intolerances
          : settings.intolerances === 'both'
            ? 'lactose+gluten'
            : 'none';

      setDefaultRecipeServings(configuredServings);
      setDefaultHabitFilter(configuredHabit);
      setSelectedHabit(configuredHabit);
      setUserIntolerances(configuredIntolerances);

      // Derive an initial diet filter from configured intolerances so the recipes
      // list defaults to a safe selection for the user. Prefer lactose when both
      // are present since the filter is single-select.
      const configuredDiet = configuredIntolerances.includes('lactose')
        ? 'lactose-free'
        : configuredIntolerances.includes('gluten')
          ? 'gluten-free'
          : recipeDietOptions[0];
      setDefaultDietFilter(configuredDiet);
      setSelectedDiet(configuredDiet);
    } catch {
      setDefaultRecipeServings(1);
      setDefaultHabitFilter(defaultHabit);
      setSelectedHabit(defaultHabit);
      setUserIntolerances('none');
      setDefaultDietFilter(recipeDietOptions[0]);
      setSelectedDiet(recipeDietOptions[0]);
    }

    try {
      const inv = db
        .select({ name: inventory.name, quantity: inventory.quantity, unit: inventory.unit })
        .from(inventory)
        .all() as InventoryRow[];
      setDbInventory(inv);
    } catch {
      setDbInventory([]);
    }

    // load today's shopping list items so UI can show "(x on list)"
    try {
      const lists = getAllShoppingLists();
      const todayPrefix = new Date().toISOString().slice(0, 10);
      const todayList = lists
        .filter(
          (l) =>
            (l.createdAt ?? '').startsWith(todayPrefix) &&
            String(l.name || '')
              .toLowerCase()
              .startsWith('recipes planner '),
        )
        .sort((a, b) => b.id - a.id)[0];
      if (todayList) {
        const agg = getShoppingListById(todayList.id);
        setTodayListItems(agg?.items ?? []);
      } else {
        setTodayListItems([]);
      }
    } catch {
      setTodayListItems([]);
    }
  }, []);

  useEffect(() => {
    if (!plannedStateHydratedRef.current) return;

    try {
      // Persist every planner edit for cross-screen usage
      replacePlannedRecipeEntries(
        plannedRecipesState.map((entry) => ({
          recipeId: entry.id,
          servings: entry.servings,
        })),
      );
    } catch {
      // Keep the in-memory planner usable even if persistence fails.
    }
  }, [plannedRecipesState]);

  useEffect(() => {
    // Prevent parent menu hotkeys (including number keys) during recipe interactions.
    const shouldLockNavigation =
      Boolean(activeRecipeId) || isAddingRecipe || pendingDeleteRecipe !== null || isSearching;
    onNavigationLockChange?.(shouldLockNavigation);
    return () => onNavigationLockChange?.(false);
  }, [activeRecipeId, isAddingRecipe, pendingDeleteRecipe, isSearching, onNavigationLockChange]);

  useEffect(() => {
    // hands the title of the shown recipe towards the index to be shown in the main menu
    onActiveRecipeTitleChange?.(activeRecipe?.name ?? null);
    return () => onActiveRecipeTitleChange?.(null);
  }, [activeRecipe, onActiveRecipeTitleChange]);

  useEffect(() => {
    const updateVisibleRows = () => {
      const availableRows = viewportRows ?? stdout?.rows ?? 24;
      const availableColumns = stdout?.columns ?? 80;

      setTerminalRows(availableRows);
      setTerminalColumns(availableColumns);

      // Reserve vertical space for header, filters, hints, and list padding before paging rows
      const reservedRows = 9;
      const listRows = availableRows - reservedRows;
      setMaxVisibleRecipes(Math.max(1, listRows));
    };

    updateVisibleRows();
    stdout?.on('resize', updateVisibleRows);
    return () => {
      stdout?.off('resize', updateVisibleRows);
    };
  }, [stdout, viewportRows]);

  const difficultyOptions = useMemo(() => {
    // Build options from current recipe data and keep "all" at the top
    const options = new Set<string>([defaultFilterOption]);
    for (const recipe of recipeList) {
      const normalizedDifficulty = recipe.difficulty?.trim().toLowerCase() || 'unknown';
      options.add(normalizedDifficulty);
    }
    return Array.from(options);
  }, [recipeList]);

  const dietOptions = useMemo(() => {
    // Use fixed diet options that mirror Planner.tsx for consistent UX
    return Array.from(recipeDietOptions as readonly string[]);
  }, [recipeList]);

  const habitOptions = useMemo(() => {
    // Keep default habits stable while still supporting new tags from data
    const options = new Set<string>([defaultHabit, 'vegetarian', 'vegan']);
    for (const recipe of recipeList) {
      for (const habit of recipe.habits) {
        options.add(habit.trim().toLowerCase());
      }
    }
    return Array.from(options);
  }, [recipeList]);

  const categoryOptions = useMemo(() => {
    // Derive category filter values from loaded recipes
    const options = new Set<string>([defaultFilterOption]);
    for (const recipe of recipeList) {
      for (const category of recipe.categories) {
        options.add(category.trim().toLowerCase());
      }
    }
    return Array.from(options);
  }, [recipeList]);

  const cycleFilter = (
    options: string[],
    currentValue: string,
    setValue: React.Dispatch<React.SetStateAction<string>>,
  ) => {
    const nextValue = getNextCycledFilterValue(options, currentValue);
    if (!nextValue) return;
    setValue(nextValue);
    setSelectedRecipeIndex(0);
    setScrollOffset(0);
  };

  const resetAllFilters = () => {
    // Reset all list filters to default values and jump to the first row
    setSelectedDifficulty(defaultDifficulty);
    setSelectedHabit(defaultHabitFilter);
    setSelectedCategory(defaultFilterOption);
    setSelectedDiet(defaultDietFilter);
    setSelectedRecipeIndex(0);
    setScrollOffset(0);
  };

  const clearSearch = () => {
    // Keep search reset in one place so add/delete flows stay consistent
    searchBuffer.current = '';
    setVisualSearchValue('');
    setSearchQuery('');
  };

  // Rebuild visible recipe rows from the repository after every write operation
  const reloadRecipes = () => getAllRecipes().map(toViewRecipe);

  const resetNewRecipeForm = () => {
    // Reuse the same initial state for open/cancel/success to avoid drift.
    setNewRecipeForm(createDefaultNewRecipeForm());
    setNewRecipeFieldIndex(0);
    setAddRecipeEditorMode('form');
    setIngredientDrafts([createEmptyIngredientDraft()]);
    setSelectedIngredientDraftIndex(0);
    setSelectedIngredientDraftField('amount');
    setStepDrafts(['']);
    setSelectedStepDraftIndex(0);
    setAddRecipeError(null);
  };

  const parseIngredientDrafts = (): {
    items: { amount: number; unit: string; name: string }[];
    error: string | null;
  } => {
    // Ignore untouched placeholder rows so the editor can always keep one empty line ready
    const nonEmptyDrafts = ingredientDrafts.filter(
      (draft) =>
        draft.amount.trim().length > 0 ||
        draft.name.trim().length > 0 ||
        draft.unit.trim().length > 0,
    );

    const items: { amount: number; unit: string; name: string }[] = [];
    for (const [index, draft] of nonEmptyDrafts.entries()) {
      const amountRaw = draft.amount.trim().replace(',', '.');
      const unit = draft.unit.trim();
      const name = draft.name.trim();

      if (!amountRaw || !unit || !name) {
        return {
          items: [],
          error: `Ingredient ${index + 1} is incomplete.`,
        };
      }

      const amount = Number.parseFloat(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) {
        return {
          items: [],
          error: `Ingredient ${index + 1} must have an amount > 0.`,
        };
      }

      items.push({ amount, unit, name });
    }

    return { items, error: null };
  };

  const parseStepDrafts = (): string[] =>
    stepDrafts.map((step) => step.trim()).filter((step) => step.length > 0);

  const ingredientCount = useMemo(
    () =>
      ingredientDrafts.filter(
        (draft) => draft.amount.trim().length > 0 || draft.name.trim().length > 0,
      ).length,
    [ingredientDrafts],
  );

  const stepCount = useMemo(
    () => stepDrafts.filter((step) => step.trim().length > 0).length,
    [stepDrafts],
  );

  const getNewRecipeFieldValue = (field: NewRecipeFormField): string => {
    if (field === 'ingredients') {
      return t('recipes.editor.ingredients.summary', language).replace(
        '{count}',
        String(ingredientCount),
      );
    }

    if (field === 'steps') {
      return t('recipes.editor.steps.summary', language).replace('{count}', String(stepCount));
    }

    if (field === 'save') {
      return t('recipes.create.pressEnter', language);
    }

    return newRecipeForm[field];
  };

  const toggleFavoriteCategory = (recipeId: number) => {
    // Toggle favorite category and persist it for filtering
    setRecipeList((prev) =>
      prev.map((recipe) => {
        if (recipe.id !== recipeId) return recipe;

        const isFavorite = recipe.categories.includes(favoriteCategory);
        const nextCategories = isFavorite
          ? recipe.categories.filter((category) => category !== favoriteCategory)
          : [...recipe.categories, favoriteCategory];

        updateRecipeCategoriesById(recipeId, nextCategories);

        return {
          ...recipe,
          categories: nextCategories,
        };
      }),
    );
  };

  const filteredRecipes = useMemo(() => {
    // Keep filtering logic in a pure helper so tests can cover behavior without UI setup
    return applyRecipeFilters(recipeList, {
      searchQuery,
      selectedDifficulty,
      selectedHabit,
      selectedDiet,
      selectedCategory,
      allOption: defaultFilterOption,
    });
  }, [searchQuery, recipeList, selectedDifficulty, selectedHabit, selectedCategory, selectedDiet]);

  const pageSize = maxVisibleRecipes;

  useEffect(() => {
    // Keep selected recipe row inside the visible list window
    if (selectedRecipeIndex < scrollOffset) {
      setScrollOffset(selectedRecipeIndex);
      return;
    }

    const windowEnd = scrollOffset + pageSize;
    if (selectedRecipeIndex >= windowEnd) {
      const nextOffset = selectedRecipeIndex - pageSize + 1;
      setScrollOffset(Math.max(0, nextOffset));
    }
  }, [selectedRecipeIndex, scrollOffset, pageSize]);

  useEffect(() => {
    // Clamp selection and scroll when filter results change
    if (selectedRecipeIndex >= filteredRecipes.length && filteredRecipes.length > 0) {
      // Keep selection anchored to the last valid row after narrowing the result set
      setSelectedRecipeIndex(filteredRecipes.length - 1);
    }

    if (filteredRecipes.length === 0) {
      setSelectedRecipeIndex(0);
      setScrollOffset(0);
      return;
    }

    const maxOffset = Math.max(0, filteredRecipes.length - pageSize);
    if (scrollOffset > maxOffset) {
      setScrollOffset(maxOffset);
    }
  }, [filteredRecipes.length, pageSize, scrollOffset, selectedRecipeIndex]);

  const visibleRecipes = useMemo(
    // Render only the current list page for stable terminal performance
    () => filteredRecipes.slice(scrollOffset, scrollOffset + pageSize),
    [filteredRecipes, scrollOffset, pageSize],
  );

  const plannedRecipes = useMemo(
    // Resolve planner entries into recipe objects while keeping order and custom servings
    () =>
      plannedRecipesState
        .map((entry) => {
          const recipe = recipeList.find((r) => r.id === entry.id);
          if (!recipe) return null;

          return {
            id: entry.id,
            servings: entry.servings,
            recipe,
          };
        })
        .filter((entry): entry is PlannedRecipeView => entry !== null),
    [plannedRecipesState, recipeList],
  );

  const plannedVisibleCount = useMemo(
    () => Math.max(1, maxVisibleRecipes - 1),
    [maxVisibleRecipes],
  );

  const plannedServingsByRecipeId = useMemo(() => {
    // Keep the latest servings per recipe id so list calculations match planner edits.
    const servingsMap = new Map<number, number>();
    for (const entry of plannedRecipesState) {
      if (entry.servings > 0) {
        servingsMap.set(entry.id, entry.servings);
      }
    }
    return servingsMap;
  }, [plannedRecipesState]);

  const visiblePlannedRecipes = useMemo(
    // Slice planner entries to the visible planner window
    () => plannedRecipes.slice(plannedScrollOffset, plannedScrollOffset + plannedVisibleCount),
    [plannedRecipes, plannedScrollOffset, plannedVisibleCount],
  );

  const addRecipeToPlanner = (recipeId: number) => {
    // New planner entries start with the configured servings default
    const defaultServings = Math.max(1, defaultRecipeServings);

    setPlannedRecipesState((prev) => [...prev, { id: recipeId, servings: defaultServings }]);
  };

  const toggleRecipeInPlanner = (recipeId: number, servingsOverride?: number) => {
    // Toggle by recipe id and preserve custom servings on existing rows
    const defaultServings = Math.max(1, defaultRecipeServings);
    const initialServings =
      servingsOverride && servingsOverride > 0 ? servingsOverride : defaultServings;

    setPlannedRecipesState((prev) => {
      const indexToRemove = prev.findIndex((entry) => entry.id === recipeId);
      if (indexToRemove === -1) return [...prev, { id: recipeId, servings: initialServings }];
      return prev.filter((_, index) => index !== indexToRemove);
    });
  };

  const updatePlannedRecipeServings = (index: number, delta: number) => {
    // Update servings for the selected planner row only
    setPlannedRecipesState((prev) => {
      if (index < 0 || index >= prev.length) return prev;

      return prev.map((entry, entryIndex) => {
        if (entryIndex !== index) return entry;
        return {
          ...entry,
          servings: Math.max(1, entry.servings + delta),
        };
      });
    });
  };

  useEffect(() => {
    // Reset planner focus when planner becomes empty
    if (plannedRecipes.length === 0) {
      setSelectedPlannedIndex(0);
      setPlannedScrollOffset(0);
      if (focusPane === 'planned') {
        setFocusPane('recipes');
      }
      return;
    }

    if (selectedPlannedIndex >= plannedRecipes.length) {
      setSelectedPlannedIndex(plannedRecipes.length - 1);
    }
  }, [plannedRecipes.length, selectedPlannedIndex, focusPane]);

  useEffect(() => {
    // Keep selected planned recipe inside visible planner window
    if (selectedPlannedIndex < plannedScrollOffset) {
      setPlannedScrollOffset(selectedPlannedIndex);
      return;
    }

    const windowEnd = plannedScrollOffset + plannedVisibleCount;
    if (selectedPlannedIndex >= windowEnd) {
      setPlannedScrollOffset(selectedPlannedIndex - plannedVisibleCount + 1);
    }
  }, [selectedPlannedIndex, plannedScrollOffset, plannedVisibleCount]);

  useEffect(() => {
    // Prevent planner scroll offset from exceeding current bounds
    const maxOffset = Math.max(0, plannedRecipes.length - plannedVisibleCount);
    if (plannedScrollOffset > maxOffset) {
      setPlannedScrollOffset(maxOffset);
    }
  }, [plannedRecipes.length, plannedVisibleCount, plannedScrollOffset]);

  // determine length of longest recipe title for text alignment in recipe list
  const listNameColumnWidth = useMemo(() => {
    const longest = filteredRecipes.reduce((max, r) => Math.max(max, r.name.length), 0);
    return Math.max(20, Math.min(40, longest + 4));
  }, [filteredRecipes]);

  const LIST_HINT_ADD_ONLY = t('recipes.listHint.addOnly', language);
  const LIST_HINT_WITH_MOVE = t('recipes.listHint.withMove', language);
  const PLANNER_HINT_WITH_MOVE = t('recipes.plannerHint.withMove', language);

  const hasPlannedRecipes = plannedRecipes.length > 0;
  const listHintText =
    filteredRecipes.length > 0 && focusPane === 'recipes'
      ? hasPlannedRecipes
        ? LIST_HINT_WITH_MOVE
        : LIST_HINT_ADD_ONLY
      : '';
  const plannerHintText =
    hasPlannedRecipes && focusPane === 'planned' ? PLANNER_HINT_WITH_MOVE : '';

  const minimumListBoxWidth = Math.max(20, listNameColumnWidth, LIST_HINT_WITH_MOVE.length);
  const minimumPlannedBoxWidth = Math.max(20, PLANNER_HINT_WITH_MOVE.length);
  const minimumTwoPaneWidth = minimumListBoxWidth + minimumPlannedBoxWidth + 6;
  const shouldStackPlanner = screenWidth < minimumTwoPaneWidth;

  // determine length of longest recipe title for box-width
  const plannedBoxWidth = useMemo(() => {
    const longestPlannedLabel = plannedRecipes.reduce(
      (max, entry) => Math.max(max, `${entry.recipe.name} (${entry.servings})`.length),
      0,
    );
    if (shouldStackPlanner) {
      const stackedMaxWidth = Math.max(minimumPlannedBoxWidth, screenWidth - 8);
      return Math.max(minimumPlannedBoxWidth, Math.min(stackedMaxWidth, longestPlannedLabel + 6));
    }

    const horizontalBudget = screenWidth - minimumListBoxWidth - 6;
    const maxPlannedWidth = Math.max(minimumPlannedBoxWidth, Math.min(40, horizontalBudget));

    return Math.max(minimumPlannedBoxWidth, Math.min(maxPlannedWidth, longestPlannedLabel + 6));
  }, [
    plannedRecipes,
    screenWidth,
    shouldStackPlanner,
    minimumListBoxWidth,
    minimumPlannedBoxWidth,
  ]);

  // Compute missing ingredients for a given recipe and target servings
  const computeMissingForRecipe = (recipe: ViewRecipe, targetServings: number): MissingItem[] => {
    return computeMissingForIngredients({
      ingredients: recipe.ingredients,
      inventoryItems: dbInventory,
      shoppingListItems: todayListItems,
      targetServings,
      baseServings: recipe.servings,
    });
  };

  // Quick check whether a single ingredient (with already scaled amount) is missing
  const isIngredientMissing = (name: string, requiredAmount: number, unit: string): boolean => {
    return isIngredientMissingInInventory(name, requiredAmount, unit, dbInventory);
  };

  // Precompute missing ingredients for visible recipes based on DB inventory
  // If a recipe is present in the planner, use the planner servings override for missing checks
  const missingMap = useMemo(() => {
    const m = new Map<number, MissingItem[]>();

    for (const recipe of visibleRecipes) {
      const servingsToCheck = plannedServingsByRecipeId.get(recipe.id) ?? defaultRecipeServings;
      m.set(recipe.id, computeMissingForRecipe(recipe, servingsToCheck));
    }

    return m;
  }, [
    visibleRecipes,
    dbInventory,
    plannedServingsByRecipeId,
    todayListItems,
    defaultRecipeServings,
  ]);

  const plannedAggregateMissing = useMemo(() => {
    const ingredientNeeds: Array<{ name: string; amount: number; unit: string }> = [];

    for (const plannedEntry of plannedRecipes) {
      const recipe = plannedEntry.recipe;
      const targetServings =
        plannedEntry.servings > 0 ? plannedEntry.servings : defaultRecipeServings;
      const baseServings = recipe.servings > 0 ? recipe.servings : 1;
      const factor = targetServings / baseServings;

      for (const ing of recipe.ingredients) {
        const neededRaw = (ing.amount ?? 0) * factor;
        if (neededRaw <= 0) continue;

        const ingName = String(ing.name || '').trim();
        const ingUnit = String(ing.unit || '').trim();
        if (!ingName || !ingUnit) continue;

        ingredientNeeds.push({
          name: ingName,
          unit: ingUnit,
          amount: neededRaw,
        });
      }
    }

    return computeAggregateMissingWithShoppingList({
      ingredientNeeds,
      inventoryItems: dbInventory,
      shoppingListItems: todayListItems,
    });
  }, [plannedRecipes, dbInventory, todayListItems, defaultRecipeServings]);

  const maxVisiblePlannedMissingRows = useMemo(() => {
    // Keep the section compact and indicate hidden rows explicitly.
    return shouldStackPlanner ? 4 : Math.max(4, Math.min(8, maxVisibleRecipes - 2));
  }, [shouldStackPlanner, maxVisibleRecipes]);

  const visiblePlannedAggregateMissing = useMemo(
    () => plannedAggregateMissing.slice(0, maxVisiblePlannedMissingRows),
    [plannedAggregateMissing, maxVisiblePlannedMissingRows],
  );

  const hasHiddenPlannedAggregateMissing =
    plannedAggregateMissing.length > visiblePlannedAggregateMissing.length;

  const addItemsToShoppingList = (itemsToAdd: ShoppingListItemInput[]) => {
    if (itemsToAdd.length === 0) return;

    // find today's Recipes Planner list if exists
    const lists = getAllShoppingLists();
    const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const todayList = lists
      .filter(
        (l) =>
          (l.createdAt ?? '').startsWith(todayPrefix) &&
          String(l.name || '')
            .toLowerCase()
            .startsWith('recipes planner '),
      )
      .sort((a, b) => b.id - a.id)[0];

    const listId = todayList
      ? todayList.id
      : createShoppingList(`Recipes Planner ${new Date().toLocaleDateString()}`);

    const listAggregate = getShoppingListById(listId);
    const existingItems = listAggregate?.items ?? [];

    for (const item of itemsToAdd) {
      const existing = existingItems.find(
        (ei) =>
          String(ei.name || '')
            .trim()
            .toLowerCase() ===
          String(item.name || '')
            .trim()
            .toLowerCase(),
      );

      if (existing) {
        const existingUnit = String(existing.unit || '').toLowerCase();
        const itemUnit = String(item.unit || '').toLowerCase();

        if (existingUnit === itemUnit) {
          // For weight/volume units, keep quantities as whole numbers
          if (existingUnit === 'g' || existingUnit === 'ml') {
            // Sum and round up to next 25-step so shopping list quantities stay in 25g/ml increments
            const summed = existing.quantity + item.quantity;
            const newQty = Math.ceil((summed - Number.EPSILON) / 25) * 25;
            updateListItem(existing.id, { quantity: newQty });
          } else {
            updateListItem(existing.id, { quantity: existing.quantity + item.quantity });
          }
        } else {
          // Unit mismatch: create a separate line to avoid ambiguity
          addItemToList(listId, item);
        }
      } else {
        addItemToList(listId, item);
      }
    }

    // refresh today's shopping list items for UI
    try {
      const refreshed = getShoppingListById(listId);
      setTodayListItems(refreshed?.items ?? []);
    } catch {
      // ignore
    }
  };

  const renderedRecipes = useMemo(() => {
    let remainingRows = pageSize;
    const rows: ViewRecipe[] = [];

    for (let idx = 0; idx < visibleRecipes.length; idx++) {
      const recipe = visibleRecipes[idx];
      if (!recipe) continue;
      const absoluteIndex = scrollOffset + idx;
      const isSelected = absoluteIndex === selectedRecipeIndex;
      const missing = missingMap.get(recipe.id) ?? [];
      const extraRows = isSelected && missing.length > 0 ? missing.length + 2 : 0;
      const neededRows = 1 + extraRows;

      if (neededRows > remainingRows) break;

      rows.push(recipe);
      remainingRows -= neededRows;
    }

    return rows;
  }, [pageSize, visibleRecipes, scrollOffset, selectedRecipeIndex, missingMap]);

  // Expand left recipe column when the selected recipe has missing items
  const leftListWidth = useMemo(() => {
    if (shouldStackPlanner) return minimumListBoxWidth;

    const selected = filteredRecipes[selectedRecipeIndex];
    const hasSelectedMissing = selected ? (missingMap.get(selected.id) ?? []).length > 0 : false;
    if (!hasSelectedMissing) return Math.max(listNameColumnWidth, minimumListBoxWidth);

    // try to give up to ~65% of screen to the left column but keep room for planner
    const maxAllowed = Math.max(listNameColumnWidth, screenWidth - plannedBoxWidth - 8);
    const desired = Math.min(maxAllowed, Math.floor(screenWidth * 0.65));
    return Math.max(minimumListBoxWidth, desired);
  }, [
    shouldStackPlanner,
    minimumListBoxWidth,
    filteredRecipes,
    selectedRecipeIndex,
    missingMap,
    screenWidth,
    plannedBoxWidth,
  ]);

  const listAllergenLegend = useMemo(() => {
    if (userIntolerances === 'none') return null;

    let hasL = false;
    let hasG = false;

    for (const recipe of visibleRecipes) {
      const marker = recipeAllergenWarnings.get(recipe.id);
      if (!marker) continue;
      if (marker.includes('l')) hasL = true;
      if (marker.includes('g')) hasG = true;
    }

    if (!hasL && !hasG) return null;
    if (hasL && hasG) return '(allergens: l = lactose, g = gluten)';
    if (hasL) return '(allergens: l = lactose)';
    return '(allergens: g = gluten)';
  }, [userIntolerances, visibleRecipes, recipeAllergenWarnings]);

  const listHeaderHint = useMemo(() => {
    return t('recipes.header.hint', language);
  }, [language]);

  const detailAllergenLegend = useMemo(() => {
    if (userIntolerances === 'none') return null;

    let hasL = false;
    let hasG = false;

    for (const marker of detailIngredientWarnings.values()) {
      if (marker.includes('l')) hasL = true;
      if (marker.includes('g')) hasG = true;
    }

    if (!hasL && !hasG) return null;
    if (hasL && hasG) return '(allergens: l = lactose, g = gluten)';
    if (hasL) return '(allergens: l = lactose)';
    return '(allergens: g = gluten)';
  }, [userIntolerances, detailIngredientWarnings]);

  // Handler: add missing ingredients of a recipe to today's shopping list (create if needed)
  // accepts optional target servings so callers can add quantities for the current servings state
  const addMissingToShoppingList = (recipeId: number, targetServings?: number) => {
    const recipe = recipeList.find((r) => r.id === recipeId);
    if (!recipe) return;

    const servings =
      typeof targetServings === 'number' && targetServings > 0
        ? targetServings
        : recipe.servings > 0
          ? recipe.servings
          : 1;

    const baseServings = recipe.servings > 0 ? recipe.servings : 1;
    const factor = servings / baseServings;

    // Use computeMissingForRecipe so quantities are rounded up to quarters
    const itemsToAdd: ShoppingListItemInput[] = [];
    const missingItems = computeMissingForRecipe(recipe, servings);
    for (const mi of missingItems) {
      if (mi.missingAmount > 0) {
        itemsToAdd.push({ name: mi.name, quantity: mi.missingAmount, unit: mi.unit });
      }
    }

    addItemsToShoppingList(itemsToAdd);
  };

  const addPlannedMissingToShoppingList = () => {
    const itemsToAdd: ShoppingListItemInput[] = plannedAggregateMissing
      .filter((mi) => mi.missingAmount > 0)
      .map((mi) => ({
        name: mi.name,
        quantity: mi.missingAmount,
        unit: mi.unit,
      }));

    addItemsToShoppingList(itemsToAdd);
  };

  const scaledIngredients = useMemo(() => {
    if (!activeRecipe) return [];

    // Always scale from original recipe servings and ingredient amounts from DB
    const baseServings = activeRecipe.servings > 0 ? activeRecipe.servings : 1;
    const factor = detailServings / baseServings;

    return activeRecipe.ingredients.map((ing) => {
      const unitLower = String(ing.unit || '').toLowerCase();
      const raw = ing.amount * factor;
      let scaledAmount: number;
      if (unitLower === 'g' || unitLower === 'ml') {
        // display: for small amounts keep integer rounding, for >=25 show nearest 25
        if (raw >= 25) {
          scaledAmount = Math.round(raw / 25) * 25;
        } else {
          scaledAmount = Math.round(raw + Number.EPSILON);
        }
      } else {
        scaledAmount = Math.round((raw + Number.EPSILON) * 4) / 4;
      }

      return {
        ...ing,
        scaledAmount,
      };
    });
  }, [activeRecipe, detailServings]);

  // Map of missing items for the active recipe (used in detail view to decide per-ingredient coverage)
  const detailMissingMap = useMemo(() => {
    if (!activeRecipe) return new Map();
    const missing = computeMissingForRecipe(activeRecipe, detailServings);
    return new Map(
      missing.map((m) => [
        String(m.name || '')
          .trim()
          .toLowerCase(),
        m,
      ]),
    );
  }, [activeRecipe, detailServings, dbInventory, todayListItems]);

  useInput((input, key) => {
    // navigation in recipe list
    if (!activeRecipe) {
      if (pendingDeleteRecipe) {
        // Deletion confirmation blocks all other list keybindings until resolved
        if (key.escape || input.toLowerCase() === 'n') {
          setPendingDeleteRecipe(null);
          return;
        }

        if (key.return || input.toLowerCase() === 'y') {
          // Snapshot the current list position before reloading so focus can be restored deterministically
          const currentSelectedIndex = selectedRecipeIndex;
          deleteRecipeById(pendingDeleteRecipe.id);
          // Prevent stale planner rows that reference removed recipes
          setPlannedRecipesState((prev) =>
            prev.filter((entry) => entry.id !== pendingDeleteRecipe.id),
          );
          const rows = reloadRecipes();
          setRecipeList(rows);

          clearSearch();
          resetAllFilters();

          const nextIndex = Math.min(currentSelectedIndex, Math.max(0, rows.length - 1));
          setSelectedRecipeIndex(nextIndex);
          setPendingDeleteRecipe(null);
          return;
        }

        return;
      }

      if (isAddingRecipe) {
        // While creating a recipe, consume typing exclusively for form fields
        const activeField = newRecipeFields[newRecipeFieldIndex] ?? 'title';
        const ingredientFieldOrder: IngredientDraftField[] = ['amount', 'unit', 'name'];

        if (addRecipeEditorMode === 'ingredients') {
          const selectedDraft = ingredientDrafts[selectedIngredientDraftIndex];
          if (!selectedDraft) {
            setIngredientDrafts([createEmptyIngredientDraft()]);
            setSelectedIngredientDraftIndex(0);
            setSelectedIngredientDraftField('amount');
            return;
          }

          // Keep "q" local to the editor so app-level quit hotkeys cannot fire while editing
          if (!key.ctrl && !key.meta && input.toLowerCase() === 'q') {
            if (selectedIngredientDraftField === 'unit') return;

            setIngredientDrafts((prev) =>
              prev.map((draft, index) => {
                if (index !== selectedIngredientDraftIndex) return draft;

                return {
                  ...draft,
                  [selectedIngredientDraftField]: draft[selectedIngredientDraftField] + input,
                };
              }),
            );
            setAddRecipeError(null);
            return;
          }

          if (key.escape) {
            setAddRecipeEditorMode('form');
            return;
          }

          if (key.upArrow) {
            setSelectedIngredientDraftIndex((prev) => Math.max(0, prev - 1));
            return;
          }

          if (key.downArrow) {
            setSelectedIngredientDraftIndex((prev) =>
              Math.min(ingredientDrafts.length - 1, prev + 1),
            );
            return;
          }

          if (key.leftArrow || key.rightArrow) {
            const moveRight = Boolean(key.rightArrow);
            const currentFieldIndex = ingredientFieldOrder.indexOf(selectedIngredientDraftField);
            const nextFieldIndex = moveRight
              ? Math.min(ingredientFieldOrder.length - 1, currentFieldIndex + 1)
              : Math.max(0, currentFieldIndex - 1);
            setSelectedIngredientDraftField(ingredientFieldOrder[nextFieldIndex] ?? 'amount');
            return;
          }

          if (
            selectedIngredientDraftField === 'unit' &&
            (input === '+' || input === '=' || input === '-')
          ) {
            const currentUnitIndex = recipeIngredientUnitOptions.findIndex(
              (option) => option === selectedDraft.unit,
            );
            const safeCurrentUnitIndex = currentUnitIndex >= 0 ? currentUnitIndex : 0;
            const nextUnitIndex =
              input === '-'
                ? (safeCurrentUnitIndex - 1 + recipeIngredientUnitOptions.length) %
                  recipeIngredientUnitOptions.length
                : (safeCurrentUnitIndex + 1) % recipeIngredientUnitOptions.length;

            setIngredientDrafts((prev) =>
              prev.map((draft, index) =>
                index === selectedIngredientDraftIndex
                  ? {
                      ...draft,
                      unit:
                        recipeIngredientUnitOptions[nextUnitIndex] ??
                        recipeIngredientUnitOptions[0],
                    }
                  : draft,
              ),
            );
            setAddRecipeError(null);
            return;
          }

          if (key.return) {
            setIngredientDrafts((prev) => {
              const insertIndex = Math.min(prev.length, selectedIngredientDraftIndex + 1);
              const next = [...prev];
              next.splice(insertIndex, 0, createEmptyIngredientDraft());
              return next;
            });
            setSelectedIngredientDraftIndex((prev) => prev + 1);
            setSelectedIngredientDraftField('amount');
            setAddRecipeError(null);
            return;
          }

          if (key.ctrl && input.toLowerCase() === 'x') {
            if (ingredientDrafts.length === 1) {
              setIngredientDrafts([createEmptyIngredientDraft()]);
              setSelectedIngredientDraftIndex(0);
              setSelectedIngredientDraftField('amount');
              return;
            }

            setIngredientDrafts((prev) =>
              prev.filter((_, idx) => idx !== selectedIngredientDraftIndex),
            );
            setSelectedIngredientDraftIndex((prev) => Math.max(0, prev - 1));
            setSelectedIngredientDraftField('amount');
            setAddRecipeError(null);
            return;
          }

          if (key.backspace || key.delete) {
            if (selectedIngredientDraftField === 'unit') return;

            setIngredientDrafts((prev) =>
              prev.map((draft, index) => {
                if (index !== selectedIngredientDraftIndex) return draft;

                const currentValue = draft[selectedIngredientDraftField];
                return {
                  ...draft,
                  [selectedIngredientDraftField]: currentValue.slice(0, -1),
                };
              }),
            );
            setAddRecipeError(null);
            return;
          }

          if (input && input.length === 1 && !key.ctrl && !key.meta) {
            if (selectedIngredientDraftField === 'unit') return;
            if (selectedIngredientDraftField === 'amount' && !/[0-9.,]/.test(input)) {
              return;
            }

            setIngredientDrafts((prev) =>
              prev.map((draft, index) => {
                if (index !== selectedIngredientDraftIndex) return draft;

                return {
                  ...draft,
                  [selectedIngredientDraftField]: draft[selectedIngredientDraftField] + input,
                };
              }),
            );
            setAddRecipeError(null);
            return;
          }

          return;
        }

        if (addRecipeEditorMode === 'steps') {
          const selectedStep = stepDrafts[selectedStepDraftIndex] ?? '';

          // Keep "q" local to the editor so app-level quit hotkeys cannot fire while editing
          if (!key.ctrl && !key.meta && input.toLowerCase() === 'q') {
            setStepDrafts((prev) =>
              prev.map((step, index) =>
                index === selectedStepDraftIndex ? selectedStep + input : step,
              ),
            );
            setAddRecipeError(null);
            return;
          }

          if (key.escape) {
            setAddRecipeEditorMode('form');
            return;
          }

          if (key.upArrow) {
            setSelectedStepDraftIndex((prev) => Math.max(0, prev - 1));
            return;
          }

          if (key.downArrow) {
            setSelectedStepDraftIndex((prev) => Math.min(stepDrafts.length - 1, prev + 1));
            return;
          }

          if (key.return) {
            setStepDrafts((prev) => {
              const insertIndex = Math.min(prev.length, selectedStepDraftIndex + 1);
              const next = [...prev];
              next.splice(insertIndex, 0, '');
              return next;
            });
            setSelectedStepDraftIndex((prev) => prev + 1);
            setAddRecipeError(null);
            return;
          }

          if (key.ctrl && input.toLowerCase() === 'x') {
            if (stepDrafts.length === 1) {
              setStepDrafts(['']);
              setSelectedStepDraftIndex(0);
              return;
            }

            setStepDrafts((prev) => prev.filter((_, idx) => idx !== selectedStepDraftIndex));
            setSelectedStepDraftIndex((prev) => Math.max(0, prev - 1));
            setAddRecipeError(null);
            return;
          }

          if (key.backspace || key.delete) {
            setStepDrafts((prev) =>
              prev.map((step, index) =>
                index === selectedStepDraftIndex ? step.slice(0, -1) : step,
              ),
            );
            setAddRecipeError(null);
            return;
          }

          if (input && input.length === 1 && !key.ctrl && !key.meta) {
            setStepDrafts((prev) =>
              prev.map((step, index) =>
                index === selectedStepDraftIndex ? selectedStep + input : step,
              ),
            );
            setAddRecipeError(null);
            return;
          }

          return;
        }

        if (key.escape) {
          setIsAddingRecipe(false);
          resetNewRecipeForm();
          return;
        }

        if (key.upArrow) {
          setNewRecipeFieldIndex((prev) => Math.max(0, prev - 1));
          return;
        }

        if (key.downArrow) {
          setNewRecipeFieldIndex((prev) => Math.min(newRecipeFields.length - 1, prev + 1));
          return;
        }

        if (key.leftArrow || key.rightArrow) {
          // Option fields are cycled, not typed, to enforce allowed values.
          const moveRight = Boolean(key.rightArrow);

          if (activeField === 'difficulty') {
            const currentIdx = recipeDifficultyOptions.findIndex(
              (level) => level === newRecipeForm.difficulty.toLowerCase(),
            );
            const safeCurrentIdx =
              currentIdx >= 0 ? currentIdx : recipeDifficultyOptions.length - 1;
            const nextIdx = moveRight
              ? (safeCurrentIdx + 1) % recipeDifficultyOptions.length
              : (safeCurrentIdx - 1 + recipeDifficultyOptions.length) %
                recipeDifficultyOptions.length;

            setNewRecipeForm((prev) => ({
              ...prev,
              difficulty: recipeDifficultyOptions[nextIdx] ?? 'unknown',
            }));
            setAddRecipeError(null);
            return;
          }

          if (activeField === 'habits') {
            const currentIdx = recipeHabitOptions.findIndex(
              (value) => value === newRecipeForm.habits.toLowerCase(),
            );
            const safeCurrentIdx = currentIdx >= 0 ? currentIdx : 0;
            const nextIdx = moveRight
              ? (safeCurrentIdx + 1) % recipeHabitOptions.length
              : (safeCurrentIdx - 1 + recipeHabitOptions.length) % recipeHabitOptions.length;

            setNewRecipeForm((prev) => ({
              ...prev,
              habits: recipeHabitOptions[nextIdx] ?? recipeHabitOptions[0],
            }));
            setAddRecipeError(null);
            return;
          }

          if (activeField === 'categories') {
            const currentIdx = recipeCategoryOptions.findIndex(
              (value) => value === newRecipeForm.categories.toLowerCase(),
            );
            const safeCurrentIdx = currentIdx >= 0 ? currentIdx : 0;
            const nextIdx = moveRight
              ? (safeCurrentIdx + 1) % recipeCategoryOptions.length
              : (safeCurrentIdx - 1 + recipeCategoryOptions.length) % recipeCategoryOptions.length;

            setNewRecipeForm((prev) => ({
              ...prev,
              categories: recipeCategoryOptions[nextIdx] ?? recipeCategoryOptions[0],
            }));
            setAddRecipeError(null);
            return;
          }
        }

        if (key.return) {
          // Enter advances through fields, opens sub editors, or saves on the explicit save row.
          if (activeField === 'ingredients') {
            setAddRecipeEditorMode('ingredients');
            return;
          }

          if (activeField === 'steps') {
            setAddRecipeEditorMode('steps');
            return;
          }

          if (activeField !== 'save') {
            setNewRecipeFieldIndex((prev) => prev + 1);
            return;
          }

          const title = newRecipeForm.title.trim();
          const servings = Number.parseInt(newRecipeForm.servings.trim(), 10);
          const duration = Number.parseInt(newRecipeForm.duration.trim(), 10);
          const difficulty = newRecipeForm.difficulty.trim().toLowerCase() || 'unknown';
          const selectedHabit = newRecipeForm.habits.trim().toLowerCase();
          const selectedCategory = newRecipeForm.categories.trim().toLowerCase();

          if (!title) {
            setAddRecipeError('Please enter a recipe title.');
            return;
          }

          if (!Number.isFinite(servings) || servings < 1) {
            setAddRecipeError('Servings must be a number >= 1.');
            return;
          }

          if (!Number.isFinite(duration) || duration < 0) {
            setAddRecipeError('Duration must be a number >= 0.');
            return;
          }

          if (
            !recipeDifficultyOptions.includes(
              difficulty as (typeof recipeDifficultyOptions)[number],
            )
          ) {
            setAddRecipeError('Difficulty must be selected from the list.');
            return;
          }

          if (!recipeHabitOptions.includes(selectedHabit as (typeof recipeHabitOptions)[number])) {
            // Defensive guard: should never fail during normal arrow-based selection.
            setAddRecipeError('Habit must be selected from the list.');
            return;
          }

          if (
            !recipeCategoryOptions.includes(
              selectedCategory as (typeof recipeCategoryOptions)[number],
            )
          ) {
            setAddRecipeError('Category must be selected from the list.');
            return;
          }

          const parsedIngredients = parseIngredientDrafts();
          if (parsedIngredients.error) {
            setAddRecipeError(parsedIngredients.error);
            return;
          }

          // Keep the editor permissive while persisting only meaningful step content
          const parsedSteps = parseStepDrafts();

          // Persist parsed child rows immediately so detail view works without follow-up edits.
          const createdId = createRecipe({
            title,
            servings,
            duration,
            difficulty,
            habits: [selectedHabit],
            categories: [selectedCategory],
            ingredients: parsedIngredients.items,
            steps: parsedSteps,
          });

          const rows = reloadRecipes();
          setRecipeList(rows);

          clearSearch();
          resetAllFilters();

          const createdIndex = rows.findIndex((recipe) => recipe.id === createdId);
          if (createdIndex >= 0) {
            // Focus newly created recipe so Enter can open it immediately
            setSelectedRecipeIndex(createdIndex);
          }

          setIsAddingRecipe(false);
          resetNewRecipeForm();
          return;
        }

        if (key.backspace || key.delete) {
          if (
            activeField === 'difficulty' ||
            activeField === 'habits' ||
            activeField === 'categories' ||
            activeField === 'ingredients' ||
            activeField === 'steps' ||
            activeField === 'save'
          ) {
            return;
          }

          setNewRecipeForm((prev) => ({
            ...prev,
            [activeField]: prev[activeField].slice(0, -1),
          }));
          setAddRecipeError(null);
          return;
        }

        if (input && input.length === 1 && !key.ctrl && !key.meta) {
          if (
            activeField === 'difficulty' ||
            activeField === 'habits' ||
            activeField === 'categories' ||
            activeField === 'ingredients' ||
            activeField === 'steps' ||
            activeField === 'save'
          ) {
            return;
          }

          const isNumericField = activeField === 'servings' || activeField === 'duration';
          if (isNumericField && !/[0-9]/.test(input)) return;

          setNewRecipeForm((prev) => ({
            ...prev,
            [activeField]: prev[activeField] + input,
          }));
          setAddRecipeError(null);
          return;
        }

        return;
      }

      if (isSearching) {
        // Handle search mode input without triggering list navigation
        if (key.escape) {
          // Exit search mode and clear query immediately
          searchBuffer.current = '';
          setVisualSearchValue('');
          setSearchQuery('');
          setSelectedRecipeIndex(0);
          setScrollOffset(0);
          setIsSearching(false);
          return;
        }

        if (key.return) {
          setIsSearching(false);
          return;
        }

        if (key.backspace || key.delete) {
          searchBuffer.current = searchBuffer.current.slice(0, -1);
        } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
          searchBuffer.current += input;
        }

        setVisualSearchValue(searchBuffer.current);
        setSearchQuery(searchBuffer.current);
        setSelectedRecipeIndex(0);
        setScrollOffset(0);
        return;
      }

      if (input === '/') {
        setIsSearching(true);
        searchBuffer.current = searchQuery;
        setVisualSearchValue(searchQuery);
        return;
      }

      if (input === 'S') {
        if (plannedAggregateMissing.length === 0) return;
        addPlannedMissingToShoppingList();
        return;
      }

      if (input === 'p' && focusPane === 'recipes') {
        const recipe = filteredRecipes[selectedRecipeIndex];
        if (!recipe) return;
        addRecipeToPlanner(recipe.id);
        return;
      }

      // Handle s key to add missing ingredients for the selected recipe to shopping list
      if (input === 's' && focusPane === 'recipes') {
        const recipe = filteredRecipes[selectedRecipeIndex];
        if (!recipe) return;
        const missing = missingMap.get(recipe.id) ?? [];
        if (missing.length === 0) {
          return;
        }
        // if the recipe is planned, use the planned servings for shopping-list quantities
        const servingsToAdd = plannedServingsByRecipeId.get(recipe.id) ?? defaultRecipeServings;
        addMissingToShoppingList(recipe.id, servingsToAdd);
        return;
      }

      if ((input === '+' || input === '=') && focusPane === 'recipes') {
        // Start lightweight inline create flow from the list
        setIsAddingRecipe(true);
        resetNewRecipeForm();
        return;
      }

      if (input === 'd' && focusPane === 'recipes') {
        // Cycle difficulty filter on repeated key presses
        cycleFilter(difficultyOptions, selectedDifficulty, setSelectedDifficulty);
        return;
      }

      if (input === 'h' && focusPane === 'recipes') {
        // Cycle habit filter on repeated key presses
        cycleFilter(habitOptions, selectedHabit, setSelectedHabit);
        return;
      }

      if (input === 'c' && focusPane === 'recipes') {
        // Cycle category filter on repeated key presses
        cycleFilter(categoryOptions, selectedCategory, setSelectedCategory);
        return;
      }

      if (input === 't' && focusPane === 'recipes') {
        // Cycle diet filter on repeated key presses
        cycleFilter(dietOptions, selectedDiet, setSelectedDiet);
        return;
      }

      if (input === 'r') {
        // Reset all filters to default option
        resetAllFilters();
        return;
      }

      if (input === 'f' && focusPane === 'recipes') {
        // Toggle favorite state for the selected list recipe
        const recipe = filteredRecipes[selectedRecipeIndex];
        if (!recipe) return;
        toggleFavoriteCategory(recipe.id);
        return;
      }

      if (input === '-' && focusPane === 'recipes') {
        const recipe = filteredRecipes[selectedRecipeIndex];
        if (!recipe) return;
        // Open confirmation prompt instead of deleting immediately
        setPendingDeleteRecipe(recipe);
        return;
      }

      if (key.rightArrow) {
        // Switch focus to planner pane when entries are available
        if (focusPane === 'recipes' && plannedRecipes.length > 0) {
          setFocusPane('planned');
          return;
        }
      }

      if (key.leftArrow && focusPane === 'planned') {
        setFocusPane('recipes');
        return;
      }

      if (focusPane === 'planned') {
        // Handle planner navigation and removal shortcuts
        if (plannedRecipes.length === 0) return;

        const maxPlannedIndex = plannedRecipes.length - 1;
        if (key.downArrow) setSelectedPlannedIndex((index) => Math.min(index + 1, maxPlannedIndex));
        if (key.upArrow) setSelectedPlannedIndex((index) => Math.max(index - 1, 0));

        if (input === '+' || input === '=') {
          updatePlannedRecipeServings(selectedPlannedIndex, 1);
          return;
        }

        if (input === '-') {
          updatePlannedRecipeServings(selectedPlannedIndex, -1);
          return;
        }

        if (input === 'p') {
          setPlannedRecipesState((prev) =>
            prev.filter((_, index) => index !== selectedPlannedIndex),
          );
        }
        return;
      }

      if (filteredRecipes.length === 0) return;

      // Handle recipe list navigation and open selected recipe
      const maxIndex = filteredRecipes.length - 1;
      if (key.downArrow) setSelectedRecipeIndex((index) => Math.min(index + 1, maxIndex));
      if (key.upArrow) setSelectedRecipeIndex((index) => Math.max(index - 1, 0));

      if (key.return) {
        const recipe = filteredRecipes[selectedRecipeIndex];
        if (!recipe) return;
        setActiveRecipeId(recipe.id);
      }
    } else {
      // Adjust servings in detail view and rescale ingredients live
      if (input === 's') {
        const missing = computeMissingForRecipe(activeRecipe, detailServings);
        if (missing.length === 0) {
          return;
        }
        addMissingToShoppingList(activeRecipe.id, detailServings);
        return;
      }
      // Export current recipe to Markdown
      if (input === 'm') {
        const filePath = exportRecipeToMarkdown(activeRecipe, detailServings);
        setStatusMessage(`Exported to ${filePath}`);
        return;
      }
      // Export current recipe to PDF (press uppercase P)
      if (input === 'P') {
        exportRecipeToPdf(activeRecipe, detailServings).then(
          (filePath) => setStatusMessage(`Exported to ${filePath}`),
          () => setStatusMessage('PDF export failed'),
        );
        return;
      }
      if (input === '+' || input === '=') {
        setDetailServings((prev) => prev + 1);
        return;
      }

      if (input === '-') {
        setDetailServings((prev) => Math.max(1, prev - 1));
        return;
      }

      if (input === 'p') {
        // Add current detail servings to planner when recipe is not planned yet
        // This keeps planner quantity aligned with what the user just adjusted
        toggleRecipeInPlanner(activeRecipe.id, detailServings);
        return;
      }

      if (input === 'f') {
        // Toggle favorite state while viewing recipe details
        toggleFavoriteCategory(activeRecipe.id);
        return;
      }

      if (key.escape || input === 'b') setActiveRecipeId(null);
    }
  });

  if (!activeRecipe) {
    // Show list screen with optional search filter and planner pane
    const hasRecipesAbove = scrollOffset > 0;
    const hasRecipesBelow = scrollOffset + renderedRecipes.length < filteredRecipes.length;
    const modalTopOffset = 8;
    const modalLeftOffset = 16;
    // Clamp overlay width so the create and delete dialogs stay readable on narrow terminals
    const modalWidth = Math.max(52, Math.min(98, screenWidth - modalLeftOffset * 2));

    return (
      <Box
        flexDirection='column'
        width={screenWidth}
        height={screenHeight}
        padding={1}
        paddingTop={0}
      >
        {/* screen header with search panel and navigation instructions */}
        <Box
          flexDirection='row'
          alignItems='center'
          justifyContent='flex-start'
          borderStyle='single'
          paddingLeft={1}
          paddingTop={0}
        >
          <RecipeSearchPanel
            isSearching={isSearching}
            visualValue={visualSearchValue}
            activeQuery={searchQuery}
            idleHint={listHeaderHint}
            allergenLegend={listAllergenLegend}
            language={language}
          />
        </Box>

        <Box paddingLeft={1} paddingTop={1}>
          <Text color='white'>{t('recipes.filter.difficulty', language)}: </Text>
          <Text color='green'>{selectedDifficulty}</Text>
          <Text color='white'> | {t('recipes.filter.habit', language)}: </Text>
          <Text color='green'>{selectedHabit}</Text>
          <Text color='white'> | {t('recipes.filter.category', language)}: </Text>
          <Text color='green'>{selectedCategory}</Text>
          <Text color='white'> | {t('recipes.filter.diet', language)}: </Text>
          <Text color='green'>{selectedDiet}</Text>
          {/* Keep keyboard hints visually secondary to active filter values */}
          <Text dimColor>{t('recipes.filter.hint', language)}</Text>
        </Box>

        <Box height={1} paddingLeft={1}>
          {statusMessage ? <Text color='green'>{statusMessage}</Text> : null}
        </Box>

        {/* screen content - recipe list*/}
        <Box
          flexDirection={shouldStackPlanner ? 'column' : 'row'}
          justifyContent='space-between'
          alignItems='flex-start'
          paddingTop={1}
          flexGrow={1}
        >
          <Box flexDirection='column' paddingRight={shouldStackPlanner ? 0 : 2}>
            <Box width={leftListWidth}>
              <Text dimColor wrap='truncate-end'>
                {listHintText}
              </Text>
            </Box>

            <Box flexDirection='column' width={leftListWidth}>
              {/* hint if no recipes are found via search */}
              {filteredRecipes.length === 0 ? (
                <Text dimColor>{t('recipes.noMatch', language)}</Text>
              ) : (
                <>
                  {hasRecipesAbove ? <Text dimColor>{t('recipes.moreUp', language)}</Text> : null}
                  {renderedRecipes.map((recipe, idx) => {
                    const absoluteIndex = scrollOffset + idx;
                    const isSelected = absoluteIndex === selectedRecipeIndex;
                    const isFavorite = recipe.categories.includes(favoriteCategory);
                    const favoriteIcon = isFavorite ? '★' : '☆';

                    const missing = missingMap.get(recipe.id) ?? [];
                    const hasMissing = missing.length > 0;

                    const isCoveredByList = hasMissing
                      ? isMissingCoveredByShoppingList(missing, todayListItems)
                      : false;

                    let baseColor: string;
                    let nameDim = false;
                    if (isSelected) {
                      if (hasMissing) {
                        if (isCoveredByList) {
                          baseColor = 'yellow';
                          nameDim = true;
                        } else {
                          baseColor = 'yellow';
                        }
                      } else {
                        baseColor = 'yellow';
                      }
                    } else {
                      baseColor = hasMissing ? 'red' : 'white';
                    }

                    const indicatorColor = baseColor;
                    const favoriteColor = isFavorite ? 'yellow' : baseColor;

                    return (
                      <Box key={recipe.id} flexDirection='column'>
                        <Box flexDirection='row'>
                          <Text color={indicatorColor}>{isSelected ? '> ' : '  '}</Text>
                          <Text color={favoriteColor}>{favoriteIcon}</Text>

                          <Text color={baseColor} dimColor={nameDim} wrap='truncate-end'>
                            {' '}
                            {recipe.name}
                          </Text>

                          {recipeAllergenWarnings.has(recipe.id) && (
                            <Text color='red' dimColor>
                              {' '}
                              {recipeAllergenWarnings.get(recipe.id)}
                            </Text>
                          )}
                        </Box>

                        {isSelected && hasMissing ? (
                          <Box marginLeft={2} marginTop={0} flexDirection='column'>
                            <Text color='red' dimColor>
                              {t('recipes.missing', language)}
                            </Text>
                            <Box marginLeft={2} flexDirection='column'>
                              {missing.map((m, mi) => {
                                const covered = isMissingCoveredByShoppingList([m], todayListItems);
                                return (
                                  <Text
                                    key={`missing-${recipe.id}-${mi}`}
                                    color={covered ? 'green' : 'red'}
                                    dimColor
                                    wrap='truncate-end'
                                  >
                                    {m.label}
                                    {m.onListCount !== undefined
                                      ? ` (${formatAmount(m.onListCount)} ${t('recipes.onList', language)})`
                                      : ''}
                                  </Text>
                                );
                              })}
                            </Box>
                            <Text dimColor color='yellow'>
                              {t('recipes.addToShoppingList', language)}
                            </Text>
                          </Box>
                        ) : null}
                      </Box>
                    );
                  })}
                  {hasRecipesBelow ? <Text dimColor>{t('recipes.moreDown', language)}</Text> : null}
                </>
              )}
            </Box>
          </Box>

          <Box
            flexDirection='column'
            alignItems='flex-start'
            paddingRight={1}
            marginTop={shouldStackPlanner ? 1 : 0}
          >
            <Box width={plannedBoxWidth}>
              <Text dimColor wrap='truncate-end'>
                {plannerHintText}
              </Text>
            </Box>

            {/* screen content - planned recipes */}
            <Box
              flexDirection='column'
              width={plannedBoxWidth}
              borderStyle='single'
              borderColor={focusPane === 'planned' ? 'green' : undefined}
            >
              <Text bold>
                {t('recipes.planned.title', language)}
                {plannedScrollOffset > 0 ? ' ↑' : ''}
                {plannedScrollOffset + plannedVisibleCount < plannedRecipes.length ? ' ↓' : ''}
              </Text>
              {plannedRecipes.length === 0 ? (
                <Text dimColor>{t('recipes.planned.noPlanned', language)}</Text>
              ) : (
                visiblePlannedRecipes.map((recipe, index) => {
                  const absolutePlannedIndex = plannedScrollOffset + index;
                  const isPlannedSelected =
                    focusPane === 'planned' && absolutePlannedIndex === selectedPlannedIndex;

                  const plannedMissing = computeMissingForRecipe(recipe.recipe, recipe.servings);
                  const hasPlannedMissing = plannedMissing.length > 0;
                  const isPlannedCoveredByList = hasPlannedMissing
                    ? isMissingCoveredByShoppingList(plannedMissing, todayListItems)
                    : false;

                  const color = hasPlannedMissing
                    ? isPlannedCoveredByList
                      ? 'green'
                      : 'red'
                    : isPlannedSelected
                      ? 'green'
                      : 'white';
                  const dimColor =
                    !isPlannedSelected && (hasPlannedMissing || isPlannedCoveredByList);

                  return (
                    <Box key={`${recipe.id}-${absolutePlannedIndex}`} flexDirection='row'>
                      <Text color={color} dimColor={dimColor} wrap='truncate-end'>
                        • {recipe.recipe.name} ({recipe.servings})
                      </Text>
                    </Box>
                  );
                })
              )}
            </Box>

            {plannedAggregateMissing.length > 0 ? (
              <Box flexDirection='column' width={plannedBoxWidth} marginTop={1}>
                <Text dimColor color='yellow'>
                  {t('recipes.planned.missingNotice', language)}
                </Text>
                {visiblePlannedAggregateMissing.map((item, index) => (
                  <Text
                    key={`planned-aggregate-missing-${index}`}
                    color='red'
                    dimColor
                    wrap='truncate-end'
                  >
                    {item.label}
                    {item.onListCount !== undefined
                      ? ` (${formatAmount(item.onListCount)} ${t('recipes.onList', language)})`
                      : ''}
                  </Text>
                ))}
                {hasHiddenPlannedAggregateMissing ? (
                  <Text color='red' dimColor>
                    ...
                  </Text>
                ) : null}
                <Text dimColor color='yellow'>
                  {t('recipes.planned.addAllMissing', language)}
                </Text>
              </Box>
            ) : null}
          </Box>
        </Box>

        {isAddingRecipe ? (
          // Render as floating overlay so the list does not shift or merge visually.
          <Box
            position='absolute'
            marginTop={modalTopOffset}
            marginLeft={modalLeftOffset}
            width={modalWidth}
            borderStyle='double'
            borderColor='green'
            paddingX={1}
            flexDirection='column'
            backgroundColor='black'
          >
            <Text color='green' bold>
              {t('recipes.newRecipe', language)}
            </Text>
            {newRecipeFields.map((field, index) => {
              const isFocused = index === newRecipeFieldIndex;
              const label = t(`recipes.newForm.${field}`, language) || newRecipeFieldLabels[field];
              const value = getNewRecipeFieldValue(field);

              return (
                <Box key={field}>
                  <Text color={isFocused ? 'green' : 'white'}>{isFocused ? '▶ ' : '  '}</Text>
                  <Text>{label}: </Text>
                  <Text color={isFocused ? 'green' : undefined}>{value}</Text>
                  {isFocused ? <Text inverse>_</Text> : null}
                </Box>
              );
            })}

            {addRecipeEditorMode === 'form' ? (
              <Text dimColor>{t('recipes.editor.hints.form', language)}</Text>
            ) : null}

            {addRecipeEditorMode === 'ingredients' ? (
              <Box flexDirection='column' marginTop={1} borderStyle='single' borderColor='yellow'>
                <Text color='yellow'>{t('recipes.editor.ingredients.title', language)}</Text>
                {ingredientEditorOffset > 0 ? (
                  <Text dimColor>{t('recipes.editor.ingredients.more', language)}</Text>
                ) : null}
                {visibleIngredientDrafts.map((draft, index) => {
                  const absoluteIndex = ingredientEditorOffset + index;
                  const isSelected = absoluteIndex === selectedIngredientDraftIndex;
                  return (
                    <Box key={`ingredient-draft-${absoluteIndex}`}>
                      <Text color={isSelected ? 'green' : 'white'}>{isSelected ? '> ' : '  '}</Text>
                      <Text
                        color={
                          isSelected && selectedIngredientDraftField === 'amount'
                            ? 'green'
                            : 'white'
                        }
                      >
                        {draft.amount || t('recipes.editor.ingredients.amount', language)}
                      </Text>
                      <Text> | </Text>
                      <Text
                        color={
                          isSelected && selectedIngredientDraftField === 'unit' ? 'green' : 'white'
                        }
                      >
                        {draft.unit}
                      </Text>
                      <Text> | </Text>
                      <Text
                        color={
                          isSelected && selectedIngredientDraftField === 'name' ? 'green' : 'white'
                        }
                      >
                        {draft.name || t('recipes.editor.ingredients.name', language)}
                      </Text>
                    </Box>
                  );
                })}
                {ingredientEditorOffset + editorVisibleRows < ingredientDrafts.length ? (
                  <Text dimColor>{t('recipes.editor.ingredients.more', language)}</Text>
                ) : null}
                <Text dimColor>{t('recipes.editor.ingredients.hint', language)}</Text>
              </Box>
            ) : null}

            {addRecipeEditorMode === 'steps' ? (
              <Box flexDirection='column' marginTop={1} borderStyle='single' borderColor='yellow'>
                <Text color='yellow'>{t('recipes.editor.steps.title', language)}</Text>
                {stepEditorOffset > 0 ? (
                  <Text dimColor>{t('recipes.editor.steps.more', language)}</Text>
                ) : null}
                {visibleStepDrafts.map((step, index) => {
                  const absoluteIndex = stepEditorOffset + index;
                  const isSelected = absoluteIndex === selectedStepDraftIndex;
                  return (
                    <Box key={`step-draft-${absoluteIndex}`}>
                      <Text color={isSelected ? 'green' : 'white'}>{isSelected ? '> ' : '  '}</Text>
                      <Text>{absoluteIndex + 1}. </Text>
                      <Text color={isSelected ? 'green' : 'white'}>
                        {step || t('recipes.editor.steps.placeholder', language)}
                      </Text>
                    </Box>
                  );
                })}
                {stepEditorOffset + editorVisibleRows < stepDrafts.length ? (
                  <Text dimColor>{t('recipes.editor.steps.more', language)}</Text>
                ) : null}
                <Text dimColor>{t('recipes.editor.steps.hint', language)}</Text>
              </Box>
            ) : null}

            {addRecipeError ? <Text color='red'>{addRecipeError}</Text> : null}
          </Box>
        ) : null}

        {pendingDeleteRecipe ? (
          // Confirmation uses the same overlay behavior as the create form.
          <Box
            position='absolute'
            marginTop={modalTopOffset + 2}
            marginLeft={modalLeftOffset + 6}
            width={Math.max(42, Math.min(70, modalWidth - 8))}
            borderStyle='double'
            borderColor='red'
            paddingX={1}
            flexDirection='column'
            backgroundColor='black'
          >
            <Text color='red'>
              {t('recipes.deleteConfirm', language).replace('{name}', pendingDeleteRecipe.name)}
            </Text>
            <Text dimColor>{t('recipes.deleteHint', language)}</Text>
          </Box>
        ) : null}

        <Box height={1}>
          <Text color='dim'>{t('recipes.legend.label', language)} </Text>
          <Text color='red' dimColor>
            {t('recipes.legend.missingNotCovered', language)}
          </Text>
          <Text color='dim'> | </Text>
          <Text color='green' dimColor>
            {t('recipes.legend.missingCovered', language)}
          </Text>
        </Box>
      </Box>
    );
  }

  const isActiveRecipePlanned = plannedRecipesState.some((entry) => entry.id === activeRecipe.id);
  const isActiveRecipeFavorite = activeRecipe.categories.includes(favoriteCategory);

  // Show detail screen for the currently opened recipe
  return (
    <Box
      flexDirection='column'
      width={screenWidth}
      height={screenHeight}
      padding={1}
      paddingTop={0}
    >
      <Box alignItems='center' borderStyle='single' paddingLeft={1}>
        <Text dimColor>
          {t('recipes.detail.servings', language, { n: detailServings })} [+/-] |{' '}
          {t('recipes.detail.duration', language, { duration: activeRecipe.duration })} |{' '}
          {t('recipes.filter.difficulty', language)}:{' '}
          {t(`recipes.difficulty.${String(activeRecipe.difficulty || 'unknown')}`, language)} |{' '}
          {t('recipes.detail.favorite', language)}
        </Text>
        <Text
          color={isActiveRecipeFavorite ? 'yellow' : undefined}
          dimColor={!isActiveRecipeFavorite}
        >
          {isActiveRecipeFavorite ? '★' : '☆'}
        </Text>
        <Text dimColor> | </Text>
        <Text color={isActiveRecipePlanned ? 'green' : undefined} dimColor={!isActiveRecipePlanned}>
          [p]
        </Text>
        <Text dimColor>
          {' '}
          {isActiveRecipePlanned
            ? t('recipes.detail.addToPlanner.remove', language)
            : t('recipes.detail.addToPlanner.add', language)}
        </Text>
        <Text dimColor> {t('recipes.detail.markdownPdf', language)}</Text>
        {detailAllergenLegend ? <Text dimColor> | {detailAllergenLegend}</Text> : null}
      </Box>

      <Box height={1} paddingLeft={1}>
        {statusMessage ? <Text color='green'>{statusMessage}</Text> : null}
      </Box>

      <Box flexDirection='row' flexGrow={1} paddingLeft={1}>
        <Box
          flexDirection='column'
          width={Math.max(30, Math.min(60, Math.floor(screenWidth * 0.45)))}
        >
          <Text bold>{t('recipes.detail.ingredients', language)}</Text>

          {scaledIngredients.map((ing, idx) => {
            const normalized = String(ing.name || '')
              .trim()
              .toLowerCase();
            const missingItem = detailMissingMap.get(normalized);
            const listItem = todayListItems.find(
              (li) =>
                String(li.name || '')
                  .trim()
                  .toLowerCase() === normalized,
            );

            const isMissing = Boolean(missingItem);
            const covered = missingItem
              ? isMissingCoveredByShoppingList([missingItem], todayListItems)
              : false;

            const onListSuffix = isMissing
              ? missingItem && missingItem.onListCount !== undefined
                ? ` (${formatAmount(Number(missingItem.onListCount))} ${t('recipes.onList', language)})`
                : listItem
                  ? ` (${formatAmount(Number(listItem.quantity ?? 0))} ${t('recipes.onList', language)})`
                  : ''
              : '';

            const allergenSuffix = detailIngredientWarnings.get(normalized);

            return (
              <Box key={idx} flexDirection='row'>
                <Text
                  wrap='wrap'
                  color={isMissing ? (covered ? 'green' : 'red') : undefined}
                  dimColor={isMissing}
                >
                  {formatAmount(ing.scaledAmount)} {ing.unit} {ing.name}
                  {onListSuffix}
                </Text>
                {allergenSuffix ? (
                  <Text color='red' dimColor>
                    {' '}
                    {allergenSuffix}
                  </Text>
                ) : null}
              </Box>
            );
          })}

          {scaledIngredients.some((ing) =>
            isIngredientMissing(ing.name, ing.scaledAmount, ing.unit),
          ) ? (
            <Box marginTop={1}>
              <Text dimColor color='yellow'>
                {t('recipes.addToShoppingList', language)}
              </Text>
            </Box>
          ) : null}
        </Box>

        <Box flexDirection='column' flexGrow={1} marginLeft={1}>
          <Text bold>{t('recipes.detail.preparation', language)}</Text>
          {activeRecipe.steps.map((step, idx) => (
            <Text key={idx} wrap='wrap'>
              {idx + 1}. {step}
            </Text>
          ))}
        </Box>
      </Box>

      <Box height={1}>
        <Text color='dim'>{t('recipes.legend.label', language)} </Text>
        <Text color='red' dimColor>
          {t('recipes.legend.missingNotCovered', language)}
        </Text>
        <Text color='dim'> | </Text>
        <Text color='green' dimColor>
          {t('recipes.legend.missingCovered', language)}
        </Text>
      </Box>
      <Box height={1} marginTop={1}>
        <Text dimColor>{t('recipes.backHint', language)}</Text>
      </Box>
    </Box>
  );
};
