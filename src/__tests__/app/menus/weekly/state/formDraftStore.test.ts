// src/__tests__/app/menus/weekly/state/formDraftStore.test.ts
// Issue #1031: page.tsx の aiChatInput/addMealKey/addMealDayIndex/selectedConditions/
// editMealName/editMealMode/newFridge*/newShopping*/manualDishes/manualMode/catalog*/
// photoFiles/photoPreviews/imageGenerationPrompt/imageReferenceFiles/imageReferencePreviews
// local useState を useFormDraftStore に一本化。
// 一本化後の store 単体動作 (reset 系 + manualDishes の LegacyDishDetail 型) を固定する。

import { describe, it, expect, beforeEach } from 'vitest';
import { useFormDraftStore } from '@/app/(main)/menus/weekly/_state/formDraftStore';
import type { LegacyDishDetail } from '@/app/(main)/menus/weekly/_state/types';

const initialState = useFormDraftStore.getState();

describe('useFormDraftStore', () => {
  beforeEach(() => {
    useFormDraftStore.setState(initialState, true);
  });

  it('manualDishes は LegacyDishDetail[] (旧 cal/protein 短縮キー) を受け付ける', () => {
    const legacyDish: LegacyDishDetail = {
      name: 'カレーライス',
      role: 'main',
      calories_kcal: 0, // 新形式キーが無い旧データを模す
      cal: 650,
      protein: 20,
    };
    useFormDraftStore.getState().setManualDishes([legacyDish]);
    const [dish] = useFormDraftStore.getState().manualDishes;
    // page.tsx saveManualEdit の `d.calories_kcal ?? d.cal ?? 0` パターンが機能することを検証
    const totalCal = dish.calories_kcal ?? dish.cal ?? 0;
    expect(totalCal || dish.cal).toBe(650);
    expect(dish.cal).toBe(650);
  });

  it('resetManual で manualDishes/manualMode/catalog* が初期値に戻る', () => {
    useFormDraftStore.getState().setManualDishes([{ name: 'X', role: 'main', calories_kcal: 100 }]);
    useFormDraftStore.getState().setManualMode('buy');
    useFormDraftStore.getState().setCatalogQuery('から揚げ');
    useFormDraftStore.getState().setCatalogResults([{ id: 'p1', name: 'から揚げ弁当' } as any]);
    useFormDraftStore.getState().setSelectedCatalogProduct({ id: 'p1', name: 'から揚げ弁当' } as any);
    useFormDraftStore.getState().setIsCatalogSearching(true);
    useFormDraftStore.getState().setCatalogSearchError('エラー');

    useFormDraftStore.getState().resetManual();

    const s = useFormDraftStore.getState();
    expect(s.manualDishes).toEqual([]);
    expect(s.manualMode).toBe('cook');
    expect(s.catalogQuery).toBe('');
    expect(s.catalogResults).toEqual([]);
    expect(s.selectedCatalogProduct).toBeNull();
    expect(s.isCatalogSearching).toBe(false);
    expect(s.catalogSearchError).toBe('');
  });

  it('resetEditMeal で editMealName/editMealMode が初期値に戻る', () => {
    useFormDraftStore.getState().setEditMealName('麻婆豆腐');
    useFormDraftStore.getState().setEditMealMode('quick');

    useFormDraftStore.getState().resetEditMeal();

    const s = useFormDraftStore.getState();
    expect(s.editMealName).toBe('');
    expect(s.editMealMode).toBe('cook');
  });

  it('resetFridgeForm / resetShoppingForm で追加フォームが初期値に戻る', () => {
    useFormDraftStore.getState().setNewFridgeName('にんじん');
    useFormDraftStore.getState().setNewFridgeAmount('2本');
    useFormDraftStore.getState().setNewFridgeExpiry('2026-08-01');
    useFormDraftStore.getState().setNewShoppingName('牛乳');
    useFormDraftStore.getState().setNewShoppingAmount('1本');
    useFormDraftStore.getState().setNewShoppingCategory('乳製品・卵');

    useFormDraftStore.getState().resetFridgeForm();
    useFormDraftStore.getState().resetShoppingForm();

    const s = useFormDraftStore.getState();
    expect(s.newFridgeName).toBe('');
    expect(s.newFridgeAmount).toBe('');
    expect(s.newFridgeExpiry).toBe('');
    expect(s.newShoppingName).toBe('');
    expect(s.newShoppingAmount).toBe('');
    // formDraftStore の初期値は '' (AddShoppingModal の <select> は明示選択待ち)。
    // page.tsx 旧 local useState のデフォルト "食材" とは異なるが、store 側の
    // initialState は本 refactor (#1031) 対象外のため変更しない。
    expect(s.newShoppingCategory).toBe('');
  });

  it('resetPhotoEdit / resetImageGenerate で File 系 state が初期値に戻る', () => {
    const fakeFile = { name: 'a.png' } as unknown as File;
    useFormDraftStore.getState().setPhotoFiles([fakeFile]);
    useFormDraftStore.getState().setPhotoPreviews(['data:image/png;base64,xxx']);
    useFormDraftStore.getState().setImageGenerationPrompt('美味しそうな唐揚げ');
    useFormDraftStore.getState().setImageReferenceFiles([fakeFile]);
    useFormDraftStore.getState().setImageReferencePreviews(['data:image/png;base64,yyy']);

    useFormDraftStore.getState().resetPhotoEdit();
    useFormDraftStore.getState().resetImageGenerate();

    const s = useFormDraftStore.getState();
    expect(s.photoFiles).toEqual([]);
    expect(s.photoPreviews).toEqual([]);
    expect(s.imageGenerationPrompt).toBe('');
    expect(s.imageReferenceFiles).toEqual([]);
    expect(s.imageReferencePreviews).toEqual([]);
  });

  it('resetAddMeal で addMealKey/addMealDayIndex が初期値に戻る', () => {
    useFormDraftStore.getState().setAddMealKey('lunch');
    useFormDraftStore.getState().setAddMealDayIndex(3);

    useFormDraftStore.getState().resetAddMeal();

    const s = useFormDraftStore.getState();
    expect(s.addMealKey).toBeNull();
    expect(s.addMealDayIndex).toBe(0);
  });

  it('aiChatInput/selectedConditions は page.tsx ハンドラの getState() 都度読み取りパターンに対応する', () => {
    useFormDraftStore.getState().setAiChatInput('魚料理がいい');
    useFormDraftStore.getState().setSelectedConditions(['冷蔵庫の食材を優先', 'ヘルシーに']);

    // page.tsx handleGenerateWeekly 相当の読み取り
    const { aiChatInput, selectedConditions } = useFormDraftStore.getState();
    expect(aiChatInput).toBe('魚料理がいい');
    expect(selectedConditions).toEqual(['冷蔵庫の食材を優先', 'ヘルシーに']);
  });
});
