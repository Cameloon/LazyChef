import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { inventory, inventoryMovements, itemAliases } from './schema';

// ── Types ──────────────────────────────────────────────────────────────

export type InventoryItemInput = {
  name: string;
  quantity: number;
  unit: string;
  category?: string | null;
};

export type InventorySnapshotItem = {
  name: string;
  quantity: number;
  unit: string;
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

const areSimilarItemNames = (a: string, b: string): boolean => {
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
    if (setB.has(token)) overlap++;
  }

  // We intentionally require full token containment in at least one direction
  // (e.g. "Bio Milch" matches "Milch") to reduce false-positive merges.
  return overlap > 0 && (overlap === setA.size || overlap === setB.size);
};

const logInventoryMovement = (input: {
  itemName: string;
  delta: number;
  unit: string;
  eventType?: string;
}): void => {
  if (!Number.isFinite(input.delta) || input.delta === 0) return;

  db.insert(inventoryMovements)
    .values({
      itemName: input.itemName,
      delta: input.delta,
      unit: input.unit,
      eventType: input.eventType ?? 'purchase',
      createdAt: new Date().toISOString(),
    })
    .run();
};

// ── Alias resolution ───────────────────────────────────────────────────

/** Look up `itemAliases` to resolve a scanned receipt name to its canonical
 *  inventory name.  Returns the `targetName` if a mapping exists, otherwise
 *  returns the original name unchanged. */
export const resolveAlias = (scannedName: string): string => {
  const row = db
    .select({ targetName: itemAliases.targetName })
    .from(itemAliases)
    .where(eq(itemAliases.scannedName, scannedName))
    .get();
  return row?.targetName ?? scannedName;
};

// ── Upsert ─────────────────────────────────────────────────────────────

/** Add a bought item to inventory.  If an item with the same name already
 *  exists the quantity is **increased** by the given amount; otherwise a
 *  new row is inserted. */
export const addOrUpdateInventoryItem = (input: InventoryItemInput): void => {
  const resolvedName = resolveAlias(input.name.trim());
  const normalizedUnit = input.unit.toLowerCase();
  const exactMatch = db.select().from(inventory).where(eq(inventory.name, resolvedName)).get();

  if (exactMatch) {
    db.update(inventory)
      .set({ quantity: exactMatch.quantity + input.quantity })
      .where(eq(inventory.id, exactMatch.id))
      .run();

    logInventoryMovement({
      itemName: resolvedName,
      delta: input.quantity,
      unit: input.unit,
    });
    return;
  }

  const sameUnitRows = db
    .select()
    .from(inventory)
    .where(sql`lower(${inventory.unit}) = ${normalizedUnit}`)
    .all();
  const similarMatch = sameUnitRows.find((row) => areSimilarItemNames(row.name, resolvedName));
  const existing = similarMatch;

  if (existing) {
    db.update(inventory)
      .set({ quantity: existing.quantity + input.quantity })
      .where(eq(inventory.id, existing.id))
      .run();
  } else {
    db.insert(inventory)
      .values({
        name: resolvedName,
        quantity: input.quantity,
        unit: input.unit,
        category: input.category ?? null,
      })
      .run();
  }

  logInventoryMovement({
    itemName: resolvedName,
    delta: input.quantity,
    unit: input.unit,
  });
};

// ── Batch helpers ──────────────────────────────────────────────────────

/** Move multiple shopping-list items into inventory in one go. */
export const addItemsToInventory = (items: InventoryItemInput[]): number => {
  let count = 0;
  for (const item of items) {
    addOrUpdateInventoryItem(item);
    count++;
  }
  return count;
};

/** Return current inventory entries for downstream consumers (e.g. receipt AI context). */
export const getInventorySnapshot = (): InventorySnapshotItem[] =>
  db
    .select({ name: inventory.name, quantity: inventory.quantity, unit: inventory.unit })
    .from(inventory)
    .all();

// ── Receipt parsing ────────────────────────────────────────────────────

/** Parse a single receipt line into an inventory item input.
 *
 *  Accepted formats (flexible):
 *    "2 kg Flour"          → { quantity: 2, unit: "kg", name: "Flour" }
 *    "3x Milk"             → { quantity: 3, unit: "pcs", name: "Milk" }
 *    "Butter"              → { quantity: 1, unit: "pcs", name: "Butter" }
 *
 *  Unknown names are resolved via `itemAliases`. */
export const parseReceiptLine = (line: string): InventoryItemInput | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const KNOWN_UNITS = ['pcs', 'kg', 'g', 'L', 'ml', 'Stk', 'Pkg', 'Bund'];

  // Pattern: <quantity> [x]? <unit>? <name>
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*x?\s*(pcs|kg|g|L|ml|Stk|Pkg|Bund)?\s+(.+)$/i);

  if (match) {
    const qty = parseFloat(match[1] ?? '0');
    const rawUnit = match[2] ?? 'pcs';
    // Preserve canonical casing for known units
    const unit = KNOWN_UNITS.find((u) => u.toLowerCase() === rawUnit.toLowerCase()) ?? rawUnit;
    const resolvedName = resolveAlias((match[3] ?? '').trim());
    return { quantity: qty, unit, name: resolvedName };
  }

  // Fallback: entire line is the item name, quantity 1
  const resolvedName = resolveAlias(trimmed);
  return { quantity: 1, unit: 'pcs', name: resolvedName };
};

/** Parse multiple receipt lines and add them all to inventory.
 *  Returns the count of items successfully added. */
export const processReceiptText = (text: string): number => {
  const lines = text.split('\n');
  const items: InventoryItemInput[] = [];

  for (const line of lines) {
    const parsed = parseReceiptLine(line);
    if (parsed) items.push(parsed);
  }

  return addItemsToInventory(items);
};
