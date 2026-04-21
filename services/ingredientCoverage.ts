import { convertAmount, normalizeUnit } from './unitConversion';

export type IngredientAmountLike = {
  name: string;
  amount?: number;
  unit?: string;
};

export type InventoryItemLike = {
  name: string;
  quantity?: number;
  unit?: string;
};

export type ShoppingListItemLike = {
  name: string;
  quantity?: number;
  unit?: string;
};

export type MissingItem = {
  label: string;
  name: string;
  neededAmount: number;
  missingAmount: number;
  unit: string;
  onListCount?: number;
};

const NAME_STOP_WORDS = new Set([
  'bio',
  'frisch',
  'frische',
  'extra',
  'beste',
  'wahl',
  'premium',
  'hausmarke',
  'der',
  'die',
  'das',
]);

const MIN_SUBSTRING_MATCH_LENGTH = 5;

const normalizeName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokenizeName = (name: string): string[] =>
  normalizeName(name)
    .split(' ')
    .filter((token) => token.length > 1 && !NAME_STOP_WORDS.has(token));

export const formatAmount = (amount: number): string => {
  if (Number.isInteger(amount)) return String(amount);
  return amount.toFixed(2).replace(/\.?0+$/, '');
};

export const areSimilarItemNames = (a: string, b: string): boolean => {
  const normalizedA = normalizeName(a);
  const normalizedB = normalizeName(b);

  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;

  if (
    normalizedA.length >= MIN_SUBSTRING_MATCH_LENGTH &&
    normalizedB.length >= MIN_SUBSTRING_MATCH_LENGTH
  ) {
    if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;
  }

  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let overlap = 0;

  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }

  return overlap > 0 && (overlap === setA.size || overlap === setB.size);
};

export const roundUpAmountForUnit = (amount: number, unit: string): number => {
  const unitLower = String(unit || '').toLowerCase();
  if (unitLower === 'g' || unitLower === 'ml') {
    return Math.ceil((amount - Number.EPSILON) / 25) * 25;
  }

  return Math.ceil((amount - Number.EPSILON) * 4) / 4;
};

type ComputeMissingParams = {
  ingredients: IngredientAmountLike[];
  inventoryItems: InventoryItemLike[];
  shoppingListItems?: ShoppingListItemLike[];
  targetServings: number;
  baseServings: number;
  useSimilarNameForOnListCount?: boolean;
};

export const computeMissingForIngredients = ({
  ingredients,
  inventoryItems,
  shoppingListItems = [],
  targetServings,
  baseServings,
  useSimilarNameForOnListCount = false,
}: ComputeMissingParams): MissingItem[] => {
  const missing: MissingItem[] = [];
  const safeBaseServings = baseServings > 0 ? baseServings : 1;
  const factor = targetServings > 0 ? targetServings / safeBaseServings : 1;

  for (const ingredient of ingredients) {
    const neededName = String(ingredient.name || '').trim();
    if (!neededName) continue;

    const neededRaw = (ingredient.amount ?? 0) * factor;
    const neededUnitRaw = String(ingredient.unit || 'pcs').trim() || 'pcs';
    const neededRounded = roundUpAmountForUnit(neededRaw, neededUnitRaw);

    const bestMatch = inventoryItems.find((row) => areSimilarItemNames(row.name, neededName));

    const invQty = Number(bestMatch?.quantity ?? 0);
    const invUnitRaw = String(bestMatch?.unit || '');
    const availableInNeededUnit = bestMatch
      ? convertAmount(invQty, invUnitRaw, neededUnitRaw)
      : null;

    let missingAmount = 0;
    if (!bestMatch) {
      missingAmount = neededRounded;
    } else if (availableInNeededUnit !== null) {
      missingAmount = Math.max(0, neededRounded - availableInNeededUnit);
    } else {
      missingAmount = neededRounded;
    }

    if (missingAmount <= 0) continue;

    missingAmount = roundUpAmountForUnit(missingAmount, neededUnitRaw);

    const onListCount = shoppingListItems
      .filter((row) => {
        const rowName = String(row.name || '');
        if (useSimilarNameForOnListCount) {
          return areSimilarItemNames(rowName, neededName);
        }

        return rowName.trim().toLowerCase() === neededName.trim().toLowerCase();
      })
      .reduce((sum, row) => {
        const rowQty = Number(row.quantity ?? 0);
        const converted = convertAmount(rowQty, String(row.unit || ''), neededUnitRaw);
        return sum + (converted ?? 0);
      }, 0);

    const label = bestMatch
      ? `${formatAmount(neededRounded)} ${neededUnitRaw} ${neededName} (have ${formatAmount(invQty)} ${bestMatch.unit})`
      : `${formatAmount(neededRounded)} ${neededUnitRaw} ${neededName}`;

    missing.push({
      label,
      name: neededName,
      neededAmount: neededRounded,
      missingAmount,
      unit: neededUnitRaw,
      onListCount: onListCount > 0 ? onListCount : undefined,
    });
  }

  return missing;
};

type AggregateMissingParams = {
  ingredientNeeds: IngredientAmountLike[];
  inventoryItems: InventoryItemLike[];
  shoppingListItems: ShoppingListItemLike[];
};

export const computeAggregateMissingWithShoppingList = ({
  ingredientNeeds,
  inventoryItems,
  shoppingListItems,
}: AggregateMissingParams): MissingItem[] => {
  type NeedRow = {
    name: string;
    unit: string;
    neededRaw: number;
  };

  const aggregated: NeedRow[] = [];

  for (const need of ingredientNeeds) {
    const name = String(need.name || '').trim();
    const unit = String(need.unit || '').trim();
    const neededRaw = Number(need.amount ?? 0);

    if (!name || !unit || neededRaw <= 0) continue;

    const unitLower = unit.toLowerCase();
    const existing = aggregated.find(
      (row) => row.unit.toLowerCase() === unitLower && areSimilarItemNames(row.name, name),
    );

    if (existing) {
      existing.neededRaw += neededRaw;
    } else {
      aggregated.push({ name, unit, neededRaw });
    }
  }

  const missingRows: MissingItem[] = [];

  for (const row of aggregated) {
    const neededRounded = roundUpAmountForUnit(row.neededRaw, row.unit);

    const bestMatch = inventoryItems.find((invRow) => areSimilarItemNames(invRow.name, row.name));
    const invQty = Number(bestMatch?.quantity ?? 0);
    const neededUnitRaw = String(row.unit || '');
    const availableInNeededUnit = bestMatch
      ? convertAmount(invQty, String(bestMatch?.unit || ''), neededUnitRaw)
      : null;

    let missingAmount = 0;
    if (!bestMatch) {
      missingAmount = neededRounded;
    } else if (availableInNeededUnit !== null) {
      missingAmount = Math.max(0, neededRounded - availableInNeededUnit);
    } else {
      missingAmount = neededRounded;
    }

    if (missingAmount <= 0) continue;

    const onListCount = shoppingListItems
      .filter((item) => areSimilarItemNames(String(item.name || ''), row.name))
      .reduce((sum, item) => {
        const converted = convertAmount(
          Number(item.quantity ?? 0),
          String(item.unit || ''),
          neededUnitRaw,
        );
        return sum + (converted ?? 0);
      }, 0);

    const roundedMissingAmount = roundUpAmountForUnit(missingAmount, row.unit);
    const remainingToListRaw = Math.max(0, roundedMissingAmount - onListCount);
    if (remainingToListRaw <= 0) continue;

    const remainingToList = roundUpAmountForUnit(remainingToListRaw, row.unit);
    const label = bestMatch
      ? `${formatAmount(remainingToList)} ${row.unit} ${row.name} (need ${formatAmount(neededRounded)}, have ${formatAmount(invQty)} ${bestMatch.unit})`
      : `${formatAmount(remainingToList)} ${row.unit} ${row.name} (need ${formatAmount(neededRounded)})`;

    missingRows.push({
      label,
      name: row.name,
      neededAmount: neededRounded,
      missingAmount: remainingToList,
      unit: row.unit,
      onListCount: onListCount > 0 ? onListCount : undefined,
    });
  }

  return missingRows.sort((a, b) => a.name.localeCompare(b.name));
};

export const isIngredientMissing = (
  name: string,
  requiredAmount: number,
  unit: string,
  inventoryItems: InventoryItemLike[],
): boolean => {
  const bestMatch = inventoryItems.find((row) => areSimilarItemNames(row.name, name));
  if (!bestMatch) return true;

  const invQty = Number(bestMatch.quantity ?? 0);
  const converted = convertAmount(invQty, String(bestMatch.unit || ''), unit);
  if (converted === null) return true;
  return converted < requiredAmount;
};

export const isMissingCoveredByShoppingList = (
  missingItems: MissingItem[],
  shoppingListItems: ShoppingListItemLike[],
): boolean => {
  if (missingItems.length === 0) return false;

  for (const missing of missingItems) {
    const neededUnitRaw = String(missing.unit || '');
    const onListCount = shoppingListItems
      .filter((row) => {
        return areSimilarItemNames(String(row.name || ''), missing.name);
      })
      .reduce((sum, row) => {
        const converted = convertAmount(
          Number(row.quantity ?? 0),
          String(row.unit || ''),
          neededUnitRaw,
        );
        return sum + (converted ?? 0);
      }, 0);

    if (onListCount < Number(missing.missingAmount ?? 0)) return false;
  }

  return true;
};
