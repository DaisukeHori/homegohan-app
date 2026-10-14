// src/__tests__/app/menus/weekly/state/shoppingStore.test.ts
// Issue #1031: page.tsx の shoppingList/activeShoppingList/isRegeneratingShoppingList/
// shoppingListProgress/shoppingListRequestId/shoppingListTotalServings/shoppingRange/
// shoppingRangeStep local useState を useShoppingStore に一本化。
// 一本化後の store 単体動作 (関数型更新の機械展開を含む) を回帰防止として固定する。

import { describe, it, expect, beforeEach } from 'vitest';
import { useShoppingStore } from '@/app/(main)/menus/weekly/_state/shoppingStore';
import type { ShoppingListItem } from '@/types/domain';

const initialState = useShoppingStore.getState();

const makeItem = (overrides: Partial<ShoppingListItem> = {}): ShoppingListItem => ({
  id: overrides.id ?? 'item-1',
  itemName: overrides.itemName ?? 'にんじん',
  quantity: overrides.quantity ?? '2本',
  category: overrides.category ?? '青果（野菜・果物）',
  isChecked: overrides.isChecked ?? false,
  ...overrides,
} as ShoppingListItem);

describe('useShoppingStore', () => {
  beforeEach(() => {
    useShoppingStore.setState(initialState, true);
  });

  it('初期状態は空/デフォルト値', () => {
    const s = useShoppingStore.getState();
    expect(s.shoppingList).toEqual([]);
    expect(s.activeShoppingList).toBeNull();
    expect(s.isRegeneratingShoppingList).toBe(false);
    expect(s.shoppingListProgress).toBeNull();
    expect(s.shoppingListRequestId).toBeNull();
    expect(s.shoppingListTotalServings).toBeNull();
    expect(s.shoppingRange).toEqual({
      type: 'week',
      todayMeals: ['breakfast', 'lunch', 'dinner'],
      daysCount: 3,
    });
    expect(s.shoppingRangeStep).toBe('range');
  });

  it('setShoppingList は素の値のみ受け取る (page.tsx の getState() 展開パターンを検証)', () => {
    useShoppingStore.getState().setShoppingList([makeItem({ id: 'a' })]);
    // page.tsx addShoppingItem 相当: getState().shoppingList を都度読んでから展開する
    const cur = useShoppingStore.getState().shoppingList;
    useShoppingStore.getState().setShoppingList([...cur, makeItem({ id: 'b' })]);
    expect(useShoppingStore.getState().shoppingList.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('toggleShoppingItem 相当の楽観的更新+ロールバックが getState() 経由で機械展開できる', () => {
    useShoppingStore.getState().setShoppingList([makeItem({ id: 'a', isChecked: false })]);

    // page.tsx toggleShoppingItem の楽観的更新
    const before = useShoppingStore.getState().shoppingList;
    useShoppingStore.getState().setShoppingList(
      before.map((i) => (i.id === 'a' ? { ...i, isChecked: true } : i))
    );
    expect(useShoppingStore.getState().shoppingList[0].isChecked).toBe(true);

    // ロールバック
    const after = useShoppingStore.getState().shoppingList;
    useShoppingStore.getState().setShoppingList(
      after.map((i) => (i.id === 'a' ? { ...i, isChecked: false } : i))
    );
    expect(useShoppingStore.getState().shoppingList[0].isChecked).toBe(false);
  });

  it('resetShoppingState で初期状態に戻る', () => {
    useShoppingStore.getState().setShoppingList([makeItem()]);
    useShoppingStore.getState().setIsRegeneratingShoppingList(true);
    useShoppingStore.getState().setShoppingRangeStep('servings');

    useShoppingStore.getState().resetShoppingState();

    const s = useShoppingStore.getState();
    expect(s.shoppingList).toEqual([]);
    expect(s.isRegeneratingShoppingList).toBe(false);
    expect(s.shoppingRangeStep).toBe('range');
  });

  it('setShoppingRangeStep / setShoppingRange は素の値を反映する (ShoppingRangeModal からの書き込みを想定)', () => {
    useShoppingStore.getState().setShoppingRange({
      type: 'today',
      todayMeals: ['breakfast'],
      daysCount: 3,
    });
    useShoppingStore.getState().setShoppingRangeStep('servings');

    const s = useShoppingStore.getState();
    expect(s.shoppingRange.type).toBe('today');
    expect(s.shoppingRangeStep).toBe('servings');
  });
});
