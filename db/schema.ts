import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// Generalized items
export const inventory = sqliteTable('inventory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category'), // Optional: if specifically tracking one category
  emoji: text('emoji'),
  quantity: real('quantity').notNull().default(0),
  unit: text('unit').notNull().default('pcs'), // ml, L, g, kg, Stk, Pkg etc.
});

export const inventoryMovements = sqliteTable('inventory_movements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemName: text('item_name').notNull(),
  delta: real('delta').notNull(),
  unit: text('unit').notNull().default('pcs'),
  eventType: text('event_type').notNull().default('purchase'),
  createdAt: text('created_at').notNull(),
});

// Mapping for later Receipt Scanner (e.g., "Oatly Barista" -> "Milk")
export const itemAliases = sqliteTable('item_aliases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scannedName: text('scanned_name').notNull().unique(),
  targetName: text('target_name').notNull(), // Links to inventory.name
});

//for recipes
export const recipes = sqliteTable('recipes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  servings: integer('servings'),
  duration: integer('duration'),
  difficulty: text('difficulty'),
  // JSON array string, e.g. ["all","vegan"]
  habits: text('habits'),
  // JSON array string, e.g. ["standard","lactose-free"]
  diets: text('diets'),
  // JSON array string, e.g. ["breakfast","dinner"]
  categories: text('categories'),
  // Legacy JSON/text fields kept for backward compatibility with existing screens
  ingredients: text('ingredients'),
  instructions: text('instructions'),
});

// Normalized recipe ingredients for structured filtering and editing
export const recipeIngredients = sqliteTable('recipe_ingredients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recipeId: integer('recipe_id')
    .notNull()
    // Delete child rows automatically when a recipe is removed
    .references(() => recipes.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  amount: real('amount').notNull(),
  unit: text('unit').notNull(),
  name: text('name').notNull(),
});

// Steps are stored as ordered rows instead of a single text blob
export const recipeSteps = sqliteTable('recipe_steps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recipeId: integer('recipe_id')
    .notNull()
    // Cascade keeps data consistent without manual cleanup queries
    .references(() => recipes.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  stepText: text('step_text').notNull(),
});

// Shopping lists allow users to compile and persist grocery items
export const shoppingLists = sqliteTable('shopping_lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(), // ISO-8601 timestamp
});

// Individual items within a shopping list
export const shoppingListItems = sqliteTable('shopping_list_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  listId: integer('list_id')
    .notNull()
    .references(() => shoppingLists.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  quantity: real('quantity').notNull().default(1),
  unit: text('unit').notNull().default('pcs'),
});

export const plannerGenerations = sqliteTable('planner_generations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: text('created_at').notNull(), // ISO timestamp
  days: integer('days').notNull(),
  diet: text('diet').notNull(),
  generationMode: text('generation_mode').notNull(), // db | ai | mixed | self-planned | stock
  sourceScreen: text('source_screen').notNull().default('planner'),
});

// Persisted recipe planner entries from RecipesView
export const plannedRecipeEntries = sqliteTable('planned_recipe_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  position: integer('position').notNull(),
  recipeId: integer('recipe_id')
    .notNull()
    .references(() => recipes.id, { onDelete: 'cascade' }),
  servings: integer('servings').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const plannerGenerationMeals = sqliteTable('planner_generation_meals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  generationId: integer('generation_id')
    .notNull()
    .references(() => plannerGenerations.id, { onDelete: 'cascade' }),
  dayNumber: integer('day_number').notNull(),
  mealIndex: integer('meal_index').notNull(), // 0 breakfast, 1 lunch, 2 dinner
  mealType: text('meal_type').notNull(),
  name: text('name').notNull(),
  time: text('time').notNull(),
  missing: text('missing').notNull().default('[]'), // JSON string
  diet: text('diet'),
  source: text('source'), // ai | manual | db | mixed | self-planned | stock
  locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
  recipeTitle: text('recipe_title'),
});

// Global app preferences (single-row settings profile for now)
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  intolerances: text('intolerances').notNull().default('none'),
  lactoseIntolerance: integer('lactose_intolerance').notNull().default(0),
  glutenIntolerance: integer('gluten_intolerance').notNull().default(0),
  eatingHabit: text('eating_habit').notNull().default('all'),
  defaultServings: integer('default_servings').notNull().default(1),
  language: text('language').notNull().default('en'),
});

// Allergen information cache for ingredients
export const allergens = sqliteTable('allergens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ingredientName: text('ingredient_name').notNull().unique(),
  hasLactose: integer('has_lactose').notNull().default(0),
  hasGluten: integer('has_gluten').notNull().default(0),
  lastChecked: integer('last_checked').notNull(), // timestamp
});
