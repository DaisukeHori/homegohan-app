// src/__tests__/app/pantry/replace-confirm-wiring.test.ts
// #1050 (UX2-04) 回帰防止: pantry ページの「全て置き換え」（既存食材を全削除する破壊的操作）に
// 確認が無かった問題の配線を検証する。
//
// pantry/page.tsx は supabase client / next/navigation 等を多数 import する
// クライアントコンポーネントで、既存の ux2-11-cancel-generation-wiring.test.ts と同様に
// 「ソースを直接検査する」アプローチを踏襲する（フルレンダリングでの検証は現実的ではないため）。
//
// この配線を1行でも戻すと（onClick を handleSaveIngredients に戻す、確認の有無条件を消す等）
// red になる。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(__dirname, '../../../../src/app/(main)/pantry/page.tsx');
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

describe('pantry/page.tsx: 「全て置き換え」の破壊操作確認配線 (#1050 UX2-04)', () => {
  it('page.tsx が存在し、空でないこと（前提条件）', () => {
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it('「全て置き換え」ボタンが handleSaveIngredients を直接呼ばず handleReplaceClick 経由になっていること', () => {
    // ボタンの開始タグ全体〜ラベルまでを取得し、onClick を検査する
    const buttonBlockMatch = pageSource.match(
      /<button\s+onClick=\{([^}]*)\}[\s\S]{0,300}?全て置き換え/
    );
    expect(buttonBlockMatch, '「全て置き換え」ボタンの onClick が見つかりません').not.toBeNull();
    const onClickExpr = buttonBlockMatch![1];
    expect(onClickExpr).toMatch(/handleReplaceClick/);
    expect(onClickExpr).not.toMatch(/handleSaveIngredients\(\s*["']replace["']\s*\)/);
  });

  it('handleReplaceClick が items.length を見て確認要否を分岐していること', () => {
    const match = pageSource.match(
      /const handleReplaceClick = \(\) => \{([\s\S]*?)\n {2}\};/
    );
    expect(match, 'handleReplaceClick の定義が見つかりません').not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/items\.length\s*>\s*0/);
    expect(body).toMatch(/setShowReplaceConfirm\(true\)/);
    expect(body).toMatch(/handleSaveIngredients\(\s*["']replace["']\s*\)/);
  });

  it('showReplaceConfirm を条件に ConfirmDeleteModal が描画され、対象件数(items.length)を含む message かつ onConfirm で handleSaveIngredients("replace") を呼ぶこと', () => {
    const idx = pageSource.indexOf('{showReplaceConfirm &&');
    expect(idx, 'showReplaceConfirm を条件にした描画ブロックが見つかりません').toBeGreaterThan(-1);
    const block = pageSource.slice(idx, idx + 700);
    expect(block).toMatch(/<ConfirmDeleteModal/);
    expect(block).toMatch(/\$\{items\.length\}/);
    expect(block).toMatch(/onConfirm=\{async \(\) => \{/);
    expect(block).toMatch(/handleSaveIngredients\(\s*["']replace["']\s*\)/);
  });

  it('ConfirmDeleteModal は共通コンポーネント (@/components/common/ConfirmDeleteModal) から import されていること', () => {
    expect(pageSource).toMatch(
      /import \{ ConfirmDeleteModal \} from ["']@\/components\/common\/ConfirmDeleteModal["']/
    );
  });
});
