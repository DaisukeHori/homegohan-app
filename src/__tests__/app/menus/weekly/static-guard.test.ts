// src/__tests__/app/menus/weekly/static-guard.test.ts
// Issue #1031: 「週間献立の状態二重管理 (Refactor B 途中停止)」の静的ガードテスト。
//
// page.tsx はこの refactor で pantryStore/shoppingStore/formDraftStore/
// servingsConfigStore を canonical にし、旧来の local useState 群を全廃した。
// モーダル 13 個は store を直接 read/write するため、page.tsx 側で同名の
// useState が「復活」すると再び split-brain (同名 state の二重管理) が発生し、
// モーダルの表示・保存が壊れる (#1031 の症状が再発する)。
//
// このテストは page.tsx をソースとして grep し、設計書 §1 の表に列挙された
// 変数名が `useState(` で再宣言されていないことを機械的に検知する。
// 片側 (page.tsx か、モーダル/store のどちらか一方) だけを直す修正が
// 将来再発した場合に、このテストが red になることを期待する。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);

const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

// Issue #1031 設計書 §1 の表: page.tsx から全廃対象だった local useState 変数名
// (canonical ストア: pantryStore / shoppingStore / formDraftStore / servingsConfigStore)
const CANONICALIZED_VARIABLE_NAMES = [
  // formDraftStore
  'aiChatInput',
  'addMealKey',
  'addMealDayIndex',
  'selectedConditions',
  'editMealName',
  'editMealMode',
  'newFridgeName',
  'newFridgeAmount',
  'newFridgeExpiry',
  'newShoppingName',
  'newShoppingAmount',
  'newShoppingCategory',
  'manualDishes',
  'manualMode',
  'catalogQuery',
  'catalogResults',
  'selectedCatalogProduct',
  'isCatalogSearching',
  'catalogSearchError',
  'photoFiles',
  'photoPreviews',
  'imageGenerationPrompt',
  'imageReferenceFiles',
  'imageReferencePreviews',
  // pantryStore
  'fridgeItems',
  // shoppingStore
  'shoppingList',
  'activeShoppingList',
  'isRegeneratingShoppingList',
  'shoppingListProgress',
  'shoppingListRequestId',
  'shoppingListTotalServings',
  'shoppingRange',
  'shoppingRangeStep',
  // servingsConfigStore
  'servingsConfig',
  'isLoadingServingsConfig',
] as const;

describe('page.tsx static guard (#1031 split-brain regression)', () => {
  it('page.tsx が存在し、空でないこと (前提条件)', () => {
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it.each(CANONICALIZED_VARIABLE_NAMES)(
    '%s が useState( で再宣言されていないこと (store 一本化を維持)',
    (varName) => {
      // `const [varName, setVarName] = useState(...)` 形式の再宣言を検知する。
      // 変数名の前後に単語境界を要求し、部分一致 (例: shoppingList vs shoppingListItem) を避ける。
      const destructurePattern = new RegExp(
        `const\\s*\\[\\s*${varName}\\s*,`,
        'g'
      );
      const matches = pageSource.match(destructurePattern) ?? [];
      expect(
        matches,
        `page.tsx に "${varName}" の useState 再宣言が見つかりました。` +
          ` ${varName} は store (pantryStore/shoppingStore/formDraftStore/servingsConfigStore) の` +
          ` selector 購読または getState() 参照に一本化すること (#1031)。`
      ).toHaveLength(0);
    }
  );

  it('page.tsx が pantryStore/shoppingStore/formDraftStore/servingsConfigStore を import していること', () => {
    expect(pageSource).toMatch(/usePantryStore/);
    expect(pageSource).toMatch(/useShoppingStore/);
    expect(pageSource).toMatch(/useFormDraftStore/);
    expect(pageSource).toMatch(/useServingsConfigStore/);
  });
});
