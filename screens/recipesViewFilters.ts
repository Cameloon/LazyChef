export type FilterableRecipe = {
  name: string;
  difficulty: string;
  habits: string[];
  diets: string[];
  categories: string[];
};

export type RecipeFilterState = {
  searchQuery: string;
  selectedDifficulty: string;
  selectedHabit: string;
  selectedDiet: string;
  selectedCategory: string;
  allOption: string;
};

// Keep recipe list filtering predictable and case-insensitive
const normalizeValue = (value: string): string => value.trim().toLowerCase();

export const getNextCycledFilterValue = (options: string[], currentValue: string): string => {
  // Keep current selection when no options are available
  if (options.length === 0) return currentValue;

  const currentIndex = options.indexOf(currentValue);
  // Unknown current values jump back to the first option
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % options.length;

  return options[nextIndex] ?? currentValue;
};

export const applyRecipeFilters = <T extends FilterableRecipe>(
  recipes: T[],
  state: RecipeFilterState,
): T[] => {
  // Keep all comparisons normalized so filter matching stays predictable
  const normalizedQuery = normalizeValue(state.searchQuery);

  return recipes.filter((recipe) => {
    // Empty difficulty values from storage should behave like unknown
    const normalizedDifficulty = normalizeValue(recipe.difficulty) || 'unknown';
    const normalizedHabits = recipe.habits.map(normalizeValue);
    const normalizedDiets = (recipe.diets || []).map(normalizeValue);
    const normalizedCategories = recipe.categories.map(normalizeValue);
    const nameMatches = !normalizedQuery || normalizeValue(recipe.name).includes(normalizedQuery);
    const difficultyMatches =
      state.selectedDifficulty === state.allOption ||
      normalizedDifficulty === state.selectedDifficulty;
    const habitMatches =
      state.selectedHabit === state.allOption || normalizedHabits.includes(state.selectedHabit);
    const dietMatches =
      state.selectedDiet === state.allOption || normalizedDiets.includes(state.selectedDiet);
    const categoryMatches =
      state.selectedCategory === state.allOption ||
      normalizedCategories.includes(state.selectedCategory);

    return nameMatches && difficultyMatches && habitMatches && dietMatches && categoryMatches;
  });
};
