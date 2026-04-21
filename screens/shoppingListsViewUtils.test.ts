import { describe, expect, it } from 'bun:test';
import { t } from '../services/i18n';
import {
  filterShoppingLists,
  formatListDateStamp,
  formatListTimestamp,
  getListSourceLabel,
  sortShoppingListsNewestFirst,
} from './shoppingListsViewUtils';

const lists = [
  { name: 'Shopping List 3/29/2026', createdAt: '2026-03-29T12:00:00.000Z' },
  { name: 'Receipt 2026-03-28', createdAt: '2026-03-28T10:00:00.000Z' },
  { name: 'Weekend Groceries', createdAt: '2026-03-27T08:00:00.000Z' },
];

describe('shoppingListsViewUtils', () => {
  it('filters shopping lists by createdAt date using case-insensitive query', () => {
    const filtered = filterShoppingLists(lists, '2026-03-28');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe('Receipt 2026-03-28');
  });

  it('returns all lists when date search query is empty', () => {
    const filtered = filterShoppingLists(lists, '   ');
    expect(filtered).toHaveLength(3);
  });

  it('filters shopping lists by source label', () => {
    const receiptFiltered = filterShoppingLists(lists, 'receipt');
    expect(receiptFiltered).toHaveLength(1);
    expect(receiptFiltered[0]?.name).toBe('Receipt 2026-03-28');

    const generatedFiltered = filterShoppingLists(lists, 'generated');
    expect(generatedFiltered).toHaveLength(1);
    expect(generatedFiltered[0]?.name).toBe('Shopping List 3/29/2026');

    const userFiltered = filterShoppingLists(lists, 'user');
    expect(userFiltered).toHaveLength(1);
    expect(userFiltered[0]?.name).toBe('Weekend Groceries');
  });

  it('labels receipt generated lists as Receipt', () => {
    expect(getListSourceLabel('Receipt 2026-03-28')).toBe('Receipt');
  });

  it('labels auto generated shopping lists as Generated', () => {
    expect(getListSourceLabel('Shopping List 3/29/2026')).toBe('Generated');
  });

  it('labels recipes planner lists as Recipes Planner', () => {
    expect(getListSourceLabel('Recipes Planner 3/29/2026')).toBe('Recipes Planner');
  });

  it('labels planner lists as Planner', () => {
    expect(getListSourceLabel('Planner 3/29/2026')).toBe('Planner');
  });

  it('labels manually named lists as User', () => {
    expect(getListSourceLabel('Weekend Groceries')).toBe('User');
  });

  it('maps source labels through i18n keys for English and German', () => {
    expect(t(`shoppingLists.source.${getListSourceLabel('Receipt 2026-03-28')}`, 'en')).toBe(
      'Receipt',
    );
    expect(t(`shoppingLists.source.${getListSourceLabel('Receipt 2026-03-28')}`, 'de')).toBe(
      'Beleg',
    );
    expect(t(`shoppingLists.source.${getListSourceLabel('Weekend Groceries')}`, 'en')).toBe('User');
    expect(t(`shoppingLists.source.${getListSourceLabel('Weekend Groceries')}`, 'de')).toBe(
      'Benutzer',
    );
  });

  it('sorts shopping lists by newest first', () => {
    const sorted = sortShoppingListsNewestFirst(lists);
    expect(sorted.map((list) => list.name)).toEqual([
      'Shopping List 3/29/2026',
      'Receipt 2026-03-28',
      'Weekend Groceries',
    ]);
  });

  it('uses id fallback when timestamps are invalid', () => {
    const unsorted = [
      { id: 1, name: 'One', createdAt: 'invalid' },
      { id: 3, name: 'Three', createdAt: 'invalid' },
      { id: 2, name: 'Two', createdAt: 'invalid' },
      { name: 'No Id', createdAt: 'invalid' },
    ];
    const sorted = sortShoppingListsNewestFirst(unsorted);
    expect(sorted.map((list) => list.name)).toEqual(['Three', 'Two', 'One', 'No Id']);
  });

  it('formats date and time stamps from createdAt', () => {
    expect(formatListDateStamp('2026-03-29T12:34:56.000Z')).toBe('2026-03-29');
    expect(formatListTimestamp('2026-03-29T12:34:56.000Z')).toBe('12:34:56');
  });
});
