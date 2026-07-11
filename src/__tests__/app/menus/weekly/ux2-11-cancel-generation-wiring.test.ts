// src/__tests__/app/menus/weekly/ux2-11-cancel-generation-wiring.test.ts
// Issue #1054 (UX2-11) 回帰防止: AI 生成の「中止する」インフラ
// (handleCancelGeneration / showConfirmCancelGeneration / CONFIRM_CANCEL_GENERATION_OPEN|CLOSE /
//  cancel API) は実装済みだったが、page.tsx 側の呼び出し配線が一つも無く死コード化していた。
//
// page.tsx はモーダル多数・supabase client・router 等を大量に import する巨大な
// クライアントコンポーネントで、既存の static-guard.test.ts と同様に「ソースを直接検査する」
// アプローチを踏襲する（フルレンダリングでの検証は現実的ではないため）。
//
// このテストは、
// 1. <ProgressTodoCard ... /> の呼び出しに onCancel={() => setShowConfirmCancelGeneration(true)}
//    が渡されていること
// 2. showConfirmCancelGeneration を条件に、中止確認モーダル (ConfirmDeleteModal ベース) が
//    onConfirm={handleCancelGeneration} で描画されていること
// を、page.tsx のソーステキストに対する検査で保証する。
// この配線を1行でも戻すと（onCancel prop を消す、または確認モーダルの分岐を消すと）red になる。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);

const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

describe('page.tsx: AI生成「中止する」配線 (#1054 UX2-11 回帰防止)', () => {
  it('page.tsx が存在し、空でないこと (前提条件)', () => {
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it('AI献立生成の ProgressTodoCard に onCancel が配線されていること', () => {
    // <ProgressTodoCard ... /> のうち、AI献立生成用（isGenerating ブロック内）の呼び出しを
    // 抽出し、onCancel prop が渡されていることを確認する。
    const progressTodoCardCalls = pageSource.match(/<ProgressTodoCard[\s\S]*?\/>/g) ?? [];
    expect(
      progressTodoCardCalls.length,
      'page.tsx に <ProgressTodoCard /> の呼び出しが見つかりません'
    ).toBeGreaterThan(0);

    const wiredCalls = progressTodoCardCalls.filter((call) =>
      /onCancel=\{?\(\)\s*=>\s*setShowConfirmCancelGeneration\(true\)\}?/.test(call)
    );
    expect(
      wiredCalls.length,
      'AI献立生成の <ProgressTodoCard /> に onCancel={() => setShowConfirmCancelGeneration(true)} が' +
        ' 配線されていません（中止ボタンが画面に出ない死コード化のリグレッション）'
    ).toBeGreaterThan(0);
  });

  it('showConfirmCancelGeneration を条件に中止確認モーダルが描画され、onConfirm が handleCancelGeneration であること', () => {
    const match = pageSource.match(
      /\{showConfirmCancelGeneration\s*&&\s*\(([\s\S]*?)\/>\s*\)\}/
    );
    expect(
      match,
      'showConfirmCancelGeneration を条件にした確認モーダルの描画ブロックが見つかりません'
    ).not.toBeNull();

    const block = match![1];
    expect(block).toMatch(/onConfirm=\{handleCancelGeneration\}/);
    expect(block).toMatch(/onCancel=\{?\(\)\s*=>\s*setShowConfirmCancelGeneration\(false\)\}?/);
    // window.confirm には戻さない（styled モーダルへの統一を維持）
    expect(block).not.toMatch(/window\.confirm/);
  });

  it('handleCancelGeneration が確定後に showConfirmCancelGeneration を false に戻すこと（モーダルが閉じ残らない）', () => {
    const match = pageSource.match(
      /const handleCancelGeneration = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[/
    );
    expect(match, 'handleCancelGeneration の定義が見つかりません').not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/setShowConfirmCancelGeneration\(false\)/);
  });
});
