import { syncRecipeDietsFromIngredients, getAllRecipes } from '../db/recipesRepo';
import { toViewRecipe } from '../screens/recipesViewModel';
import { applyRecipeFilters } from '../screens/recipesViewFilters';

function printList(title: string, list: { name: string; diets: string[] }[]) {
  console.log(title);
  for (const r of list) {
    console.log(`- ${r.name} [${(r.diets || []).join(', ')}]`);
  }
}

function main() {
  try {
    // Ensure diets are backfilled
    syncRecipeDietsFromIngredients();

    const all = getAllRecipes().map(toViewRecipe);
    printList(
      'All recipes and diets:',
      all.map((r) => ({ name: r.name, diets: r.diets })),
    );

    const filtered = applyRecipeFilters(all, {
      searchQuery: '',
      selectedDifficulty: 'all',
      selectedHabit: 'all',
      selectedDiet: 'lactose-free',
      selectedCategory: 'all',
      allOption: 'all',
    });

    printList(
      '\nFiltered (lactose-free):',
      filtered.map((r) => ({ name: r.name, diets: r.diets })),
    );

    const found = filtered.some((r) => r.name.toLowerCase().includes('baked potatoes'));
    console.log(`\nBaked Potatoes present in lactose-free filter: ${found}`);
  } catch (err) {
    console.error('Error during verification:', err);
    process.exit(1);
  }
}

main();
