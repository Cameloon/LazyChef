export type DateSearchableShoppingList = {
  name: string;
  createdAt: string;
  id?: number;
};

export const getListSourceLabel = (
  name: string,
): 'Receipt' | 'Recipes Planner' | 'Planner' | 'Generated' | 'User' => {
  const lower = name.toLowerCase();
  if (lower.startsWith('receipt ')) return 'Receipt';
  if (lower.startsWith('recipes planner ')) return 'Recipes Planner';
  if (lower.startsWith('planner ')) return 'Planner';
  if (lower.startsWith('shopping list ')) return 'Generated';
  return 'User';
};

const toTimestamp = (list: DateSearchableShoppingList): number | null => {
  const parsed = Date.parse(String(list.createdAt || ''));
  if (!Number.isNaN(parsed)) return parsed;
  return null;
};

export const sortShoppingListsNewestFirst = <T extends DateSearchableShoppingList>(
  lists: T[],
): T[] =>
  [...lists]
    .map((list, index) => ({ list, index }))
    .sort((a, b) => {
      const aTime = toTimestamp(a.list);
      const bTime = toTimestamp(b.list);

      if (aTime !== null && bTime !== null) return bTime - aTime;
      if (aTime !== null) return -1;
      if (bTime !== null) return 1;

      const aId = a.list.id;
      const bId = b.list.id;
      if (typeof aId === 'number' && typeof bId === 'number') return bId - aId;
      if (typeof aId === 'number') return -1;
      if (typeof bId === 'number') return 1;

      return a.index - b.index;
    })
    .map(({ list }) => list);

export const formatListDateStamp = (createdAt: string): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt.slice(0, 10);
  return date.toISOString().slice(0, 10);
};

export const formatListTimestamp = (createdAt: string): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toISOString().slice(11, 19);
};

export const filterShoppingLists = <T extends DateSearchableShoppingList>(
  lists: T[],
  searchQuery: string,
): T[] => {
  const q = searchQuery.toLowerCase().trim();
  if (!q) return lists;
  return lists.filter((list) => {
    const sourceLabel = getListSourceLabel(list.name).toLowerCase();
    return list.createdAt.toLowerCase().includes(q) || sourceLabel.includes(q);
  });
};
