// src/__tests__/app/meals/new/fridge-replace-confirm-wiring.test.ts
// #1050 (UX2-04) 回帰防止: meals/new ページの「入れ替える」（既存の冷蔵庫食材を全削除する
// 破壊的操作）に確認が無かった問題の配線を検証する。
//
// meals/new/page.tsx は next/navigation 等を多数 import するクライアントコンポーネントで、
// 既存の ux2-11-cancel-generation-wiring.test.ts と同様に「ソースを直接検査する」
// アプローチを踏襲する（フルレンダリングでの検証は現実的ではないため）。
//
// この配線を1行でも戻すと red になる。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../../src/app/(main)/meals/new/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

describe('meals/new/page.tsx: 「入れ替える」の破壊操作確認配線 (#1050 UX2-04)', () => {
  it('page.tsx が存在し、空でないこと（前提条件）', () => {
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it('「入れ替える」ボタンが saveFridgeItems を直接呼ばず handleFridgeReplaceClick 経由になっていること', () => {
    // ラベルのテキストから直近手前の <button onClick={...} を後方探索する
    // （「追記する」ボタンが手前にあり、前方一致の正規表現だと誤って先頭ボタンを拾うため）
    const labelIdx = pageSource.indexOf('入れ替える</span>');
    expect(labelIdx, '「入れ替える」ラベルが見つかりません').toBeGreaterThan(-1);
    const before = pageSource.slice(0, labelIdx);
    const lastButtonOpenIdx = before.lastIndexOf('<button');
    expect(lastButtonOpenIdx).toBeGreaterThan(-1);
    const buttonBlock = pageSource.slice(lastButtonOpenIdx, labelIdx);
    const onClickMatch = buttonBlock.match(/onClick=\{([^}]*)\}/);
    expect(onClickMatch, '「入れ替える」ボタンの onClick が見つかりません').not.toBeNull();
    const onClickExpr = onClickMatch![1];
    expect(onClickExpr).toMatch(/handleFridgeReplaceClick/);
    expect(onClickExpr).not.toMatch(/saveFridgeItems\(\s*["']replace["']\s*\)/);
  });

  it('handleFridgeReplaceClick が既存件数を取得してから確認ダイアログを開くこと', () => {
    const match = pageSource.match(
      /const handleFridgeReplaceClick = async \(\) => \{([\s\S]*?)\n {2}\};/
    );
    expect(match, 'handleFridgeReplaceClick の定義が見つかりません').not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/fetch\(\s*['"]\/api\/pantry['"]\s*\)/);
    expect(body).toMatch(/setExistingFridgeCount/);
    expect(body).toMatch(/setShowFridgeReplaceConfirm\(true\)/);
  });

  it('showFridgeReplaceConfirm を条件に ConfirmDeleteModal が描画され、onConfirm で saveFridgeItems("replace") を呼ぶこと', () => {
    const idx = pageSource.indexOf('{showFridgeReplaceConfirm &&');
    expect(idx, 'showFridgeReplaceConfirm を条件にした描画ブロックが見つかりません').toBeGreaterThan(-1);
    const block = pageSource.slice(idx, idx + 700);
    expect(block).toMatch(/<ConfirmDeleteModal/);
    expect(block).toMatch(/existingFridgeCount/);
    expect(block).toMatch(/fridgeIngredients\.length/);
    expect(block).toMatch(/onConfirm=\{async \(\) => \{/);
    expect(block).toMatch(/saveFridgeItems\(\s*["']replace["']\s*\)/);
  });

  it('ConfirmDeleteModal は共通コンポーネント (@/components/common/ConfirmDeleteModal) から import されていること', () => {
    expect(pageSource).toMatch(
      /import \{ ConfirmDeleteModal \} from ["']@\/components\/common\/ConfirmDeleteModal["']/
    );
  });
});
