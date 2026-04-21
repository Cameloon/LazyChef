import React, { useState, useMemo, useEffect } from 'react';
import { Text, Box, useInput, useStdout } from 'ink';
import { eq } from 'drizzle-orm';
import { db } from '../db/db';
import { inventory, inventoryMovements } from '../db/schema';
import { Header, type ViewMode } from '../components/InventoryComponents/Header.tsx';
import EditItemModal from '../components/EditItemModal.tsx';
import { t } from '../services/i18n';

type Item = typeof inventory.$inferSelect;
type AppMode = 'normal' | 'search' | 'edit' | 'add';

type Props = {
  language?: string;
  onNavigationLockChange?: (locked: boolean) => void;
};

const getSymbol = (category: string | null, emoji?: string | null) => {
  if (emoji?.trim()) return emoji.trim();

  switch (category?.toLowerCase()) {
    case 'essentials':
      return '📦';
    case 'liquid':
      return '🥛';
    case 'alcohol':
      return '🍺';
    default:
      return '🍴';
  }
};

/*
    inventory movement row
    Dashboard trend uses inventory_movements, not inventory
 */
const logInventoryMovement = (input: {
  itemName: string;
  delta: number;
  unit: string;
  eventType?: string;
}): void => {
  if (!Number.isFinite(input.delta) || input.delta === 0) return;

  db.insert(inventoryMovements)
    .values({
      itemName: input.itemName.trim(),
      delta: input.delta,
      unit: input.unit.trim() || 'pcs',
      eventType: input.eventType ?? 'manual',
      createdAt: new Date().toISOString(),
    })
    .run();
};

export const Inventory: React.FC<Props> = ({ language = 'en', onNavigationLockChange }) => {
  const { stdout } = useStdout();

  const [items, setItems] = useState<Item[]>([]);
  const [view, setView] = useState<ViewMode>('list');
  const [mode, setMode] = useState<AppMode>('normal');
  const [search, setSearch] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [editingItem, setEditingItem] = useState<Item | null>(null);

  const loadData = async () => {
    const data = db.select().from(inventory).all();
    setItems(data);
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    // Keep app-level navigation disabled while a modal or search input can capture keys.
    const shouldLock = mode === 'edit' || mode === 'add' || mode === 'search';
    onNavigationLockChange?.(shouldLock);
    return () => onNavigationLockChange?.(false);
  }, [mode, onNavigationLockChange]);

  const [terminalSize, setTerminalSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  useEffect(() => {
    // Re-read terminal dimensions so list/grid layout stays usable after resize.
    const onResize = () => {
      setTerminalSize({
        columns: stdout?.columns || 80,
        rows: stdout?.rows || 24,
      });
    };

    if (stdout) {
      stdout.on('resize', onResize);
      return () => {
        stdout.off('resize', onResize);
      };
    }

    return;
  }, [stdout]);

  // This component's own "screen"
  const screenWidth = Math.max(50, Math.floor(terminalSize.columns * 0.8));
  const screenHeight = Math.max(14, Math.floor(terminalSize.rows * 0.7));

  // Internal paddings in this component root
  const ROOT_PAD_X = 2;
  const contentWidth = Math.max(20, screenWidth - ROOT_PAD_X * 2);

  const FOOTER_HEIGHT = 2;
  const TABLE_HEADER_HEIGHT = view === 'list' ? 1 : 0;
  const RESERVED_HEADER_HEIGHT = 4;

  const listBodyHeight = Math.max(
    1,
    screenHeight - RESERVED_HEADER_HEIGHT - TABLE_HEADER_HEIGHT - FOOTER_HEIGHT,
  );

  const filteredItems = useMemo(() => {
    // Search is intentionally local and case-insensitive for fast terminal filtering.
    const q = search.toLowerCase();
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) || (i.category && i.category.toLowerCase().includes(q)),
    );
  }, [items, search]);

  // Grid geometry based on this component's content width
  const GRID_CARD_WIDTH = 18;
  const GRID_CARD_HEIGHT = 5;
  const GRID_GAP_X = 1;
  const GRID_GAP_Y = 1;

  const maxColsByWidth = Math.floor(contentWidth / (GRID_CARD_WIDTH + GRID_GAP_X));
  const gridCols = Math.max(1, Math.min(6, maxColsByWidth));

  const gridRowsPerPage = Math.max(1, Math.floor(listBodyHeight / (GRID_CARD_HEIGHT + GRID_GAP_Y)));

  const itemsPerPage = view === 'list' ? listBodyHeight : gridRowsPerPage * gridCols;

  // Keep index valid
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (filteredItems.length === 0) return 0;
      return Math.min(prev, filteredItems.length - 1);
    });
  }, [filteredItems.length]);

  // Reset view/search paging
  useEffect(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, [search, view]);

  // Keep selected item visible
  useEffect(() => {
    if (filteredItems.length === 0) {
      setScrollOffset(0);
      return;
    }

    if (view === 'list') {
      if (selectedIndex < scrollOffset) {
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + itemsPerPage) {
        setScrollOffset(selectedIndex - itemsPerPage + 1);
      }
      return;
    }

    const selectedRow = Math.floor(selectedIndex / gridCols);
    const firstVisibleRow = Math.floor(scrollOffset / gridCols);
    const lastVisibleRow = firstVisibleRow + gridRowsPerPage - 1;

    if (selectedRow < firstVisibleRow) {
      setScrollOffset(selectedRow * gridCols);
    } else if (selectedRow > lastVisibleRow) {
      setScrollOffset((selectedRow - gridRowsPerPage + 1) * gridCols);
    }
  }, [
    selectedIndex,
    scrollOffset,
    filteredItems.length,
    view,
    itemsPerPage,
    gridCols,
    gridRowsPerPage,
  ]);

  useInput(async (input, key) => {
    if (mode === 'edit' || mode === 'add' || mode === 'search') return;

    if (input === 'a') {
      setMode('add');
      return;
    }

    if (filteredItems.length === 0) return;

    const max = filteredItems.length - 1;

    if (view === 'list') {
      if (key.upArrow) setSelectedIndex((p) => Math.max(0, p - 1));
      if (key.downArrow) setSelectedIndex((p) => Math.min(max, p + 1));
    } else {
      if (key.upArrow) setSelectedIndex((p) => Math.max(0, p - gridCols));
      if (key.downArrow) setSelectedIndex((p) => Math.min(max, p + gridCols));
      if (key.leftArrow) setSelectedIndex((p) => Math.max(0, p - 1));
      if (key.rightArrow) setSelectedIndex((p) => Math.min(max, p + 1));
    }

    if (input === 'e' && filteredItems[selectedIndex]) {
      setEditingItem(filteredItems[selectedIndex]);
      setMode('edit');
      return;
    }

    if (input === 'x' && filteredItems[selectedIndex]) {
      db.delete(inventory).where(eq(inventory.id, filteredItems[selectedIndex].id)).run();
      await loadData();
      return;
    }

    if (input === '+' || input === '-') {
      const target = filteredItems[selectedIndex];
      if (target) {
        const delta = input === '+' ? 1 : -1;
        const nextQuantity = Math.max(0, target.quantity + delta);

        // Do not write a fake negative movement if quantity is already 0
        if (nextQuantity === target.quantity) {
          return;
        }

        // Persist the stock change and mirror it in the movement history used by dashboard charts.
        db.update(inventory)
          .set({ quantity: nextQuantity })
          .where(eq(inventory.id, target.id))
          .run();

        logInventoryMovement({
          itemName: target.name,
          delta,
          unit: target.unit,
          eventType: delta > 0 ? 'manual_increase' : 'manual_decrease',
        });

        await loadData();
      }
    }
  });

  const handleSave = async (payload: Partial<Item>) => {
    if (mode === 'add') {
      const quantity = payload.quantity ?? 0;
      const unit = payload.unit ?? 'pcs';

      db.insert(inventory)
        .values({
          name: payload.name!,
          category: payload.category,
          emoji: payload.emoji ?? null,
          quantity,
          unit,
        })
        .run();

      if (quantity > 0) {
        // New items only create a movement row when they actually add stock.
        logInventoryMovement({
          itemName: payload.name!,
          delta: quantity,
          unit,
          eventType: 'manual_add',
        });
      }
    } else if (mode === 'edit' && payload.id) {
      const existing = items.find((item) => item.id === payload.id);

      db.update(inventory).set(payload).where(eq(inventory.id, payload.id)).run();

      if (existing && payload.quantity !== undefined) {
        // Editing quantity should record the net difference, not the whole row again.
        const delta = payload.quantity - existing.quantity;

        if (delta !== 0) {
          logInventoryMovement({
            itemName: payload.name ?? existing.name,
            delta,
            unit: payload.unit ?? existing.unit,
            eventType: delta > 0 ? 'manual_edit_increase' : 'manual_edit_decrease',
          });
        }
      }
    }

    await loadData();
    setMode('normal');
    setEditingItem(null);
  };

  // Slice only the currently visible window so list and grid share the same paging logic.
  const visibleItems = filteredItems.slice(scrollOffset, scrollOffset + itemsPerPage);

  // Explicit grid rows -> otherwise arrow down/up bug occurs
  const gridRows = useMemo(() => {
    if (view !== 'grid') return [] as Item[][];
    const rows: Item[][] = [];
    for (let r = 0; r < gridRowsPerPage; r++) {
      const row: Item[] = [];
      for (let c = 0; c < gridCols; c++) {
        const idx = r * gridCols + c;
        const item = visibleItems[idx];
        if (item) row.push(item);
      }
      if (row.length > 0) rows.push(row);
    }

    return rows;
  }, [view, visibleItems, gridRowsPerPage, gridCols]);

  // list columns
  const itemColWidth = Math.max(18, Math.floor(contentWidth * 0.56));
  const qtyColWidth = Math.max(8, Math.floor(contentWidth * 0.2));
  const unitColWidth = Math.max(6, Math.floor(contentWidth * 0.14));

  return (
    <Box
      flexDirection='column'
      height={screenHeight}
      width={screenWidth}
      paddingLeft={2}
      paddingRight={1}
    >
      {/* Header */}
      <Box flexShrink={0}>
        <Header
          title={t('inventory.title', language)}
          viewMode={view}
          onToggleView={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}
          searchQuery={search}
          onSearchChange={setSearch}
          isSearching={isSearching}
          setIsSearching={(val) => {
            setIsSearching(val);
            setMode(val ? 'search' : 'normal');
          }}
          isActive={mode === 'normal' || mode === 'search'}
          language={language}
        />
      </Box>

      {/* List table header */}
      {view === 'list' && (
        <Box
          height={TABLE_HEADER_HEIGHT}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={2}
          paddingBottom={1.5}
        >
          <Box paddingLeft={2.5} width={itemColWidth}>
            <Text inverse color='magenta' bold>
              {' '}
              {t('inventory.col.item', language)}{' '}
            </Text>
          </Box>
          <Box width={qtyColWidth}>
            <Text inverse color='magenta' bold>
              {' '}
              {t('inventory.col.quantity', language)}{' '}
            </Text>
          </Box>
          <Box width={unitColWidth}>
            <Text inverse color='magenta' bold>
              {' '}
              {t('inventory.col.unit', language)}{' '}
            </Text>
          </Box>
        </Box>
      )}

      {/* Scroll area */}
      <Box flexGrow={1} flexShrink={1} overflow='hidden' flexDirection='column'>
        {view === 'list'
          ? visibleItems.map((item) => {
              const isSelected = filteredItems[selectedIndex]?.id === item.id;
              const symbol = getSymbol(item.category, item.emoji);

              return (
                <Box key={item.id} height={1} paddingLeft={1} paddingRight={3}>
                  <Box width={itemColWidth}>
                    <Text color={isSelected ? 'yellow' : undefined}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Text color={isSelected ? undefined : 'gray'} wrap='truncate-end'>
                      {symbol} {item.name}
                    </Text>
                  </Box>
                  <Box width={qtyColWidth}>
                    <Text color={isSelected ? 'yellow' : 'gray'}>{item.quantity}</Text>
                  </Box>
                  <Box width={unitColWidth}>
                    <Text color={isSelected ? 'yellow' : 'gray'}>{item.unit}</Text>
                  </Box>
                </Box>
              );
            })
          : gridRows.map((row, r) => (
              <Box key={`grid-row-${r}`} height={GRID_CARD_HEIGHT + GRID_GAP_Y}>
                {row.map((item) => {
                  const isSelected = filteredItems[selectedIndex]?.id === item.id;
                  const symbol = getSymbol(item.category, item.emoji);

                  return (
                    <Box
                      key={item.id}
                      width={GRID_CARD_WIDTH}
                      height={GRID_CARD_HEIGHT}
                      marginRight={GRID_GAP_X}
                      borderStyle={isSelected ? 'double' : 'round'}
                      borderColor={isSelected ? 'green' : 'gray'}
                      flexDirection='column'
                      alignItems='center'
                      justifyContent='center'
                    >
                      <Text wrap='truncate-end'>
                        {symbol} {item.name}
                      </Text>
                      <Text color={isSelected ? 'yellow' : 'gray'}>
                        {item.quantity} {item.unit}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            ))}
      </Box>

      {/* Footer keeps the keyboard shortcuts and selection counter visible at all times. */}
      <Box
        flexGrow={1}
        height={FOOTER_HEIGHT}
        flexShrink={0}
        borderStyle='classic'
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text dimColor>
          [a] <Text color='cyan'>{t('inventory.action.add', language)}</Text> • [e]{' '}
          <Text color='yellow'>{t('inventory.action.edit', language)}</Text> • [x]{' '}
          <Text color='red'>{t('inventory.action.delete', language)}</Text> • [+/-]{' '}
          {t('inventory.short.qty', language)} • {t('inventory.footer.move', language)} •
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {filteredItems.length === 0 ? 0 : selectedIndex + 1}/{filteredItems.length}
        </Text>
      </Box>

      {/* Modal overlays the inventory so add/edit can run without leaving the screen. */}
      {(mode === 'edit' || mode === 'add') && (
        <Box position='absolute' width='60%' alignSelf='center' marginTop={5}>
          <EditItemModal
            item={editingItem}
            language={language}
            onCancel={() => {
              setMode('normal');
              setEditingItem(null);
            }}
            onSave={handleSave}
          />
        </Box>
      )}
    </Box>
  );
};
