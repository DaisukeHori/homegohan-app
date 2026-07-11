// src/__tests__/app/menus/weekly/ux2-01-02-error-handling-wiring.test.ts
// #1050 (UX2-01 / UX2-02) 回帰防止。
//
// UX2-01: successMessage はエラー通知にも流用されており、`type` 無しでは常に緑チェックの
//   成功見た目で表示されていた（例: title:'エラー' でも ✓ アイコン）。
//   type:'error' を渡した場合は AlertTriangle + 赤系で表示されることを検証する。
// UX2-02: AI 週間献立生成の失敗が alert() 頼みで、既存のリトライ付き失敗パネル
//   (generationFailedError) に集約されていなかった。V4 生成の4つの失敗経路
//   （onError / restore即時失敗 / restore購読中失敗 / ポーリングフォールバック失敗）が
//   すべて alert() ではなく dispatchAiGen({ type: 'GEN_FAIL', ... }) を使うことを検証する。
//
// page.tsx はモーダル多数・supabase client・router 等を大量に import する巨大な
// クライアントコンポーネントで、既存の ux2-11-cancel-generation-wiring.test.ts と同様に
// 「ソースを直接検査する」アプローチを踏襲する。
//
// #1050 round-2: 完了/エラー通知モーダルの中身（アイコン・タイトル・本文・ボタン）は
// GenerationResultDialogContent.tsx に切り出された（onRetry 分岐のテスト容易性のため）。
// アイコン/色の type 分岐はそちらのソースを検査する
// （behavioral レンダリングテストは
//  _components/__tests__/GenerationResultDialogContent.test.ts を参照）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);
const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

const DIALOG_CONTENT_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/_components/GenerationResultDialogContent.tsx'
);
const dialogContentSource = fs.readFileSync(DIALOG_CONTENT_PATH, 'utf-8');

describe('page.tsx: UX2-01 エラー通知の type 分岐', () => {
  it('完了モーダルが GenerationResultDialogContent を使って描画されていること', () => {
    expect(pageSource).toMatch(/<GenerationResultDialogContent\b/);
  });

  it('GenerationResultDialogContent が message.type に応じてアイコン/色を切り替えていること', () => {
    const idx = dialogContentSource.indexOf('data-testid="success-message-icon"');
    expect(idx, '完了モーダルのアイコン領域が見つかりません').toBeGreaterThan(-1);
    const block = dialogContentSource.slice(idx - 200, idx + 600);
    expect(block).toMatch(/message\.type === 'error'/);
    expect(block).toMatch(/AlertTriangle size=\{32\} color=\{colors\.danger\}/);
  });

  it('自動クリーンアップ系の2箇所のエラー通知が type: \'error\' を明示していること', () => {
    const occurrences = [...pageSource.matchAll(/setSuccessMessage\(\{ title: 'エラー'[^}]*\}\)/g)];
    expect(occurrences.length, 'title: \'エラー\' の setSuccessMessage 呼び出しが見つかりません').toBeGreaterThanOrEqual(2);
    for (const m of occurrences) {
      expect(m[0]).toMatch(/type: 'error'/);
    }
  });
});

describe('page.tsx: UX2-02 AI週間献立生成失敗の alert() 廃止', () => {
  it('V4 generation onError が alert ではなく GEN_FAIL を dispatch すること', () => {
    const match = pageSource.match(/onError: \(error\) => \{([\s\S]*?)\n {4}\},/);
    expect(match, 'onError コールバックが見つかりません').not.toBeNull();
    const body = match![1];
    expect(body).toMatch(/dispatchAiGen\(\{ type: 'GEN_FAIL', payload: \{ error, requestId: null \} \}\)/);
    expect(body).not.toMatch(/^\s*alert\(/m);
  });

  it('restore 経路（即時 failed 判定）が GEN_FAIL を dispatch すること', () => {
    const idx = pageSource.indexOf("// 失敗している場合");
    expect(idx, "'失敗している場合' ブロックが見つかりません").toBeGreaterThan(-1);
    const block = pageSource.slice(idx, idx + 400);
    expect(block).toMatch(/dispatchAiGen\(\{\s*type: 'GEN_FAIL',/);
    expect(block).not.toMatch(/^\s*alert\(/m);
  });

  it('restore 経路（subscribeToProgress 中の failed）が GEN_FAIL を dispatch すること', () => {
    const idx = pageSource.indexOf("v4Generation.subscribeToProgress(requestId,");
    expect(idx, 'restore 中の subscribeToProgress 呼び出しが見つかりません').toBeGreaterThan(-1);
    const block = pageSource.slice(idx, idx + 1500);
    expect(block).toMatch(/dispatchAiGen\(\{\s*type: 'GEN_FAIL',/);
    expect(block).not.toMatch(/^\s*alert\(/m);
  });

  it('ポーリングフォールバック経路（handleV4Generate 内）の failed 分岐が GEN_FAIL を dispatch すること', () => {
    const idx = pageSource.indexOf("} else if (status === 'failed') {");
    expect(idx, "ポーリングの status === 'failed' 分岐が見つかりません").toBeGreaterThan(-1);
    const block = pageSource.slice(idx, idx + 600);
    expect(block).toMatch(/dispatchAiGen\(\{\s*type: 'GEN_FAIL',/);
    expect(block).toMatch(/requestId: v4RequestId/);
    expect(block).not.toMatch(/^\s*alert\(/m);
  });
});
