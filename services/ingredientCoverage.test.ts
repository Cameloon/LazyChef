import { describe, expect, it } from 'bun:test';
import {
  areSimilarItemNames,
  computeAggregateMissingWithShoppingList,
  computeMissingForIngredients,
  formatAmount,
  isIngredientMissing,
  isMissingCoveredByShoppingList,
  roundUpAmountForUnit,
} from './ingredientCoverage';

describe('ingredientCoverage', () => {
  describe('basic helpers', () => {
    it('formats decimal amounts compactly', () => {
      expect(formatAmount(2)).toBe('2');
      expect(formatAmount(2.5)).toBe('2.5');
      expect(formatAmount(2.125)).toBe('2.13');
    });

    it('rounds up based on unit', () => {
      expect(roundUpAmountForUnit(26, 'g')).toBe(50);
      expect(roundUpAmountForUnit(251, 'ml')).toBe(275);
      expect(roundUpAmountForUnit(1.26, 'pcs')).toBe(1.5);
    });

    it('matches similar item names with stop words removed', () => {
      expect(areSimilarItemNames('Bio Frische Milch', 'Milch')).toBe(true);
      expect(areSimilarItemNames('Vollkornbrot', 'Milch')).toBe(false);
    });
  });

  describe('computeMissingForIngredients', () => {
    it('computes missing amounts and on-list counts', () => {
      const result = computeMissingForIngredients({
        ingredients: [{ name: 'Tomato', amount: 2, unit: 'pcs' }],
        inventoryItems: [{ name: 'Tomato', quantity: 1, unit: 'pcs' }],
        shoppingListItems: [{ name: 'Tomato', quantity: 1, unit: 'pcs' }],
        targetServings: 1,
        baseServings: 1,
      });

      expect(result.length).toBe(1);
      expect(result[0]?.missingAmount).toBe(1);
      expect(result[0]?.onListCount).toBe(1);
    });

    it('supports fuzzy matching for shopping list coverage when enabled', () => {
      const result = computeMissingForIngredients({
        ingredients: [{ name: 'Romaine lettuce', amount: 2, unit: 'pcs' }],
        inventoryItems: [],
        shoppingListItems: [{ name: 'Romaine lettuce hearts', quantity: 3, unit: 'pcs' }],
        targetServings: 1,
        baseServings: 1,
        useSimilarNameForOnListCount: true,
      });

      expect(result.length).toBe(1);
      expect(result[0]?.onListCount).toBe(3);
    });

    it('converts compatible units for inventory and shopping-list coverage', () => {
      const result = computeMissingForIngredients({
        ingredients: [{ name: 'Milk', amount: 1500, unit: 'ml' }],
        inventoryItems: [{ name: 'Milk', quantity: 1, unit: 'L' }],
        shoppingListItems: [
          { name: 'Milk', quantity: 0.25, unit: 'L' },
          { name: 'Milk', quantity: 250, unit: 'ml' },
        ],
        targetServings: 1,
        baseServings: 1,
      });

      expect(result.length).toBe(1);
      expect(result[0]?.missingAmount).toBe(500);
      expect(result[0]?.onListCount).toBe(500);
    });

    it('supports tablespoon aliases like tblspn in conversion checks', () => {
      const result = computeMissingForIngredients({
        ingredients: [{ name: 'Olive oil', amount: 45, unit: 'ml' }],
        inventoryItems: [{ name: 'Olive oil', quantity: 1, unit: 'tblspn' }],
        shoppingListItems: [{ name: 'Olive oil', quantity: 1, unit: 'tbsp' }],
        targetServings: 1,
        baseServings: 1,
      });

      expect(result.length).toBe(1);
      expect(result[0]?.missingAmount).toBe(50);
      expect(result[0]?.onListCount).toBe(15);
    });

    it('ignores invalid ingredient rows and keeps processing valid ones', () => {
      const result = computeMissingForIngredients({
        ingredients: [
          { name: '', amount: 10, unit: 'g' },
          { name: 'Salt', amount: 0, unit: 'g' },
          { name: 'Pepper', amount: 1, unit: 'g' },
        ],
        inventoryItems: [{ name: 'Salt', quantity: 100, unit: 'g' }],
        shoppingListItems: [],
        targetServings: 1,
        baseServings: 1,
      });

      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Pepper');
    });
  });

  describe('coverage checks', () => {
    it('detects when all missing items are covered by shopping list', () => {
      const missingItems = [
        { name: 'Onion', unit: 'pcs', missingAmount: 2, neededAmount: 2, label: '2 pcs Onion' },
        { name: 'Milk', unit: 'ml', missingAmount: 250, neededAmount: 250, label: '250 ml Milk' },
      ];

      const covered = isMissingCoveredByShoppingList(missingItems, [
        { name: 'Onions', quantity: 2, unit: 'pcs' },
        { name: 'Milk', quantity: 300, unit: 'ml' },
      ]);

      const notCovered = isMissingCoveredByShoppingList(missingItems, [
        { name: 'Onion', quantity: 1, unit: 'pcs' },
        { name: 'Milk', quantity: 300, unit: 'ml' },
      ]);

      expect(covered).toBe(true);
      expect(notCovered).toBe(false);
    });

    it('checks inventory match with unit conversion behavior', () => {
      expect(
        isIngredientMissing('Flour', 200, 'g', [{ name: 'Flour', quantity: 1000, unit: 'g' }]),
      ).toBe(false);

      expect(
        isIngredientMissing('Flour', 200, 'g', [{ name: 'Flour', quantity: 100, unit: 'g' }]),
      ).toBe(true);

      expect(
        isIngredientMissing('Flour', 200, 'g', [{ name: 'Flour', quantity: 1, unit: 'kg' }]),
      ).toBe(false);

      expect(
        isIngredientMissing('Flour', 200, 'g', [{ name: 'Flour', quantity: 1, unit: 'l' }]),
      ).toBe(true);
    });
  });

  describe('computeAggregateMissingWithShoppingList', () => {
    it('aggregates similar ingredient names, applies rounding and subtracts on-list amounts', () => {
      const result = computeAggregateMissingWithShoppingList({
        ingredientNeeds: [
          { name: 'Flour', amount: 120, unit: 'g' },
          { name: 'Bio Flour', amount: 40, unit: 'g' },
        ],
        inventoryItems: [{ name: 'Flour', quantity: 50, unit: 'g' }],
        shoppingListItems: [{ name: 'Flour', quantity: 50, unit: 'g' }],
      });

      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Flour');
      expect(result[0]?.neededAmount).toBe(175);
      expect(result[0]?.missingAmount).toBe(75);
    });

    it('uses compatible unit conversions in aggregate checks', () => {
      const result = computeAggregateMissingWithShoppingList({
        ingredientNeeds: [{ name: 'Olive oil', amount: 500, unit: 'ml' }],
        inventoryItems: [{ name: 'Olive oil', quantity: 2, unit: 'L' }],
        shoppingListItems: [],
      });

      expect(result.length).toBe(0);
    });

    it('skips empty and non-positive aggregate rows', () => {
      const result = computeAggregateMissingWithShoppingList({
        ingredientNeeds: [
          { name: '', amount: 10, unit: 'g' },
          { name: 'Sugar', amount: 0, unit: 'g' },
          { name: 'Sugar', amount: -5, unit: 'g' },
        ],
        inventoryItems: [],
        shoppingListItems: [],
      });

      expect(result.length).toBe(0);
    });
  });
});
