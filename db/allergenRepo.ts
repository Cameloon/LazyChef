import { eq } from 'drizzle-orm';
import { db } from './db';
import { allergens } from './schema';
import OpenAI from 'openai';

export type AllergenInfo = {
  hasLactose: boolean;
  hasGluten: boolean;
};

/**
 * Get allergen information for an ingredient.
 * First checks the local cache, then queries OpenAI API if not found.
 * Caches the result for future lookups.
 */
export const getAllergenInfo = async (ingredientName: string): Promise<AllergenInfo> => {
  const normalizedName = ingredientName.toLowerCase().trim();

  // 1. Check local cache
  const cached = db
    .select()
    .from(allergens)
    .where(eq(allergens.ingredientName, normalizedName))
    .get();

  if (cached) {
    return {
      hasLactose: cached.hasLactose === 1,
      hasGluten: cached.hasGluten === 1,
    };
  }

  // 2. Not in cache - query OpenAI API
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('OPENAI_API_KEY is not set - returning default (no allergens)');
    return { hasLactose: false, hasGluten: false };
  }

  const openai = new OpenAI({ apiKey });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `Answer ONLY with valid JSON (no other text before or after). 
Does the ingredient "${ingredientName}" typically contain lactose or gluten? 
Important: Consider milk products for lactose, wheat/barley/rye for gluten.
Respond with: {"hasLactose": boolean, "hasGluten": boolean}`,
        },
      ],
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content || '{}';

    // Parse JSON response - handle potential markdown code blocks
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const result: AllergenInfo = JSON.parse(jsonStr);

    // 3. Cache the result in DB
    db.insert(allergens)
      .values({
        ingredientName: normalizedName,
        hasLactose: result.hasLactose ? 1 : 0,
        hasGluten: result.hasGluten ? 1 : 0,
        lastChecked: Date.now(),
      })
      .run();

    return result;
  } catch (error) {
    console.error('Error fetching allergen info from OpenAI:', error);
    return { hasLactose: false, hasGluten: false };
  }
};

/**
 * Check multiple ingredients at once.
 * Sequential queries to avoid rate limiting.
 */
export const bulkCheckAllergens = async (
  ingredientNames: string[],
): Promise<Map<string, AllergenInfo>> => {
  const result = new Map<string, AllergenInfo>();

  for (const name of ingredientNames) {
    result.set(name, await getAllergenInfo(name));
  }

  return result;
};

/**
 * Check if an ingredient matches user's intolerances
 */
export const hasAllergenConflict = (
  allergenInfo: AllergenInfo,
  userIntolerances: string,
): boolean => {
  if (userIntolerances === 'none') return false;

  const hasConflict =
    (userIntolerances.includes('lactose') && allergenInfo.hasLactose) ||
    (userIntolerances.includes('gluten') && allergenInfo.hasGluten);

  return hasConflict;
};
