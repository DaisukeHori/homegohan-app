// src/__tests__/app/menus/weekly/state/pantryStore.test.ts
// Issue #1031: page.tsx の fridgeItems local useState を usePantryStore に一本化。
// 一本化後の store 単体動作 (add/remove/update/reset 相当) を回帰防止として固定する。

import { describe, it, expect, beforeEach } from 'vitest';
import { usePantryStore } from '@/app/(main)/menus/weekly/_state/pantryStore';
import type { PantryItem } from '@/types/domain';

const makeItem = (overrides: Partial<PantryItem> = {}): PantryItem => ({
  id: overrides.id ?? 'item-1',
  name: overrides.name ?? 'にんじん',
  amount: overrides.amount ?? '2本',
  category: overrides.category ?? 'other',
  expirationDate: overrides.expirationDate ?? null,
  ...overrides,
} as PantryItem);

describe('usePantryStore', () => {
  beforeEach(() => {
    usePantryStore.setState({ fridgeItems: [] });
  });

  it('初期状態は空配列', () => {
    expect(usePantryStore.getState().fridgeItems).toEqual([]);
  });

  it('setFridgeItems で一括置換できる', () => {
    const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
    usePantryStore.getState().setFridgeItems(items);
    expect(usePantryStore.getState().fridgeItems).toEqual(items);
  });

  it('addFridgeItem で既存配列に追加される (page.tsx addPantryItem 相当)', () => {
    usePantryStore.getState().setFridgeItems([makeItem({ id: 'a' })]);
    usePantryStore.getState().addFridgeItem(makeItem({ id: 'b', name: 'たまねぎ' }));
    const { fridgeItems } = usePantryStore.getState();
    expect(fridgeItems).toHaveLength(2);
    expect(fridgeItems[1].name).toBe('たまねぎ');
  });

  it('removeFridgeItem で指定 id のみ除去される (page.tsx deletePantryItem 相当)', () => {
    usePantryStore.getState().setFridgeItems([makeItem({ id: 'a' }), makeItem({ id: 'b' })]);
    usePantryStore.getState().removeFridgeItem('a');
    const { fridgeItems } = usePantryStore.getState();
    expect(fridgeItems).toHaveLength(1);
    expect(fridgeItems[0].id).toBe('b');
  });

  it('updateFridgeItem で部分更新できる', () => {
    usePantryStore.getState().setFridgeItems([makeItem({ id: 'a', amount: '1本' })]);
    usePantryStore.getState().updateFridgeItem('a', { amount: '3本' });
    expect(usePantryStore.getState().fridgeItems[0].amount).toBe('3本');
  });
});
