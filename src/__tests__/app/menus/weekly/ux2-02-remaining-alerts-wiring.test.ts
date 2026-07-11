// src/__tests__/app/menus/weekly/ux2-02-remaining-alerts-wiring.test.ts
// #1050 round-2 (2モデル敵対レビュー Warning 指摘, Sonnet5 発見):
// UX2-02「全生成失敗経路でリトライ可能なUI/alert廃止」が未充足だった残り11箇所
// （単品再生成・単品AI生成・写真解析・AI画像生成・献立改善）の alert() 廃止を確認する。
//
// GenerationResultDialogContent.test.ts が「渡された message.onRetry がどう振る舞うか」を
// behavioral に検証するのに対し、このテストは「11箇所それぞれが実際に alert() ではなく
// setSuccessMessage(...) を呼ぶよう書き換えられているか」を page.tsx のソースに対する
// 関数単位の抽出で機械的に確認する（既存 static-guard.test.ts / ux2-11 系と同じ手法）。
//
// 対象外（意図的に alert() のまま残す。バリデーション用途で生成失敗ではないため #1050 UX2-02
// のスコープ外）: '改善する食事を選択してください' / '対象日が見つかりません' /
// '生成したい料理の説明を入力してください' 等の入力チェック alert、および
// 献立・冷蔵庫の CRUD 系 alert（#1050 の対象は AI 生成失敗系）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

// コメント中の説明文に "alert()" という語そのものが登場するため（このファイル自身の
// コメントも含め）、alert(...) の有無を判定する際はまず行コメントを取り除く。
function stripLineComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '');
}

function extractFunctionBody(source: string, startMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `"${startMarker}" が page.tsx に見つかりません`).toBeGreaterThan(-1);
  let depth = 0;
  let bodyStart = -1;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart !== -1) {
        return source.slice(bodyStart, i + 1);
      }
    }
  }
  throw new Error(`"${startMarker}" の関数本体の終端が見つかりません`);
}

describe('page.tsx: UX2-02 残り11箇所の alert() 廃止 (#1050 round-2)', () => {
  it('regenerateShoppingList: catch が alert ではなく setSuccessMessage(type: error, onRetry) を使うこと', () => {
    const body = extractFunctionBody(pageSource, 'const regenerateShoppingList = async () => {');
    expect(stripLineComments(body)).not.toMatch(/alert\(/);
    expect(body).toMatch(/setSuccessMessage\(\{[\s\S]*?type: 'error'[\s\S]*?onRetry: \(\) => regenerateShoppingList\(\)/);
  });

  it('handleGenerateSingleMeal (単品AI生成): response-not-ok/catch どちらも alert ではなく setSuccessMessage(type: error, onRetry) を使うこと', () => {
    const body = extractFunctionBody(pageSource, 'const handleGenerateSingleMeal = async () => {');
    expect(stripLineComments(body)).not.toMatch(/alert\(/);
    const onRetryCount = (body.match(/onRetry: \(\) => handleGenerateSingleMeal\(\)/g) || []).length;
    expect(onRetryCount, 'response-not-ok と catch の2箇所で onRetry が配線されているはず').toBe(2);
  });

  it('handleRegenerateMeal (単品再生成・同期): response-not-ok/catch どちらも alert ではなく setSuccessMessage(type: error, onRetry) を使うこと（日付未検出のバリデーションalertは対象外）', () => {
    const body = stripLineComments(extractFunctionBody(pageSource, 'const handleRegenerateMeal = async () => {'));
    // バリデーション alert ('日付が見つかりません') はスコープ外として残す
    const alertCalls = [...body.matchAll(/alert\(([^)]*)\)/g)].map((m) => m[1]);
    expect(alertCalls).toEqual(["'日付が見つかりません'"]);
    const onRetryCount = (body.match(/onRetry: \(\) => handleRegenerateMeal\(\)/g) || []).length;
    expect(onRetryCount).toBe(2);
  });

  it('subscribeToRegenerateStatus (単品再生成・非同期失敗検知): alert ではなく setSuccessMessage(type: error) を使うこと（対象meal情報が失われているためonRetryは付けない設計）', () => {
    const body = extractFunctionBody(pageSource, 'const subscribeToRegenerateStatus = useCallback((requestId: string, weekStartDate: string) => {');
    expect(stripLineComments(body)).not.toMatch(/alert\(/);
    expect(body).toMatch(/title: '食事の再生成に失敗しました'/);
    expect(body).toMatch(/type: 'error'/);
  });

  it('analyzePhotoWithAI (写真解析): response-not-ok/catch どちらも alert ではなく setSuccessMessage(type: error, onRetry) を使うこと', () => {
    const body = extractFunctionBody(pageSource, 'const analyzePhotoWithAI = async () => {');
    expect(stripLineComments(body)).not.toMatch(/alert\(/);
    const onRetryCount = (body.match(/onRetry: \(\) => analyzePhotoWithAI\(\)/g) || []).length;
    expect(onRetryCount).toBe(2);
  });

  it('generateMealImage (AI画像生成): catch が alert ではなく setSuccessMessage(type: error, onRetry) を使うこと（説明未入力のバリデーションalertは対象外）', () => {
    const body = stripLineComments(extractFunctionBody(pageSource, 'const generateMealImage = async () => {'));
    const alertCalls = [...body.matchAll(/alert\(([^)]*)\)/g)].map((m) => m[1]);
    expect(alertCalls).toEqual(["'生成したい料理の説明を入力してください'"]);
    expect(body).toMatch(/onRetry: \(\) => generateMealImage\(\)/);
  });

  it('handleImprove (献立改善): 非同期失敗はモーダル再オープンretry、同期catchは自己再実行retryを使うこと（選択未了/対象日未検出のバリデーションalertは対象外）', () => {
    const body = stripLineComments(extractFunctionBody(pageSource, 'const handleImprove = async () => {'));
    const alertCalls = [...body.matchAll(/alert\(([^)]*)\)/g)].map((m) => m[1]);
    expect(alertCalls.sort()).toEqual(["'改善する食事を選択してください'", "'対象日が見つかりません'"].sort());
    expect(body).toMatch(/onRetry: \(\) => setShowImproveMealModal\(true\)/);
    expect(body).toMatch(/onRetry: \(\) => handleImprove\(\)/);
  });

  it('ImproveMealModal の onImprove が handleImprove に配線されていること（匿名関数への巻き戻り防止）', () => {
    expect(pageSource).toMatch(/onImprove=\{handleImprove\}/);
  });
});
