import { asc, eq } from 'drizzle-orm';
import { db } from './db';
import { inventory, shoppingListItems, shoppingLists } from './schema';

// ── Types ──────────────────────────────────────────────────────────────

export type ShoppingListRow = typeof shoppingLists.$inferSelect;
export type ShoppingListItemRow = typeof shoppingListItems.$inferSelect;

export type ShoppingListItemInput = {
  name: string;
  quantity: number;
  unit: string;
};

export type ShoppingListAggregate = ShoppingListRow & {
  items: ShoppingListItemRow[];
};

// ── Reads ──────────────────────────────────────────────────────────────

export const getAllShoppingLists = (): ShoppingListRow[] =>
  db.select().from(shoppingLists).orderBy(asc(shoppingLists.id)).all();

export const getShoppingListById = (id: number): ShoppingListAggregate | null => {
  const row = db.select().from(shoppingLists).where(eq(shoppingLists.id, id)).get();
  if (!row) return null;

  const items = db
    .select()
    .from(shoppingListItems)
    .where(eq(shoppingListItems.listId, id))
    .orderBy(asc(shoppingListItems.id))
    .all();

  return { ...row, items };
};

// ── Generation ─────────────────────────────────────────────────────────

/** Collect "essentials" items that are at zero stock – the only concrete low-stock
 *  signal available given the current inventory schema (no threshold column). */
const getLowStockItems = (): ShoppingListItemInput[] => {
  const rows = db.select().from(inventory).all();
  return rows
    .filter((r) => {
      if (r.quantity > 0) return false;
      if (r.category == null) return false;
      return r.category.toLowerCase() === 'essentials';
    })
    .map((r) => ({ name: r.name, quantity: 1, unit: r.unit }));
};

/** Create a new shopping list populated with auto-detected items. */
export const generateShoppingList = (): number => {
  const items = getLowStockItems();
  const name = `Shopping List ${new Date().toLocaleDateString()}`;

  return db.transaction((tx) => {
    const inserted = tx
      .insert(shoppingLists)
      .values({ name, createdAt: new Date().toISOString() })
      .returning({ id: shoppingLists.id })
      .get();

    for (const item of items) {
      tx.insert(shoppingListItems)
        .values({ listId: inserted.id, name: item.name, quantity: item.quantity, unit: item.unit })
        .run();
    }

    return inserted.id;
  });
};

// ── Writes (CRUD) ──────────────────────────────────────────────────────

export const createShoppingList = (name: string): number => {
  const row = db
    .insert(shoppingLists)
    .values({ name, createdAt: new Date().toISOString() })
    .returning({ id: shoppingLists.id })
    .get();
  return row.id;
};

export const deleteShoppingList = (id: number): void => {
  db.delete(shoppingLists).where(eq(shoppingLists.id, id)).run();
};

export const addItemToList = (listId: number, input: ShoppingListItemInput): number => {
  const row = db
    .insert(shoppingListItems)
    .values({ listId, name: input.name, quantity: input.quantity, unit: input.unit })
    .returning({ id: shoppingListItems.id })
    .get();
  return row.id;
};

export const updateListItem = (itemId: number, input: Partial<ShoppingListItemInput>): void => {
  db.update(shoppingListItems).set(input).where(eq(shoppingListItems.id, itemId)).run();
};

export const deleteListItem = (itemId: number): void => {
  db.delete(shoppingListItems).where(eq(shoppingListItems.id, itemId)).run();
};
