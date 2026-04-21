import OpenAI from 'openai';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, extname } from 'path';
import {
  addItemsToInventory,
  getInventorySnapshot,
  type InventoryItemInput,
  type InventorySnapshotItem,
} from './inventoryRepo';
import { addItemToList, createShoppingList } from './shoppingListsRepo';
import { getOrCreateAppSettings } from './settingsRepo';

// ── Constants ──────────────────────────────────────────────────────────

const RECEIPTS_DIR = join(process.cwd(), 'receipts');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

// ── Helpers ────────────────────────────────────────────────────────────

export const categorizeScannedItemsAsEssentials = (
  items: InventoryItemInput[],
): InventoryItemInput[] => items.map((item) => ({ ...item, category: 'essentials' }));

export const buildInventoryContext = (inventorySnapshot: InventorySnapshotItem[]): string =>
  inventorySnapshot.length > 0
    ? `Current inventory (use for spelling/canonicalization hints and match to closest existing item when ambiguous, but still add new items if truly different): ${JSON.stringify(inventorySnapshot)}`
    : 'Current inventory is empty.';

export const getReceiptPromptLanguage = (): 'en' | 'de' => {
  const language = getOrCreateAppSettings().language;
  return language === 'de' ? 'de' : 'en';
};

export const buildReceiptSystemPrompt = (language: 'en' | 'de'): string =>
  [
    'You are a receipt parser. Extract grocery/food items from receipt images.',
    'For each item return a simplified generic name (remove brand names),',
    'a numeric quantity, and a unit.',
    'Return ONLY valid JSON: { "items": [ { "name": "Milk", "quantity": 2, "unit": "L" } ] }',
    'Allowed units: pcs, kg, g, L, ml, Stk, Pkg, Bund. Default to "pcs" with quantity 1 if unclear.',
    'Simplify branded names to plain items (e.g. "Oatly Barista 1L" → "Hafermilch").',
    'Use current inventory names as canonical references to avoid OCR/typo variants',
    '(e.g. Saflorangen/Saft orangen → Saftorangen, or Apples/Juice orange → Orange juice if it exists in inventory).',
    ...(language === 'en'
      ? [
          'Output item names in English only, even if receipt text or inventory context contains other languages.',
        ]
      : []),
    'Skip non-food entries, discounts, totals, taxes, and payment lines.',
  ].join(' ');

/** Find the most recently modified image file in the receipts directory. */
export const getLatestReceiptImage = (dir: string = RECEIPTS_DIR): string | null => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const imageFiles = entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .map((f) => {
      const fullPath = join(dir, f);
      return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return imageFiles[0]?.path ?? null;
};

/** Use OpenAI Vision to parse a receipt image into structured grocery items. */
export const parseReceiptImage = async (
  imagePath: string,
  inventorySnapshot?: InventorySnapshotItem[],
): Promise<InventoryItemInput[]> => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = extname(imagePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  const snapshot = inventorySnapshot ?? getInventorySnapshot();
  const inventoryContext = buildInventoryContext(snapshot);
  const promptLanguage = getReceiptPromptLanguage();

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: buildReceiptSystemPrompt(promptLanguage),
      },
      {
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: `Parse this receipt and extract all grocery items.\n${inventoryContext}`,
          },
          {
            type: 'image_url' as const,
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  try {
    const data = JSON.parse(content);
    return (data.items || [])
      .map((item: Record<string, unknown>) => ({
        name: String(item.name ?? '').trim(),
        quantity: Number(item.quantity) || 1,
        unit: String(item.unit ?? 'pcs').trim(),
      }))
      .filter((item: InventoryItemInput) => item.name.length > 0);
  } catch {
    return [];
  }
};

// ── Public API ─────────────────────────────────────────────────────────

/** Scan the latest receipt image and add parsed items to inventory.
 *  Returns the count of items added, or an error message on failure. */
export const scanLatestReceipt = async (
  receiptsDir: string = RECEIPTS_DIR,
): Promise<{
  count: number;
  error?: string;
}> => {
  const imagePath = getLatestReceiptImage(receiptsDir);
  if (!imagePath) {
    return { count: 0, error: 'No receipt images found in receipts/ folder' };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { count: 0, error: 'OPENAI_API_KEY environment variable is not set' };
  }

  try {
    const items = await parseReceiptImage(imagePath);
    if (items.length === 0) {
      return { count: 0, error: 'No items could be parsed from the receipt' };
    }
    const count = addItemsToInventory(categorizeScannedItemsAsEssentials(items));
    return { count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to scan receipt';
    return { count: 0, error: message };
  }
};

/** Scan latest receipt, add items to inventory and also create a shopping list from it. */
export const scanLatestReceiptToInventoryAndShoppingList = async (
  receiptsDir: string = RECEIPTS_DIR,
): Promise<{
  count: number;
  listId?: number;
  error?: string;
}> => {
  const imagePath = getLatestReceiptImage(receiptsDir);
  if (!imagePath) {
    return { count: 0, error: 'No receipt images found in receipts/ folder' };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { count: 0, error: 'OPENAI_API_KEY environment variable is not set' };
  }

  try {
    const items = await parseReceiptImage(imagePath);
    if (items.length === 0) {
      return { count: 0, error: 'No items could be parsed from the receipt' };
    }

    const categorizedItems = categorizeScannedItemsAsEssentials(items);
    const count = addItemsToInventory(categorizedItems);
    const listId = createShoppingList(`Receipt ${new Date().toISOString().slice(0, 10)}`);
    for (const item of categorizedItems) {
      addItemToList(listId, item);
    }

    return { count, listId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to scan receipt';
    return { count: 0, error: message };
  }
};
