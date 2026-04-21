import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { db } from '../db/db';
import { inventory, inventoryMovements } from '../db/schema';
import { getAllRecipes, type RecipeAggregate } from '../db/recipesRepo';
import {
  getAllShoppingLists,
  getShoppingListById,
  type ShoppingListRow,
} from '../db/shoppingListsRepo';
import {
  getLatestPlannerGeneration,
  getPlannerHistory,
  type PlannerHistoryEntry,
} from '../db/plannerRepo';
import { buildRecipeSuggestions } from '../services/dplanning';
import { t } from '../services/i18n';

type InventoryRow = typeof inventory.$inferSelect;
type MovementRow = typeof inventoryMovements.$inferSelect;

type RangeMode = 'week' | 'month';
type DashboardTab = 'Inventory' | 'Recipes' | 'Planner' | 'Shopping List';

/*
  Metric item for charts and counters
  `unit` is optional because not every metric needs a unit
 */
type MetricItem = {
  label: string;
  value: number;
  unit?: string;
};

type TrendPoint = MetricItem;
type ShoppingListDetail = NonNullable<ReturnType<typeof getShoppingListById>>;

type DashboardSection = {
  id: string;
  title: string;
  accent: string;
  render: (
    maxRows: number,
    labelWidth: number,
    barWidth: number,
    cardWidth: number,
  ) => React.ReactNode;
};

const TOP_LIMIT = 10;
const SHOPPING_PREVIEW_LIMIT = 6;
const CHART_BAR_OFFSET = 3;

const CONVENIENCE_KEYWORDS = [
  'frozen',
  'freezer',
  'deep-frozen',
  'deep frozen',
  'tiefkühl',
  'tiefkuehl',
  'tk',
  'fertiggericht',
  'fertiggerichte',
  'ready meal',
  'ready-meal',
  'prepared',
  'pre-cooked',
  'precooked',
  'instant',
  'microwave',
  'convenience',
];

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const normalizeKey = (value: unknown): string =>
  normalizeText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

// Robust date parser (handles string timestamps safely)
const toDate = (value: unknown): Date | null => {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const str = String(value).trim();
  if (!str) return null;

  const parsed = new Date(str);

  // fallback: try parsing as number timestamp
  if (Number.isNaN(parsed.getTime())) {
    const asNumber = Number(str);
    if (Number.isFinite(asNumber)) {
      const alt = new Date(asNumber);
      return Number.isNaN(alt.getTime()) ? null : alt;
    }
    return null;
  }

  return parsed;
};

const startOfWeek = (date: Date): Date => {
  const result = new Date(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
};

const startOfMonth = (date: Date): Date => {
  const result = new Date(date);
  result.setDate(1);
  result.setHours(0, 0, 0, 0);
  return result;
};

// Keep all dashboard metrics aligned to the currently selected time range.
const isInRange = (date: Date, range: RangeMode, now = new Date()): boolean => {
  const start = range === 'week' ? startOfWeek(now) : startOfMonth(now);
  return date >= start && date <= now;
};

const formatDateLabel = (date: Date, range: RangeMode): string =>
  range === 'week'
    ? date.toLocaleDateString('en-US', { weekday: 'short' })
    : date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });

const formatInteger = (value: number): string =>
  new Intl.NumberFormat('en-US').format(Math.round(value));

const fitText = (value: string, width: number): string => {
  const normalized = normalizeText(value);
  if (width <= 1) return normalized.slice(0, 1);
  if (normalized.length <= width) return normalized.padEnd(width, ' ');
  return `${normalized.slice(0, Math.max(0, width - 1))}…`;
};

/*
    Normalize a unit string.
    Examples: " G " -> "g", "PCS" -> "pcs"
 */
const normalizeUnit = (value: unknown, fallback = 'pcs'): string => {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || fallback;
};

/*
    Try to extract a measurement unit from a movement row.
    Supports multiple possible field names to stay compatible
    with slightly different database schemas.
 */
const extractMovementUnit = (row: MovementRow): string => {
  const anyRow = row as Record<string, unknown>;
  return normalizeUnit(anyRow.unit ?? anyRow.unitName ?? anyRow.measureUnit ?? anyRow.uom, 'pcs');
};

/*
    Format a metric value with unit when available.
    Examples:
    - 500 g
    - 12 pcs
    - 4
 */
const formatMetricValue = (item: MetricItem): string => {
  const valueText = formatInteger(item.value);
  return item.unit ? `${valueText} ${item.unit}` : valueText;
};

// Wrap text into multiple lines so long content can stay readable
// inside narrow dashboard cards.
const wrapText = (value: string, width: number, maxLines = 3): string[] => {
  const normalized = normalizeText(value);
  if (!normalized) return [''];
  const safeWidth = Math.max(8, width);
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= safeWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = '';
    }

    if (word.length <= safeWidth) {
      currentLine = word;
    } else {
      lines.push(`${word.slice(0, Math.max(1, safeWidth - 1))}…`);
    }

    if (lines.length >= maxLines) break;
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }

  if (words.length > 0 && lines.length === maxLines) {
    const joined = lines.join(' ');
    if (joined.length < normalized.length) {
      const lastIndex = lines.length - 1;
      const lastLine = lines[lastIndex];
      if (lastLine) {
        lines[lastIndex] = `${lastLine.slice(0, Math.max(1, safeWidth - 1))}…`;
      }
    }
  }

  return lines;
};

const makeBar = (value: number, maxValue: number, width: number): string => {
  if (maxValue <= 0) return '░'.repeat(Math.max(3, Math.floor(width / 2)));
  const filled = Math.max(1, Math.round((value / maxValue) * width));
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
};

// Create a fixed horizontal gap before the bar so chart columns
// start farther to the right and look more balanced.
const makeSpacer = (width: number): string => ' '.repeat(Math.max(0, width));

/*
    Group items by label + unit.
    This prevents values with different measurement units
    from being merged into the same row.
 
    Example:
    Milk + l
    Milk + pcs
    will stay as two separate metrics.
 */
const aggregateItems = (items: MetricItem[], limit = TOP_LIMIT): MetricItem[] => {
  const grouped = new Map<string, MetricItem>();

  for (const item of items) {
    const key = `${normalizeKey(item.label)}|${normalizeKey(item.unit ?? '')}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.value += item.value;
    } else {
      grouped.set(key, {
        label: item.label,
        value: item.value,
        unit: item.unit,
      });
    }
  }

  return [...grouped.values()]
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit);
};

// Extract a readable inventory item name from different row shapes
const extractInventoryLabel = (row: InventoryRow, index: number): string => {
  const anyRow = row as Record<string, unknown>;
  return normalizeText(anyRow.name ?? anyRow.title ?? anyRow.itemName) || `Item ${index + 1}`;
};

// Extract a readable shopping-list item name from different row shapes
const extractShoppingItemLabel = (item: unknown, index: number): string => {
  const anyItem = item as Record<string, unknown>;
  return (
    normalizeText(
      anyItem.name ??
        anyItem.itemName ??
        anyItem.title ??
        anyItem.productName ??
        anyItem.ingredientName,
    ) || `Item ${index + 1}`
  );
};

// Try to keep only open / active shopping lists
// If no status field exists in your data model, all lists remain included
const isOpenShoppingList = (list: ShoppingListDetail): boolean => {
  const row = list as Record<string, unknown>;
  const status = normalizeKey(row.status);
  const isArchived = Boolean(row.isArchived);
  const isClosed = Boolean(row.isClosed);
  const isDone = Boolean(row.isDone);

  if (isArchived || isClosed || isDone) return false;
  if (!status) return true;

  return !['done', 'closed', 'archived', 'completed'].includes(status);
};

// Merge items across all open shopping lists so the dashboard can show
// one combined "what to buy now" state
const aggregateShoppingItems = (
  lists: ShoppingListDetail[],
): { items: MetricItem[]; totalCount: number; listCount: number } => {
  const openLists = lists.filter(isOpenShoppingList);
  const rawItems: MetricItem[] = [];

  for (const list of openLists) {
    for (let index = 0; index < list.items.length; index += 1) {
      const item = list.items[index];
      const label = extractShoppingItemLabel(item, index);
      rawItems.push({ label, value: 1 });
    }
  }

  const aggregated = aggregateItems(rawItems, 999);

  return {
    items: aggregated,
    totalCount: rawItems.length,
    listCount: openLists.length,
  };
};

/**
 * Build the Top 10 purchased foods list from positive movement rows only
 * Each item now also includes a measurement unit
 */
const buildPurchasedFoods = (rows: MovementRow[], range: RangeMode): MetricItem[] => {
  return aggregateItems(
    rows
      .filter((row) => {
        const date = toDate(row.createdAt);
        return date ? isInRange(date, range) : false;
      })
      .filter((row) => row.delta > 0)
      .map((row) => ({
        label: row.itemName,
        value: Math.max(0, row.delta),
        unit: extractMovementUnit(row),
      }))
      .filter((item) => item.value > 0),
  );
};

// Build inventory movement trend for the selected time range
const buildStockTrend = (rows: MovementRow[], range: RangeMode): TrendPoint[] => {
  const grouped = new Map<string, number>();

  for (const row of rows) {
    const date = toDate(row.createdAt);
    if (!date || !isInRange(date, range)) continue;

    const label = formatDateLabel(date, range);
    grouped.set(label, (grouped.get(label) ?? 0) + row.delta);
  }

  return [...grouped.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => left.label.localeCompare(right.label));
};

// Treat planner history as cooked recipes activity
const buildCookedRecipes = (
  plannerHistory: PlannerHistoryEntry[],
  range: RangeMode,
): MetricItem[] => {
  const collected: MetricItem[] = [];

  for (const entry of plannerHistory) {
    const date = toDate(entry.createdAt);
    if (!date || !isInRange(date, range)) continue;

    for (const day of entry.plan) {
      for (const meal of day.meals) {
        const label = normalizeText(meal.name);
        if (!label) continue;
        collected.push({ label, value: 1 });
      }
    }
  }

  return aggregateItems(collected);
};

// Build shopping frequency from shopping-list creation dates
const buildShoppingFrequency = (lists: ShoppingListDetail[], range: RangeMode): TrendPoint[] => {
  const grouped = new Map<string, number>();

  for (const list of lists) {
    const date = toDate(list.createdAt);
    if (!date || !isInRange(date, range)) continue;

    const label = formatDateLabel(date, range);
    grouped.set(label, (grouped.get(label) ?? 0) + 1);
  }

  return [...grouped.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => left.label.localeCompare(right.label));
};

// Detect whether a recipe looks like a convenience / ready-made meal
const hasConvenienceSignal = (recipe: RecipeAggregate): boolean => {
  const text = [
    recipe.title,
    recipe.categories.join(' '),
    recipe.habits.join(' '),
    recipe.ingredients.map((ingredient) => ingredient.name).join(' '),
    recipe.steps.join(' '),
  ]
    .map(normalizeKey)
    .join(' ');

  return CONVENIENCE_KEYWORDS.some((keyword) => text.includes(normalizeKey(keyword)));
};

// Compute the ratio of convenience meals versus freshly cooked meals
// from planner history and recipe metadata
const buildConvenienceRatio = (
  plannerHistory: PlannerHistoryEntry[],
  recipes: RecipeAggregate[],
  range: RangeMode,
): { convenience: number; fresh: number; total: number; ratio: number } => {
  const recipeMap = new Map(recipes.map((recipe) => [normalizeKey(recipe.title), recipe]));
  let convenience = 0;
  let fresh = 0;

  for (const entry of plannerHistory) {
    const date = toDate(entry.createdAt);
    if (!date || !isInRange(date, range)) continue;

    for (const day of entry.plan) {
      for (const meal of day.meals) {
        const matchedRecipe = recipeMap.get(normalizeKey(meal.name));
        const isConvenience = matchedRecipe
          ? hasConvenienceSignal(matchedRecipe)
          : hasConvenienceSignal({
              id: -1,
              title: meal.name,
              servings: null,
              duration: null,
              difficulty: null,
              habits: [],
              diets: [],
              categories: [],
              ingredients: [],
              steps: [],
            });

        if (isConvenience) convenience += 1;
        else fresh += 1;
      }
    }
  }

  const total = convenience + fresh;

  return {
    convenience,
    fresh,
    total,
    ratio: total > 0 ? convenience / total : 0,
  };
};

const WrappedTextBlock: React.FC<{
  text: string;
  width: number;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  maxLines?: number;
}> = ({ text, width, color, dimColor, bold, maxLines = 3 }) => {
  const lines = wrapText(text, Math.max(8, width), maxLines);

  return (
    <Box flexDirection='column'>
      {lines.map((line, index) => (
        <Text key={`${line}-${index}`} color={color as any} dimColor={dimColor} bold={bold}>
          {fitText(line, Math.max(8, width))}
        </Text>
      ))}
    </Box>
  );
};

const ChartList: React.FC<{
  items: MetricItem[];
  emptyMessage: string;
  maxRows: number;
  labelWidth: number;
  barWidth: number;
  cardWidth: number;
}> = ({ items, emptyMessage, maxRows, labelWidth, barWidth, cardWidth }) => {
  const visibleItems = items.slice(0, Math.max(1, maxRows));
  const maxValue = visibleItems[0]?.value ?? 0;
  const stackedLayout = cardWidth < 44;

  return (
    <Box flexDirection='column'>
      {visibleItems.length === 0 ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        visibleItems.map((item, index) => {
          const rank = `${String(index + 1).padStart(2, '0')}.`;

          if (stackedLayout) {
            const labelLines = wrapText(item.label, Math.max(10, cardWidth - 6), 2);

            return (
              <Box
                key={`${item.label}-${item.unit ?? 'no-unit'}-${index}`}
                flexDirection='column'
                marginBottom={0}
              >
                <Text>
                  <Text color='magenta'>{rank}</Text> <Text bold>{labelLines[0] ?? ''}</Text>
                </Text>

                {labelLines[1] ? (
                  <Text>
                    {'    '}
                    <Text bold>{labelLines[1]}</Text>
                  </Text>
                ) : null}

                <Text>
                  {'    '}
                  <Text color='green'>
                    {makeBar(item.value, maxValue, Math.max(6, barWidth + 2))}
                  </Text>{' '}
                  <Text>{formatMetricValue(item)}</Text>
                </Text>
              </Box>
            );
          }

          return (
            <Text key={`${item.label}-${item.unit ?? 'no-unit'}-${index}`}>
              <Text color='magenta'>{rank}</Text>{' '}
              <Text bold>{fitText(item.label, labelWidth)}</Text>
              <Text>{makeSpacer(CHART_BAR_OFFSET)}</Text>
              <Text color='green'>{makeBar(item.value, maxValue, barWidth)}</Text>
              <Text>{makeSpacer(1)}</Text>
              <Text>{formatMetricValue(item)}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
};

const TrendChart: React.FC<{
  points: TrendPoint[];
  emptyMessage: string;
  maxRows: number;
  labelWidth: number;
  barWidth: number;
}> = ({ points, emptyMessage, maxRows, labelWidth, barWidth }) => {
  const visiblePoints = points.slice(0, Math.max(1, maxRows));
  const maxValue = Math.max(...visiblePoints.map((point) => Math.abs(point.value)), 0);

  return (
    <Box flexDirection='column'>
      {visiblePoints.length === 0 ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        visiblePoints.map((point, index) => (
          <Text key={`${point.label}-${index}`}>
            <Text color='blue'>{fitText(point.label, labelWidth)}</Text>{' '}
            <Text color='green'>{makeBar(Math.abs(point.value), maxValue, barWidth)}</Text>{' '}
            <Text>{formatInteger(point.value)}</Text>
          </Text>
        ))
      )}
    </Box>
  );
};

const StatCard: React.FC<{
  title: string;
  value: string;
  detail: string;
  accent: string;
  width?: number;
}> = ({ title, value, detail, accent, width }) => {
  const innerWidth = Math.max(12, (width ?? 20) - 4);
  const detailLines = wrapText(detail, innerWidth, 2);

  return (
    <Box
      flexDirection='column'
      borderStyle='single'
      borderColor={accent as any}
      paddingX={1}
      paddingY={0}
      width={width}
      flexShrink={0}
    >
      <Text dimColor>{fitText(title, innerWidth)}</Text>
      <Text bold color={accent as any}>
        {fitText(value, innerWidth)}
      </Text>
      {detailLines.map((line, index) => (
        <Text key={`${title}-detail-${index}`} dimColor>
          {fitText(line, innerWidth)}
        </Text>
      ))}
    </Box>
  );
};

const SectionCard: React.FC<{
  title: string;
  accent: string;
  width?: number;
  height?: number;
  children: React.ReactNode;
}> = ({ title, accent, width, height, children }) => (
  <Box
    flexDirection='column'
    borderStyle='single'
    borderColor={accent as any}
    paddingX={1}
    paddingY={0}
    width={width}
    height={height}
    flexShrink={0}
  >
    <Box marginBottom={1} flexShrink={0}>
      <Text bold color={accent as any}>
        {fitText(title, Math.max(10, (width ?? 20) - 4))}
      </Text>
    </Box>
    <Box flexDirection='column' flexGrow={1} flexShrink={1}>
      {children}
    </Box>
  </Box>
);

type DashboardProps = {
  onNavigate?: (tab: DashboardTab) => void;
  language?: string;
};

export const Dashboard: React.FC<DashboardProps> = ({
  onNavigate: _onNavigate,
  language = 'en',
}) => {
  const { stdout } = useStdout();

  // Keep the dashboard responsive to terminal resizes so the cards stay readable
  // Track terminal dimensions explicitly so the layout updates on window resize
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  const [inventoryRows, setInventoryRows] = useState<InventoryRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [recipesData, setRecipesData] = useState<RecipeAggregate[]>([]);
  const [shoppingLists, setShoppingLists] = useState<ShoppingListRow[]>([]);
  const [plannerHistory, setPlannerHistory] = useState<PlannerHistoryEntry[]>([]);
  const [_latestPlanner, setLatestPlanner] = useState<PlannerHistoryEntry | null>(null);
  const [rangeMode, setRangeMode] = useState<RangeMode>('week');
  const [sectionOffset, setSectionOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const dashboardT = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(key, language, vars),
    [language],
  );

  useEffect(() => {
    const onResize = () => {
      setTerminalSize({
        columns: stdout?.columns || 80,
        rows: stdout?.rows || 24,
      });
    };

    stdout?.on('resize', onResize);

    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const terminalColumns = terminalSize.columns;
  const terminalRows = terminalSize.rows;

  // Base window sizing matches the other screens for consistency
  const screenWidth = Math.max(50, Math.floor(terminalColumns * 0.8));
  const screenHeight = Math.max(14, Math.floor(terminalRows * 0.7));

  const ROOT_PAD_LEFT = 2;
  const ROOT_PAD_RIGHT = 2;
  const contentWidth = Math.max(30, screenWidth - ROOT_PAD_LEFT - ROOT_PAD_RIGHT);

  const HEADER_HEIGHT = 2;
  const FOOTER_HEIGHT = 2;
  const STATUS_HEIGHT = error ? 1 : 0;

  const visibleCards = contentWidth >= 120 ? 3 : contentWidth >= 80 ? 2 : 1;

  // Keep card spacing compact, but still responsive
  const cardGap = contentWidth >= 80 ? 2 : 1;
  const cardWidth = Math.max(
    24,
    Math.floor((contentWidth - cardGap * (visibleCards - 1)) / visibleCards),
  );

  // Use fewer summary columns on narrower screens to avoid overlap
  const statCols = contentWidth >= 110 ? 4 : contentWidth >= 70 ? 2 : 1;

  const statGap = 1;
  const statCardWidth = Math.max(
    22,
    Math.floor((contentWidth - statGap * (statCols - 1)) / statCols),
  );

  // Keep this number in sync with the summary cards rendered below
  const statCardsCount = 4;

  // Estimate the wrapped summary grid height instead of using a fixed value
  // This prevents the analytics section from overlapping the summary cards
  const statRows = Math.ceil(statCardsCount / statCols);
  const summaryRowHeight = statCols === 1 ? 6 : 5;
  const summaryRowGap = 1;
  const SUMMARY_HEIGHT = statRows * (summaryRowHeight + summaryRowGap);

  const bodyHeight = Math.max(
    8,
    screenHeight - HEADER_HEIGHT - SUMMARY_HEIGHT - FOOTER_HEIGHT - STATUS_HEIGHT,
  );

  // Shrink analytics cards on smaller screens while keeping them readable
  const cardHeight = bodyHeight >= 18 ? 14 : bodyHeight >= 14 ? 12 : bodyHeight >= 10 ? 9 : 8;

  const rowsPerCard = Math.max(2, Math.min(8, cardHeight - 3));

  const labelWidth = cardWidth >= 38 ? 18 : cardWidth >= 30 ? 14 : 10;

  const barWidth = cardWidth >= 38 ? 12 : cardWidth >= 30 ? 10 : 6;

  const loadDashboardData = useCallback(() => {
    try {
      // Load every dashboard source in one pass so all cards stay in sync
      setInventoryRows(db.select().from(inventory).all() as InventoryRow[]);
      setMovements(db.select().from(inventoryMovements).all() as MovementRow[]);
      setRecipesData(getAllRecipes());
      setShoppingLists(getAllShoppingLists());
      setPlannerHistory(getPlannerHistory());
      setLatestPlanner(getLatestPlannerGeneration());
      setError(null);
    } catch {
      setError(dashboardT('dashboard.cards.errorDatabase'));
    }
  }, [dashboardT]);

  // Load once on mount so the dashboard stays stable and does not stutter
  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const shoppingListDetails = useMemo(
    () =>
      // Resolve the stored shopping-list rows to their full detail records
      shoppingLists
        .map((list) => getShoppingListById(list.id))
        .filter((item): item is ShoppingListDetail => Boolean(item)),
    [shoppingLists],
  );

  const activeShoppingData = useMemo(
    () => aggregateShoppingItems(shoppingListDetails),
    [shoppingListDetails],
  );

  const activeShoppingItems = activeShoppingData.items;
  const activeShoppingItemCount = activeShoppingData.totalCount;
  const activeShoppingListCount = activeShoppingData.listCount;

  const shoppingPreview = useMemo(
    () => activeShoppingItems.slice(0, SHOPPING_PREVIEW_LIMIT).map((item) => item.label),
    [activeShoppingItems],
  );

  const planningInventory = useMemo(
    () =>
      inventoryRows
        .filter((row): row is InventoryRow => row !== undefined)
        .map((row, index) => ({
          name: extractInventoryLabel(row, index),
          quantity: toNumber((row as Record<string, unknown>).quantity, 0),
          unit: normalizeText((row as Record<string, unknown>).unit) || 'pcs',
        })),
    [inventoryRows],
  );

  const recipeSuggestions = useMemo(
    () => buildRecipeSuggestions(planningInventory, recipesData),
    [planningInventory, recipesData],
  );

  const purchasedFoods = useMemo(
    () => buildPurchasedFoods(movements, rangeMode),
    [movements, rangeMode],
  );

  const stockTrend = useMemo(() => buildStockTrend(movements, rangeMode), [movements, rangeMode]);

  const cookedRecipes = useMemo(
    () => buildCookedRecipes(plannerHistory, rangeMode),
    [plannerHistory, rangeMode],
  );

  const shoppingFrequency = useMemo(
    () => buildShoppingFrequency(shoppingListDetails, rangeMode),
    [shoppingListDetails, rangeMode],
  );

  const convenienceRatio = useMemo(
    () => buildConvenienceRatio(plannerHistory, recipesData, rangeMode),
    [plannerHistory, recipesData, rangeMode],
  );

  const sortedSuggestions = useMemo(
    () =>
      [...recipeSuggestions].sort((left, right) => {
        if (left.cookableNow !== right.cookableNow) return left.cookableNow ? -1 : 1;
        return right.possibleServings - left.possibleServings;
      }),
    [recipeSuggestions],
  );

  const bestRecipe = sortedSuggestions[0] ?? null;
  const cookableCount = sortedSuggestions.filter((item) => item.cookableNow).length;

  const cookableServings = sortedSuggestions
    .filter((item) => item.cookableNow)
    .reduce((sum, item) => sum + item.possibleServings, 0);

  const purchasedTopCount = purchasedFoods.reduce((sum, item) => sum + item.value, 0);
  const cookedTopCount = cookedRecipes.reduce((sum, item) => sum + item.value, 0);

  const currentRangeLabel = dashboardT(
    rangeMode === 'week' ? 'dashboard.range.week' : 'dashboard.range.month',
  );

  const shoppingItemWord = activeShoppingItemCount === 1 ? 'item' : 'items';

  // Keep the summary row short and stable even when data changes
  const nextShoppingCardValue =
    activeShoppingItemCount > 0
      ? dashboardT('dashboard.summary.shoppingNow')
      : dashboardT('dashboard.summary.shoppingCovered');

  const nextShoppingCardDetail =
    activeShoppingItemCount > 0
      ? dashboardT('dashboard.summary.shoppingNeed', {
          count: activeShoppingItemCount,
          itemWord: shoppingItemWord,
        })
      : dashboardT('dashboard.summary.noShoppingNeeds');

  const convenienceSummary =
    convenienceRatio.total > 0
      ? dashboardT('dashboard.cards.conveniencePct', {
          pct: Math.round(convenienceRatio.ratio * 100),
        })
      : dashboardT('dashboard.summary.noData');

  const convenienceDetail =
    convenienceRatio.total > 0
      ? `${dashboardT('dashboard.cards.readyMade', {
          count: formatInteger(convenienceRatio.convenience),
        })} / ${dashboardT('dashboard.cards.fresh', {
          count: formatInteger(convenienceRatio.fresh),
        })}`
      : dashboardT('dashboard.summary.noPlannerHistory');

  // Build the compact shopping hint shown in the coverage card
  const nextShoppingHint = (() => {
    if (activeShoppingItemCount > 0) {
      const preview = shoppingPreview.join(', ');
      const moreCount = Math.max(0, activeShoppingItemCount - shoppingPreview.length);

      return moreCount > 0
        ? dashboardT('dashboard.summary.buyNow', {
            items: `${preview} +${moreCount}`,
          })
        : dashboardT('dashboard.summary.buyNow', { items: preview });
    }

    if (bestRecipe?.cookableNow) {
      return dashboardT('dashboard.summary.recipesAvailable', {
        count: cookableCount,
        servings: cookableServings,
      });
    }

    return dashboardT('dashboard.summary.noOpenShoppingListsWithMissingItems');
  })();

  // nalytics sections are described in one place so the layout can adapt
  // to the available width without duplicating card rendering logic
  const sections: DashboardSection[] = useMemo(
    () => [
      {
        id: 'purchased',
        title: dashboardT('dashboard.cards.topPurchased', { range: currentRangeLabel }),
        accent: 'green',
        render: (maxRows, itemLabelWidth, itemBarWidth, sectionCardWidth) => (
          <ChartList
            items={purchasedFoods}
            emptyMessage={dashboardT('dashboard.cards.noPurchaseMovements')}
            maxRows={Math.min(10, maxRows)}
            labelWidth={itemLabelWidth}
            barWidth={itemBarWidth}
            cardWidth={sectionCardWidth}
          />
        ),
      },
      {
        id: 'cooked',
        title: dashboardT('dashboard.cards.topCooked', { range: currentRangeLabel }),
        accent: 'magenta',
        render: (maxRows, itemLabelWidth, itemBarWidth, sectionCardWidth) => (
          <ChartList
            items={cookedRecipes}
            emptyMessage={dashboardT('dashboard.cards.noCookedRecipes')}
            maxRows={Math.min(10, maxRows)}
            labelWidth={itemLabelWidth}
            barWidth={itemBarWidth}
            cardWidth={sectionCardWidth}
          />
        ),
      },
      {
        id: 'trend',
        title: dashboardT('dashboard.cards.inventoryTrend', { range: currentRangeLabel }),
        accent: 'blue',
        render: (maxRows, itemLabelWidth, itemBarWidth) => (
          <TrendChart
            points={stockTrend}
            emptyMessage={dashboardT('dashboard.cards.noInventoryMovements')}
            maxRows={maxRows}
            labelWidth={Math.max(6, itemLabelWidth - 8)}
            barWidth={itemBarWidth}
          />
        ),
      },
      {
        id: 'coverage',
        title: dashboardT('dashboard.cards.stockCoverage', { range: currentRangeLabel }),
        accent: 'cyan',
        render: (_: number, __: number, ___: number, width: number) => {
          const innerWidth = Math.max(10, width - 4);

          return (
            <Box flexDirection='column'>
              <WrappedTextBlock text={nextShoppingHint} width={innerWidth} maxLines={3} />

              {activeShoppingItemCount > 0 ? (
                <Box flexDirection='column'>
                  <Text dimColor>
                    {dashboardT('dashboard.summary.openShoppingLists', {
                      count: activeShoppingListCount,
                    })}{' '}
                    ·
                  </Text>
                  <Text color='red' bold>
                    {dashboardT('dashboard.summary.missingItems', {
                      count: activeShoppingItemCount,
                    })}
                  </Text>
                </Box>
              ) : (
                <WrappedTextBlock
                  text={dashboardT('dashboard.cards.coverage', {
                    recipes: cookableCount,
                    servings: cookableServings,
                  })}
                  width={innerWidth}
                  dimColor
                  maxLines={2}
                />
              )}

              <WrappedTextBlock
                text={
                  activeShoppingItemCount > 0
                    ? dashboardT('dashboard.summary.itemsPreview', {
                        items: shoppingPreview.join(', '),
                      })
                    : dashboardT('dashboard.cards.best', {
                        recipe: bestRecipe
                          ? bestRecipe.recipeName
                          : dashboardT('dashboard.cards.none'),
                      })
                }
                width={innerWidth}
                dimColor
                maxLines={3}
              />
            </Box>
          );
        },
      },
      {
        id: 'shopping',
        title: dashboardT('dashboard.cards.shoppingFrequency', { range: currentRangeLabel }),
        accent: 'yellow',
        render: (maxRows, itemLabelWidth, itemBarWidth) => (
          <TrendChart
            points={shoppingFrequency}
            emptyMessage={dashboardT('dashboard.cards.noShoppingActivity')}
            maxRows={maxRows}
            labelWidth={Math.max(6, itemLabelWidth - 8)}
            barWidth={itemBarWidth}
          />
        ),
      },
      {
        id: 'convenience',
        title: dashboardT('dashboard.cards.convenienceFoodRatio', { range: currentRangeLabel }),
        accent: 'red',
        render: (_: number, __: number, ___: number, width: number) => {
          const innerWidth = Math.max(10, width - 4);

          return (
            <Box flexDirection='column'>
              <WrappedTextBlock
                text={
                  convenienceRatio.total > 0
                    ? dashboardT('dashboard.cards.conveniencePct', {
                        pct: Math.round(convenienceRatio.ratio * 100),
                      })
                    : dashboardT('dashboard.summary.noData')
                }
                width={innerWidth}
                color='red'
                bold
                maxLines={2}
              />
              <WrappedTextBlock
                text={
                  convenienceRatio.total > 0
                    ? dashboardT('dashboard.cards.readyMade', {
                        count: formatInteger(convenienceRatio.convenience),
                      })
                    : dashboardT('dashboard.summary.noPlannerHistory')
                }
                width={innerWidth}
                dimColor
                maxLines={2}
              />
              <WrappedTextBlock
                text={
                  convenienceRatio.total > 0
                    ? dashboardT('dashboard.cards.fresh', {
                        count: formatInteger(convenienceRatio.fresh),
                      })
                    : dashboardT('dashboard.summary.noData')
                }
                width={innerWidth}
                dimColor
                maxLines={2}
              />
            </Box>
          );
        },
      },
    ],
    [
      currentRangeLabel,
      dashboardT,
      purchasedFoods,
      cookedRecipes,
      stockTrend,
      nextShoppingHint,
      cookableCount,
      cookableServings,
      bestRecipe,
      shoppingFrequency,
      convenienceRatio,
      activeShoppingItemCount,
      activeShoppingListCount,
      shoppingPreview,
    ],
  );

  // Slice the analytics cards so horizontal navigation can page through them
  const maxOffset = Math.max(0, sections.length - visibleCards);
  const visibleSections = sections.slice(sectionOffset, sectionOffset + visibleCards);

  useEffect(() => {
    setSectionOffset((prev) => Math.min(prev, maxOffset));
  }, [maxOffset]);

  useInput((input, key) => {
    // Week/month switches should feel immediate, while arrows scroll the card strip
    if (input === 'w') {
      setRangeMode('week');
      return;
    }

    if (input === 'm') {
      setRangeMode('month');
      return;
    }

    if (input === 'r') {
      loadDashboardData();
      return;
    }

    if (key.leftArrow || input === 'h') {
      setSectionOffset((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow || input === 'l') {
      setSectionOffset((prev) => Math.min(maxOffset, prev + 1));
    }
  });

  if (error) {
    return (
      <Box flexDirection='column' paddingLeft={1} paddingRight={1}>
        <Text bold color='red'>
          {dashboardT('dashboard.cards.errorLoad')}
        </Text>
        <Text color='red'>{error}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection='column'
      height={screenHeight}
      width={screenWidth}
      paddingLeft={ROOT_PAD_LEFT}
      paddingRight={ROOT_PAD_RIGHT}
    >
      <Box flexDirection='column' height={HEADER_HEIGHT} flexShrink={0}>
        <WrappedTextBlock
          text={dashboardT('dashboard.header.range', { range: currentRangeLabel })}
          width={Math.max(20, contentWidth - 2)}
          color='dim'
          maxLines={2}
        />
      </Box>

      {
        // Responsive summary grid. The layout height is accounted for above
      }
      <Box flexDirection='row' flexWrap='wrap' marginBottom={1}>
        <Box width={statCardWidth} marginRight={statGap} marginBottom={1}>
          <StatCard
            title={dashboardT('dashboard.summary.purchasedFoods')}
            value={dashboardT('dashboard.summary.units', {
              count: formatInteger(purchasedTopCount),
            })}
            detail={currentRangeLabel}
            accent='green'
            width={statCardWidth}
          />
        </Box>

        <Box width={statCardWidth} marginRight={statGap} marginBottom={1}>
          <StatCard
            title={dashboardT('dashboard.summary.cookedRecipes')}
            value={dashboardT('dashboard.summary.meals', { count: formatInteger(cookedTopCount) })}
            detail={currentRangeLabel}
            accent='magenta'
            width={statCardWidth}
          />
        </Box>

        <Box width={statCardWidth} marginRight={statGap} marginBottom={1}>
          <StatCard
            title={dashboardT('dashboard.summary.nextShopping')}
            value={nextShoppingCardValue}
            detail={nextShoppingCardDetail}
            accent='cyan'
            width={statCardWidth}
          />
        </Box>

        <Box width={statCardWidth} marginBottom={1}>
          <StatCard
            title={dashboardT('dashboard.summary.convenienceRatio')}
            value={convenienceSummary}
            detail={convenienceDetail}
            accent='red'
            width={statCardWidth}
          />
        </Box>
      </Box>

      {
        // nalytics area height based on the remaining free space
        //  This keeps it below the summary section even on small terminals
      }
      <Box flexDirection='row' height={cardHeight} flexShrink={0}>
        {visibleSections.map((section, index) => (
          <Box
            key={section.id}
            width={cardWidth}
            height={cardHeight}
            marginRight={index < visibleSections.length - 1 ? cardGap : 0}
          >
            <SectionCard
              title={fitText(section.title, Math.max(12, cardWidth - 4))}
              accent={section.accent}
              width={cardWidth}
              height={cardHeight}
            >
              {section.render(rowsPerCard, labelWidth, barWidth, cardWidth)}
            </SectionCard>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection='row' justifyContent='space-between' flexShrink={0}>
        <WrappedTextBlock
          text={dashboardT('dashboard.cards.cardsOf', {
            start: sectionOffset + 1,
            end: Math.min(sectionOffset + visibleCards, sections.length),
            total: sections.length,
          })}
          width={Math.max(20, contentWidth - 2)}
          dimColor
          maxLines={1}
        />
      </Box>
    </Box>
  );
};
