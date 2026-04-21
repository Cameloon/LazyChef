import React, { useState, useMemo, useEffect } from 'react';
import { Text, Box, useInput, useStdout } from 'ink';
import { createWriteStream, writeFileSync } from 'fs';
import { join } from 'path';
import { Header } from '../components/InventoryComponents/Header.tsx';
import {
  filterShoppingLists,
  formatListDateStamp,
  formatListTimestamp,
  getListSourceLabel,
  sortShoppingListsNewestFirst,
} from './shoppingListsViewUtils.ts';
import { t } from '../services/i18n';
import {
  getAllShoppingLists,
  getShoppingListById,
  generateShoppingList,
  createShoppingList,
  deleteShoppingList,
  addItemToList,
  updateListItem,
  deleteListItem,
  type ShoppingListRow,
  type ShoppingListItemRow,
} from '../db/shoppingListsRepo.ts';
import { addOrUpdateInventoryItem, addItemsToInventory } from '../db/inventoryRepo.ts';
import { scanLatestReceiptToInventoryAndShoppingList } from '../db/receiptScanner.ts';

// ── Types ──────────────────────────────────────────────────────────────

type Props = {
  onNavigationLockChange?: (locked: boolean) => void;
  language?: string;
};

type Screen = 'list' | 'detail';
type DetailMode = 'normal' | 'add' | 'edit';

const PREDEFINED_UNITS = ['pcs', 'kg', 'g', 'L', 'ml', 'Stk', 'Pkg', 'Bund'] as const;
const MAX_PREVIEW_ITEMS = 5;
const USER_LIST_NAME = 'user';

const ADD_EDIT_FIELDS = ['name', 'quantity', 'unit'] as const;
type FieldName = (typeof ADD_EDIT_FIELDS)[number];

// ── Export helpers ─────────────────────────────────────────────────────

const exportToMarkdown = (listName: string, items: ShoppingListItemRow[]): string => {
  const lines = [`# ${listName}`, ''];
  for (const item of items) {
    lines.push(`- [ ] ${item.quantity} ${item.unit} ${item.name}`);
  }
  const filePath = join(process.cwd(), `${listName.replace(/[/\\?%*:|"<>]/g, '_')}.md`);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
};

const exportToPdf = async (listName: string, items: ShoppingListItemRow[]): Promise<string> => {
  const { default: PDFDocument } = await import('pdfkit');
  return new Promise((resolve, reject) => {
    const filePath = join(process.cwd(), `${listName.replace(/[/\\?%*:|"<>]/g, '_')}.pdf`);
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).text(listName, { underline: true });
    doc.moveDown();

    for (const item of items) {
      doc.fontSize(12).text(`☐  ${item.quantity} ${item.unit}  ${item.name}`);
    }

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

const getListPreviewData = (items: ShoppingListItemRow[]): { names: string[]; total: number } => ({
  names: items.slice(0, MAX_PREVIEW_ITEMS).map((item) => item.name),
  total: items.length,
});

// ── Component ──────────────────────────────────────────────────────────

export const ShoppingLists: React.FC<Props> = ({ onNavigationLockChange, language = 'en' }) => {
  const { stdout } = useStdout();

  // ── Data state ───────────────────────────────────────────────────────
  const [lists, setLists] = useState<ShoppingListRow[]>([]);
  const [activeListId, setActiveListId] = useState<number | null>(null);
  const [detailItems, setDetailItems] = useState<ShoppingListItemRow[]>([]);
  const [listPreviewById, setListPreviewById] = useState<
    Map<number, { names: string[]; total: number }>
  >(new Map());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // ── UI state ─────────────────────────────────────────────────────────
  const [screen, setScreen] = useState<Screen>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [detailMode, setDetailMode] = useState<DetailMode>('normal');
  const [isSearching, setIsSearching] = useState(false);
  const [search, setSearch] = useState('');

  // Add/edit form state
  const [formValues, setFormValues] = useState<Record<FieldName, string>>({
    name: '',
    quantity: '1',
    unit: 'pcs',
  });
  const [formFieldIndex, setFormFieldIndex] = useState(0);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);

  // Receipt scanning state
  const [isScanning, setIsScanning] = useState(false);

  // ── Terminal responsiveness (matches Inventory.tsx) ───────────────────
  const [terminalSize, setTerminalSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

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

  const screenWidth = Math.max(50, Math.floor(terminalSize.columns * 0.8));
  const screenHeight = Math.max(14, Math.floor(terminalSize.rows * 0.7));

  const ROOT_PAD_X = 2;
  const contentWidth = Math.max(20, screenWidth - ROOT_PAD_X * 2);

  const FOOTER_HEIGHT = 2;
  const RESERVED_HEADER_HEIGHT = 4; // border top + title + border bottom + status row
  const TABLE_HEADER_HEIGHT = 1;
  const DETAIL_INDICATOR_ROWS = 2;

  // List screen: grid layout (like Planner)
  const LIST_CARD_WIDTH = 26;
  const LIST_CARD_HEIGHT = 11;
  const LIST_GRID_GAP_X = 1;
  const LIST_GRID_GAP_Y = 1;

  const listBodyHeight = Math.max(1, screenHeight - RESERVED_HEADER_HEIGHT - FOOTER_HEIGHT);
  const listGridCols = Math.max(1, Math.floor(contentWidth / (LIST_CARD_WIDTH + LIST_GRID_GAP_X)));
  const listGridRowsPerPage = Math.max(
    1,
    Math.floor(listBodyHeight / (LIST_CARD_HEIGHT + LIST_GRID_GAP_Y)),
  );
  const listItemsPerPage = listGridCols * listGridRowsPerPage;

  // Detail screen: row-based scroll (like Inventory list view)
  const DETAIL_FIXED_LINES =
    RESERVED_HEADER_HEIGHT + TABLE_HEADER_HEIGHT + FOOTER_HEIGHT + DETAIL_INDICATOR_ROWS;
  const detailRowsPerPage = Math.max(1, screenHeight - DETAIL_FIXED_LINES);

  // ── Data loading ─────────────────────────────────────────────────────
  const setListsWithPreviews = (allLists: ShoppingListRow[]) => {
    setLists(allLists);

    const previews = new Map<number, { names: string[]; total: number }>();
    for (const list of allLists) {
      const previewItems = getShoppingListById(list.id)?.items ?? [];
      previews.set(list.id, getListPreviewData(previewItems));
    }
    setListPreviewById(previews);
  };

  const loadLists = () => {
    const allLists = sortShoppingListsNewestFirst(getAllShoppingLists());
    setListsWithPreviews(allLists);
  };

  const refreshListsAndGet = (): ShoppingListRow[] => {
    const allLists = sortShoppingListsNewestFirst(getAllShoppingLists());
    setListsWithPreviews(allLists);
    return allLists;
  };

  const loadDetail = (listId: number) => {
    const result = getShoppingListById(listId);
    if (result) {
      setDetailItems(result.items);
      setListPreviewById((prev) => {
        const updated = new Map(prev);
        updated.set(listId, getListPreviewData(result.items));
        return updated;
      });
    }
  };

  useEffect(() => {
    loadLists();
  }, []);

  // ── Navigation lock ──────────────────────────────────────────────────
  useEffect(() => {
    const shouldLock = screen === 'detail' || detailMode !== 'normal' || isSearching;
    onNavigationLockChange?.(shouldLock);
    return () => onNavigationLockChange?.(false);
  }, [screen, detailMode, isSearching, onNavigationLockChange]);

  // ── Derived data ─────────────────────────────────────────────────────
  const activeList = useMemo(
    () => lists.find((l) => l.id === activeListId) ?? null,
    [lists, activeListId],
  );
  const filteredLists = useMemo(() => filterShoppingLists(lists, search), [lists, search]);

  // ── Keep selected index in range ─────────────────────────────────────
  const currentListLength = screen === 'list' ? filteredLists.length : detailItems.length;

  useEffect(() => {
    if (currentListLength === 0) {
      setSelectedIndex(0);
      setScrollOffset(0);
    } else {
      setSelectedIndex((prev) => Math.min(prev, currentListLength - 1));
    }
  }, [currentListLength]);

  // Keep selected visible
  useEffect(() => {
    if (currentListLength === 0) return;

    if (screen === 'list') {
      // Grid-based scroll
      const selectedRow = Math.floor(selectedIndex / listGridCols);
      const firstVisibleRow = Math.floor(scrollOffset / listGridCols);
      const lastVisibleRow = firstVisibleRow + listGridRowsPerPage - 1;

      if (selectedRow < firstVisibleRow) {
        setScrollOffset(selectedRow * listGridCols);
      } else if (selectedRow > lastVisibleRow) {
        setScrollOffset((selectedRow - listGridRowsPerPage + 1) * listGridCols);
      }
    } else {
      // Row-based scroll for detail screen (like Inventory)
      if (selectedIndex < scrollOffset) {
        setScrollOffset(selectedIndex);
      } else if (selectedIndex >= scrollOffset + detailRowsPerPage) {
        setScrollOffset(selectedIndex - detailRowsPerPage + 1);
      }
    }
  }, [
    selectedIndex,
    scrollOffset,
    currentListLength,
    screen,
    listGridCols,
    listGridRowsPerPage,
    detailRowsPerPage,
  ]);

  // ── Status message auto-clear ────────────────────────────────────────
  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => setStatusMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  const itemColWidth = Math.max(18, Math.floor(contentWidth * 0.56));
  const qtyColWidth = Math.max(8, Math.floor(contentWidth * 0.2));
  const unitColWidth = Math.max(6, Math.floor(contentWidth * 0.14));

  // ── Form helpers ─────────────────────────────────────────────────────
  const resetForm = () => {
    setFormValues({ name: '', quantity: '1', unit: 'pcs' });
    setFormFieldIndex(0);
    setEditingItemId(null);
  };

  const submitForm = () => {
    const trimmedName = formValues.name.trim();
    if (!trimmedName) return;
    const qty = parseFloat(formValues.quantity) || 1;

    if (detailMode === 'add' && activeListId !== null) {
      addItemToList(activeListId, { name: trimmedName, quantity: qty, unit: formValues.unit });
    } else if (detailMode === 'edit' && editingItemId !== null) {
      updateListItem(editingItemId, { name: trimmedName, quantity: qty, unit: formValues.unit });
    }

    if (activeListId !== null) loadDetail(activeListId);
    setDetailMode('normal');
    resetForm();
  };

  // ── Input handling ───────────────────────────────────────────────────
  useInput((input, key) => {
    if (isSearching) return;

    // ── Add / Edit form input ──────────────────────────────────────────
    if (detailMode === 'add' || detailMode === 'edit') {
      if (key.escape) {
        setDetailMode('normal');
        resetForm();
        return;
      }
      if (key.return) {
        if (formFieldIndex === ADD_EDIT_FIELDS.length - 1) {
          submitForm();
        } else {
          setFormFieldIndex((p) => p + 1);
        }
        return;
      }
      if (key.upArrow) {
        setFormFieldIndex((p) => (p - 1 + ADD_EDIT_FIELDS.length) % ADD_EDIT_FIELDS.length);
        return;
      }
      if (key.downArrow) {
        setFormFieldIndex((p) => (p + 1) % ADD_EDIT_FIELDS.length);
        return;
      }

      const activeField = ADD_EDIT_FIELDS[formFieldIndex];
      if (activeField === 'unit') {
        if (key.leftArrow || key.rightArrow) {
          const idx = PREDEFINED_UNITS.indexOf(
            formValues.unit as (typeof PREDEFINED_UNITS)[number],
          );
          const next = key.rightArrow
            ? (idx + 1) % PREDEFINED_UNITS.length
            : (idx - 1 + PREDEFINED_UNITS.length) % PREDEFINED_UNITS.length;
          const nextUnit = PREDEFINED_UNITS[next] ?? 'pcs';
          setFormValues((p) => ({ ...p, unit: nextUnit }));
        }
        return;
      }

      if (!activeField) return;

      // Text input for name / quantity
      if (key.backspace || key.delete) {
        setFormValues((p) => ({
          ...p,
          [activeField]: p[activeField].slice(0, -1),
        }));
        return;
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        if (activeField === 'quantity' && !/[0-9.]/.test(input)) return;
        setFormValues((p) => ({
          ...p,
          [activeField]: p[activeField] + input,
        }));
      }
      return;
    }

    // ── Main list screen ───────────────────────────────────────────────
    if (screen === 'list') {
      if (key.upArrow) {
        setSelectedIndex((p) => Math.max(0, p - listGridCols));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((p) => Math.min(filteredLists.length - 1, p + listGridCols));
        return;
      }
      if (key.leftArrow) {
        setSelectedIndex((p) => Math.max(0, p - 1));
        return;
      }
      if (key.rightArrow) {
        setSelectedIndex((p) => Math.min(filteredLists.length - 1, p + 1));
        return;
      }

      // Enter → drill into selected list (mimicking RecipesView drill-down)
      if (key.return && filteredLists[selectedIndex]) {
        const list = filteredLists[selectedIndex];
        setActiveListId(list.id);
        loadDetail(list.id);
        setScreen('detail');
        setSelectedIndex(0);
        setScrollOffset(0);
        return;
      }

      // Generate new list
      if (input === 'g') {
        const newId = generateShoppingList();
        loadLists();
        const updatedLists = sortShoppingListsNewestFirst(getAllShoppingLists());
        const idx = updatedLists.findIndex((l) => l.id === newId);
        if (idx >= 0) setSelectedIndex(idx);
        setStatusMessage(t('shoppingLists.status.generated', language));
        return;
      }

      // Create blank user list
      if (input === 'u') {
        const newId = createShoppingList(USER_LIST_NAME);
        if (newId > 0) {
          const updatedLists = refreshListsAndGet();
          const idx = updatedLists.findIndex((l) => l.id === newId);
          if (idx >= 0) setSelectedIndex(idx);
          setStatusMessage(t('shoppingLists.status.userCreated', language));
        } else {
          setStatusMessage(t('shoppingLists.status.userCreateFailed', language));
        }
        return;
      }

      // Scan latest receipt image from overview → add items to inventory + create tracked list
      if (input === 'r' && !isScanning) {
        setIsScanning(true);
        setStatusMessage(t('shoppingLists.status.scanning', language));
        scanLatestReceiptToInventoryAndShoppingList().then(
          (result) => {
            if (result.error) {
              setStatusMessage(
                t('shoppingLists.status.scanError', language, { error: result.error }),
              );
            } else {
              const updatedLists = refreshListsAndGet();
              if (result.listId) {
                const idx = updatedLists.findIndex((l) => l.id === result.listId);
                if (idx >= 0) setSelectedIndex(idx);
              }
              setStatusMessage(
                t('shoppingLists.status.scanSuccess', language, { count: result.count }),
              );
            }
            setIsScanning(false);
          },
          (err) => {
            setStatusMessage(
              t('shoppingLists.status.scanFailed', language, { error: err.message }),
            );
            setIsScanning(false);
          },
        );
        return;
      }

      // Delete list
      if (input === 'x' && filteredLists[selectedIndex]) {
        deleteShoppingList(filteredLists[selectedIndex].id);
        loadLists();
        return;
      }
      return;
    }

    // ── Detail screen ──────────────────────────────────────────────────
    if (screen === 'detail') {
      // Back to list (like RecipesView: Esc or 'b')
      if (key.escape || input === 'b') {
        setScreen('list');
        setActiveListId(null);
        setDetailItems([]);
        setSelectedIndex(0);
        setScrollOffset(0);
        loadLists();
        return;
      }

      if (key.upArrow) {
        const newIndex = Math.max(0, selectedIndex - 1);
        setSelectedIndex(newIndex);
        if (newIndex < scrollOffset) {
          setScrollOffset(newIndex);
        }
        return;
      }
      if (key.downArrow) {
        const newIndex = Math.min(detailItems.length - 1, selectedIndex + 1);
        setSelectedIndex(newIndex);
        if (newIndex >= scrollOffset + detailRowsPerPage) {
          setScrollOffset(newIndex - detailRowsPerPage + 1);
        }
        return;
      }

      // Add item
      if (input === 'a') {
        resetForm();
        setDetailMode('add');
        return;
      }

      // Edit selected item
      if (input === 'e' && detailItems[selectedIndex]) {
        const item = detailItems[selectedIndex];
        setFormValues({
          name: item.name,
          quantity: String(item.quantity),
          unit: item.unit,
        });
        setEditingItemId(item.id);
        setFormFieldIndex(0);
        setDetailMode('edit');
        return;
      }

      // Delete selected item
      if (input === 'x' && detailItems[selectedIndex]) {
        deleteListItem(detailItems[selectedIndex].id);
        if (activeListId !== null) loadDetail(activeListId);
        return;
      }

      // Adjust quantity shortcuts
      if ((input === '+' || input === '-') && detailItems[selectedIndex]) {
        const item = detailItems[selectedIndex];
        const newQty = Math.max(0, item.quantity + (input === '+' ? 1 : -1));
        updateListItem(item.id, { quantity: newQty });
        if (activeListId !== null) loadDetail(activeListId);
        return;
      }

      // Export to markdown
      if (input === 'm' && activeList) {
        const filePath = exportToMarkdown(activeList.name, detailItems);
        setStatusMessage(t('shoppingLists.status.exported', language, { path: filePath }));
        return;
      }

      // Export to PDF
      if (input === 'p' && activeList) {
        exportToPdf(activeList.name, detailItems).then(
          (filePath) =>
            setStatusMessage(t('shoppingLists.status.exported', language, { path: filePath })),
          () => setStatusMessage(t('shoppingLists.status.pdfFailed', language)),
        );
        return;
      }

      // Mark selected item as bought → add to inventory
      if (input === 's' && detailItems[selectedIndex]) {
        const item = detailItems[selectedIndex];
        addOrUpdateInventoryItem({ name: item.name, quantity: item.quantity, unit: item.unit });
        setStatusMessage(t('shoppingLists.status.boughtOne', language, { name: item.name }));
        return;
      }

      // Mark ALL items as bought → add all to inventory
      if (input === 'S' && detailItems.length > 0) {
        const items = detailItems.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        }));
        const count = addItemsToInventory(items);
        setStatusMessage(t('shoppingLists.status.boughtAll', language, { count }));
        return;
      }
    }
  });

  // ── Render: Main list screen ─────────────────────────────────────────
  if (screen === 'list') {
    const visibleListItems = filteredLists.slice(scrollOffset, scrollOffset + listItemsPerPage);

    // Build grid rows
    const gridRows: ShoppingListRow[][] = [];
    for (let r = 0; r < listGridRowsPerPage; r++) {
      const row: ShoppingListRow[] = [];
      for (let c = 0; c < listGridCols; c++) {
        const idx = r * listGridCols + c;
        const list = visibleListItems[idx];
        if (list) row.push(list);
      }
      if (row.length > 0) gridRows.push(row);
    }

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
            title={t('shoppingLists.title', language)}
            viewMode='grid'
            onToggleView={() => {}}
            showViewToggle={false}
            searchQuery={search}
            onSearchChange={setSearch}
            isSearching={isSearching}
            setIsSearching={setIsSearching}
            isActive={screen === 'list' && detailMode === 'normal'}
            language={language}
          />
        </Box>

        {/* Status */}
        <Box height={1} paddingLeft={1}>
          {statusMessage ? <Text color='green'>{statusMessage}</Text> : null}
        </Box>

        {/* Grid body */}
        <Box flexGrow={1} flexShrink={1} overflow='hidden' flexDirection='column'>
          {filteredLists.length === 0 ? (
            <Box paddingLeft={1} paddingTop={1}>
              <Text dimColor>
                {lists.length === 0
                  ? t('shoppingLists.none', language)
                  : t('shoppingLists.noMatch', language)}
              </Text>
            </Box>
          ) : (
            gridRows.map((row, r) => (
              <Box key={`grid-row-${r}`} height={LIST_CARD_HEIGHT + LIST_GRID_GAP_Y}>
                {row.map((list, c) => {
                  const absoluteIndex = scrollOffset + r * listGridCols + c;
                  const isSelected = absoluteIndex === selectedIndex;
                  const preview = listPreviewById.get(list.id);

                  return (
                    <Box
                      key={list.id}
                      width={LIST_CARD_WIDTH}
                      height={LIST_CARD_HEIGHT}
                      marginRight={LIST_GRID_GAP_X}
                      borderStyle={isSelected ? 'double' : 'single'}
                      borderColor={isSelected ? 'yellow' : 'gray'}
                      flexDirection='column'
                      paddingX={1}
                    >
                      <Text bold color={isSelected ? 'yellow' : 'white'} wrap='truncate-end'>
                        {t(`shoppingLists.source.${getListSourceLabel(list.name)}`, language)}
                      </Text>
                      <Text dimColor wrap='truncate-end'>
                        {formatListDateStamp(list.createdAt)}
                      </Text>
                      <Text dimColor wrap='truncate-end'>
                        {formatListTimestamp(list.createdAt)}
                      </Text>
                      {preview && preview.names.length > 0 ? (
                        <>
                          {preview.names.map((name, i) => (
                            <Text key={i} dimColor wrap='truncate-end'>
                              ☐ {name}
                            </Text>
                          ))}
                          {preview.total > MAX_PREVIEW_ITEMS && (
                            <Text dimColor wrap='truncate-end'>
                              {t('shoppingLists.preview.more', language, {
                                count: preview.total - MAX_PREVIEW_ITEMS,
                              })}
                            </Text>
                          )}
                        </>
                      ) : (
                        <Text dimColor>{t('shoppingLists.preview.empty', language)}</Text>
                      )}
                    </Box>
                  );
                })}
              </Box>
            ))
          )}
        </Box>

        {/* Footer */}
        <Box
          marginTop='auto'
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
            [g] <Text color='cyan'>{t('shoppingLists.action.generate', language)}</Text> • [u]{' '}
            <Text color='cyan'>{t('shoppingLists.action.newUserList', language)}</Text> • [x]{' '}
            <Text color='red'>{t('shoppingLists.action.delete', language)}</Text> • ↑↓ row ←→ column
            • Enter open • [r]{' '}
            <Text color='magenta'>{t('shoppingLists.action.scanReceipt', language)}</Text>
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>
            {filteredLists.length === 0 ? 0 : selectedIndex + 1}/{filteredLists.length}
          </Text>
        </Box>
      </Box>
    );
  }

  // ── Render: Detail screen ────────────────────────────────────────────
  const visibleDetailItems = detailItems.slice(scrollOffset, scrollOffset + detailRowsPerPage);
  const hasAboveDetail = scrollOffset > 0;
  const hasBelowDetail = scrollOffset + detailRowsPerPage < detailItems.length;

  return (
    <Box
      flexDirection='column'
      height={screenHeight}
      width={screenWidth}
      paddingLeft={2}
      paddingRight={1}
    >
      {/* Header */}
      <Box flexShrink={0} height={3} overflow='hidden' borderStyle='single' paddingLeft={1}>
        <Text bold color='cyan' wrap='truncate-end'>
          📋 {activeList?.name ?? t('shoppingLists.detail.titleFallback', language)}
        </Text>
        <Text dimColor wrap='truncate-end'>
          {' '}
          {t('shoppingLists.detail.shortcuts', language)}
        </Text>
      </Box>

      {/* Status */}
      <Box height={1} paddingLeft={1}>
        {statusMessage ? <Text color='green'>{statusMessage}</Text> : null}
      </Box>

      {/* Table header */}
      <Box height={TABLE_HEADER_HEIGHT} flexShrink={0} paddingLeft={1} paddingRight={2}>
        <Box paddingLeft={2.5} width={itemColWidth}>
          <Text inverse color='magenta' bold>
            {' '}
            {t('shoppingLists.detail.col.item', language)}{' '}
          </Text>
        </Box>
        <Box width={qtyColWidth}>
          <Text inverse color='magenta' bold>
            {' '}
            {t('shoppingLists.detail.col.qty', language)}{' '}
          </Text>
        </Box>
        <Box width={unitColWidth}>
          <Text inverse color='magenta' bold>
            {' '}
            {t('shoppingLists.detail.col.unit', language)}{' '}
          </Text>
        </Box>
      </Box>

      {/* Items list */}
      <Box
        height={detailRowsPerPage + DETAIL_INDICATOR_ROWS}
        flexShrink={0}
        overflow='hidden'
        flexDirection='column'
      >
        {detailItems.length === 0 ? (
          <Box paddingLeft={1}>
            <Text dimColor>{t('shoppingLists.detail.empty', language)}</Text>
          </Box>
        ) : (
          <>
            <Box height={1}>
              {hasAboveDetail ? (
                <Text dimColor>{t('shoppingLists.detail.moreUp', language)}</Text>
              ) : null}
            </Box>
            {visibleDetailItems.map((item) => {
              const isSelected = detailItems[selectedIndex]?.id === item.id;

              return (
                <Box key={item.id} height={1} paddingLeft={1} paddingRight={3}>
                  <Box width={itemColWidth}>
                    <Text color={isSelected ? 'yellow' : undefined}>
                      {isSelected ? '▶ ' : '  '}
                    </Text>
                    <Text color={isSelected ? undefined : 'gray'} wrap='truncate-end'>
                      {item.name}
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
            })}
            <Box height={1}>
              {hasBelowDetail ? (
                <Text dimColor>{t('shoppingLists.detail.moreDown', language)}</Text>
              ) : null}
            </Box>
          </>
        )}
      </Box>

      {/* Footer */}
      <Box
        marginTop='auto'
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
          [a] <Text color='cyan'>{t('shoppingLists.action.add', language)}</Text> • [e]{' '}
          <Text color='yellow'>{t('shoppingLists.action.edit', language)}</Text> • [x]{' '}
          <Text color='red'>{t('shoppingLists.action.delete', language)}</Text> • [+/-]{' '}
          {t('shoppingLists.detail.col.qty', language)} • [s]{' '}
          <Text color='green'>{t('shoppingLists.action.buy', language)}</Text> • [S]{' '}
          <Text color='green'>{t('shoppingLists.action.buyAll', language)}</Text> •{' '}
          {t('shoppingLists.detail.escBack', language)}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {detailItems.length === 0 ? 0 : selectedIndex + 1}/{detailItems.length}
        </Text>
      </Box>

      {/* Add/Edit modal overlay */}
      {(detailMode === 'add' || detailMode === 'edit') && (
        <Box position='absolute' width='60%' alignSelf='center' marginTop={5}>
          <Box
            flexDirection='column'
            borderStyle='double'
            borderColor='yellow'
            padding={1}
            backgroundColor='black'
          >
            <Text bold color='yellow' backgroundColor='black'>
              {detailMode === 'add'
                ? t('shoppingLists.modal.addTitle', language)
                : t('shoppingLists.modal.editTitle', language)}
            </Text>

            {ADD_EDIT_FIELDS.map((field, idx) => {
              const isFocused = idx === formFieldIndex;
              const isUnit = field === 'unit';

              return (
                <Box key={field} backgroundColor='black'>
                  <Box width={12} backgroundColor='black'>
                    <Text
                      backgroundColor='black'
                      color={isFocused ? 'cyan' : 'white'}
                      bold={isFocused}
                    >
                      {isFocused
                        ? `> ${t(`shoppingLists.field.${field}`, language)}:`
                        : `  ${t(`shoppingLists.field.${field}`, language)}:`}
                    </Text>
                  </Box>

                  <Box backgroundColor='black' flexGrow={1} paddingX={1}>
                    {isUnit ? (
                      <Text backgroundColor='black' color={isFocused ? 'yellow' : 'white'}>
                        {isFocused ? '◀ ' : ''}
                        {formValues.unit}
                        {isFocused ? ' ▶' : ''}
                      </Text>
                    ) : (
                      <>
                        <Text backgroundColor='black' color='white'>
                          {formValues[field]}
                        </Text>
                        {isFocused && (
                          <Text backgroundColor='black' color='cyan'>
                            █
                          </Text>
                        )}
                      </>
                    )}
                  </Box>
                </Box>
              );
            })}

            <Text dimColor backgroundColor='black'>
              {t('shoppingLists.modal.hint.base', language)}
              {ADD_EDIT_FIELDS[formFieldIndex] === 'unit'
                ? t('shoppingLists.modal.hint.unit', language)
                : ''}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
