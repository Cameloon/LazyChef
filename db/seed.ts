import { db } from './db';
import { inventory } from './schema';
import { eq, sql } from 'drizzle-orm';
import { recipes as staticRecipes } from '../recipes';
import { createRecipe, recipeExistsByTitle, syncRecipeDietsFromIngredients } from './recipesRepo';
import { recipes as recipesTable } from './schema';

const baseItems = [
  { name: 'flour', category: 'Essentials', quantity: 2, unit: 'kg' },
  { name: 'milk', category: 'Liquid', quantity: 12, unit: 'L' },
  { name: 'beer', category: 'Alcohol', quantity: 20, unit: 'pcs' },
  { name: 'sugar', category: 'Essentials', quantity: 5, unit: 'kg' },
  { name: 'oat milk', category: 'Liquid', quantity: 6, unit: 'L' },
  { name: 'rice', category: 'Essentials', quantity: 3, unit: 'kg' },
  { name: 'gin', category: 'Alcohol', quantity: 1, unit: 'pcs' },
  { name: 'olive oil', category: 'Liquid', quantity: 2, unit: 'L' },
  { name: 'eggs', category: 'Essentials', quantity: 10, unit: 'pcs' },
  { name: 'spaghetti', category: 'Essentials', quantity: 4, unit: 'pkg' },
  { name: 'tomatoes', category: 'Essentials', quantity: 6, unit: 'pcs' },
  { name: 'wine', category: 'Alcohol', quantity: 3, unit: 'pcs' },
  { name: 'water', category: 'Liquid', quantity: 12, unit: 'L' },
  { name: 'coffee beans', category: 'Essentials', quantity: 2, unit: 'kg' },
  { name: 'butter', category: 'Essentials', quantity: 3, unit: 'pcs' },
];

const itemsToInsert = baseItems.map((item) => ({
  ...item,
  quantity: Math.floor(Math.random() * 15) + 1,
}));

export async function runSeed() {
  let insertedInventoryCount = 0;
  let insertedRecipeCount = 0;

  for (const item of itemsToInsert) {
    // check if name already exists
    const existing = db
      .select()
      .from(inventory)
      .where(sql`${inventory.name} = ${item.name}`)
      .get();

    if (!existing) {
      db.insert(inventory).values(item).run();
      insertedInventoryCount++;
    }
  }

  for (const recipe of staticRecipes) {
    // Use recipe title as idempotency key for initial migration from static data
    if (recipeExistsByTitle(recipe.name)) {
      // Backfill tags for already existing recipes after schema changes
      db.update(recipesTable)
        .set({
          habits: JSON.stringify(recipe.habits),
          categories: JSON.stringify(recipe.categories),
        })
        .where(eq(recipesTable.title, recipe.name))
        .run();
      continue;
    }

    createRecipe({
      title: recipe.name,
      servings: recipe.servings,
      duration: recipe.duration,
      difficulty: recipe.difficulty,
      habits: recipe.habits,
      categories: recipe.categories,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
    });

    insertedRecipeCount++;
  }

  // Keep diets in sync after seeding/backfilling recipe rows.
  syncRecipeDietsFromIngredients();

  console.log(`Seeding erfolgreich! ${insertedInventoryCount} neue Inventory-Items hinzugefügt.`);
  console.log(`Seeding erfolgreich! ${insertedRecipeCount} neue Rezepte hinzugefügt.`);
}
