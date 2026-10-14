// src/__tests__/app/menus/weekly/cancel-generation-modal-reachability.test.ts
// #1050 round-2 (2モデル敵対レビュー Critical 指摘): AI生成の中止確認モーダル
// (<CancelGenerationConfirmModal />) が、大きな `{activeModal && (...)}` 条件ブロックの
// 内側にネストされていたため、生成開始時に必ず setActiveModal(null) される
// (handleGenerateWeekly 等) 結果、生成中は当該ブロックごと描画されず、
// 「中止する」ボタンから確認モーダルに到達できない状態だった
// (handleCancelGeneration が実質デッドコード化)。
//
// 既存の ux2-11-cancel-generation-wiring.test.ts は「モーダル呼び出しに正しい prop が
// 渡されているか」を正規表現で確認するのみで、「呼び出しがどの JSX 条件分岐の
// 内側にあるか」というネスト位置（＝今回の実バグの原因）は一切検証しておらず、
// このバグを見逃した実績がある（静的 regex テストの限界）。
//
// このテストは正規表現ではなく TypeScript コンパイラ API で page.tsx を実際に
// パースし、AST 上で `<CancelGenerationConfirmModal />` の呼び出しノードの祖先に
// `{activeModal && (...)}` という JSX 条件式（activeModal ゲート）が存在しないことを
// 構造的に検証する。中止確認モーダルの呼び出しを再び activeModal ゲートの内側に
// 戻すと、このテストは red になる（下記コメント参照。手動ミューテーションで実測済み）。

import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);

const CANCEL_MODAL_TAG = 'CancelGenerationConfirmModal';

function parsePageTsx(): ts.SourceFile {
  const source = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');
  return ts.createSourceFile(
    PAGE_TSX_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

/**
 * `{activeModal && ( ... )}` の形をした JsxExpression（"activeModal ゲート"）かどうか。
 * 生成開始経路は必ず setActiveModal(null) するため、このゲートの内側にあるノードは
 * AI 生成中に描画されない。
 */
function isActiveModalGate(node: ts.Node): boolean {
  if (!ts.isJsxExpression(node) || !node.expression) return false;
  const expr = node.expression;
  if (!ts.isBinaryExpression(expr)) return false;
  if (expr.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
  return ts.isIdentifier(expr.left) && expr.left.text === 'activeModal';
}

interface ScanResult {
  totalCalls: number;
  nestedUnderActiveModalGate: number;
}

function scanForCancelModalCalls(sourceFile: ts.SourceFile): ScanResult {
  let totalCalls = 0;
  let nestedUnderActiveModalGate = 0;

  function visit(node: ts.Node, underActiveModalGate: boolean) {
    const nextUnderGate = underActiveModalGate || isActiveModalGate(node);

    const isCancelModalTag =
      (ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(sourceFile) === CANCEL_MODAL_TAG) ||
      (ts.isJsxOpeningElement(node) &&
        node.tagName.getText(sourceFile) === CANCEL_MODAL_TAG);

    if (isCancelModalTag) {
      totalCalls += 1;
      if (nextUnderGate) nestedUnderActiveModalGate += 1;
    }

    ts.forEachChild(node, (child) => visit(child, nextUnderGate));
  }

  visit(sourceFile, false);
  return { totalCalls, nestedUnderActiveModalGate };
}

describe('page.tsx: AI生成中止確認モーダルの到達可能性 (#1050 round-2 Critical 回帰防止, AST検証)', () => {
  it('page.tsx が存在し、CancelGenerationConfirmModal をimportしていること (前提条件)', () => {
    const source = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');
    expect(source).toMatch(/import\s*\{\s*CancelGenerationConfirmModal\s*\}\s*from\s*['"]\.\/_components\/CancelGenerationConfirmModal['"]/);
  });

  it('<CancelGenerationConfirmModal /> の呼び出しが page.tsx に存在すること', () => {
    const sourceFile = parsePageTsx();
    const result = scanForCancelModalCalls(sourceFile);
    expect(
      result.totalCalls,
      '<CancelGenerationConfirmModal /> の呼び出しが page.tsx に見つかりません'
    ).toBeGreaterThan(0);
  });

  it('<CancelGenerationConfirmModal /> の呼び出しが {activeModal && (...)} ゲートの内側にネストされていないこと', () => {
    // 実バグ: 修正前はこのモーダル (旧: インラインの <ConfirmDeleteModal /> による中止確認) が
    // {activeModal && (<>...</>)} という巨大な条件ブロックの内側にあった。
    // 生成中は setActiveModal(null) されているため activeModal は falsy になり、
    // このブロックごと描画されない＝「中止する」ボタンを押しても何も表示されない。
    //
    // ミューテーション感度の実測手順（本テスト作成時に実施済み。再検証する場合の手順）:
    //   1. page.tsx の `<CancelGenerationConfirmModal ... />` 呼び出しを、
    //      一時的に `{activeModal && (` ブロックの内側（例: 'confirmDelete' 分岐の直後）に
    //      貼り戻す。
    //   2. `npx vitest run src/__tests__/app/menus/weekly/cancel-generation-modal-reachability.test.ts`
    //      を実行すると、本 it が red になることを確認する
    //      （nestedUnderActiveModalGate > 0 になるため）。
    //   3. 変更を元に戻し、再度 green になることを確認する。
    const sourceFile = parsePageTsx();
    const result = scanForCancelModalCalls(sourceFile);
    expect(
      result.nestedUnderActiveModalGate,
      '<CancelGenerationConfirmModal /> が {activeModal && (...)} ゲートの内側に' +
        'ネストされています。AI生成中は activeModal が null になり中止確認モーダルへ' +
        '到達不能になる重大リグレッションです（#1050 round-2 Critical）。'
    ).toBe(0);
  });
});
