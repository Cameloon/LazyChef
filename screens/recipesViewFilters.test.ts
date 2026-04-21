import { describe, expect, it } from 'bun:test';
import {
  applyRecipeFilters,
  getNextCycledFilterValue,
  type FilterableRecipe,
} from './recipesViewFilters';

const recipes: FilterableRecipe[] = [
  {
    name: 'Spaghetti Bolognese',
    difficulty: 'easy',
    habits: ['all'],
    diets: ['standard'],
    categories: ['dinner'],
  },
  {
    name: 'Tomato Soup',
    difficulty: '',
    habits: ['vegan'],
    diets: ['standard'],
    categories: ['lunch'],
  },
  {
    name: 'Pancakes',
    difficulty: 'medium',
    habits: ['vegetarian'],
    diets: ['standard'],
    categories: ['breakfast'],
  },
];

describe('recipesViewFilters', () => {
  it('filters recipes by case-insensitive search query', () => {
    // Search should ignore casing so keyboard filtering feels natural
    const filtered = applyRecipeFilters(recipes, {
      searchQuery: 'toMAto',
      selectedDifficulty: 'all',
      selectedDiet: 'all',
      selectedHabit: 'all',
      selectedCategory: 'all',
      allOption: 'all',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe('Tomato Soup');
  });

  it('treats empty difficulty as unknown for filtering', () => {
    // Empty difficulty values from persisted data should match unknown
    const filtered = applyRecipeFilters(recipes, {
      searchQuery: '',
      selectedDifficulty: 'unknown',
      selectedDiet: 'all',
      selectedHabit: 'all',
      selectedCategory: 'all',
      allOption: 'all',
    });

    expect(filtered.map((recipe) => recipe.name)).toEqual(['Tomato Soup']);
  });

  it('combines habit and category filters', () => {
    // Multiple active filters should reduce the result set to intersection matches
    const filtered = applyRecipeFilters(recipes, {
      searchQuery: '',
      selectedDifficulty: 'all',
      selectedDiet: 'all',
      selectedHabit: 'vegetarian',
      selectedCategory: 'breakfast',
      allOption: 'all',
    });

    expect(filtered.map((recipe) => recipe.name)).toEqual(['Pancakes']);
  });

  it('cycles through options and wraps to start', () => {
    // Filter cycling should loop at the end for repeated key presses
    const options = ['all', 'easy', 'medium'];

    expect(getNextCycledFilterValue(options, 'all')).toBe('easy');
    expect(getNextCycledFilterValue(options, 'medium')).toBe('all');
  });

  it('falls back to first option when current value is missing', () => {
    // Unexpected state should recover to a valid selectable value
    expect(getNextCycledFilterValue(['all', 'vegan'], 'keto')).toBe('all');
  });
});
