// src/__tests__/app/menus/weekly/regenerate-improve-polling-guard.test.ts
// Issue #1033 F1b-06: 「単品再生成/献立改善が Realtime 単独監視でローディング取り残し」の
// 静的ガードテスト。
//
// subscribeToRegenerateStatus (単品再生成) と onImprove (献立改善) は Supabase Realtime の
// postgres_changes 購読のみに依存しており、Realtime が切断・タイムアウトすると
// completed/failed イベントを一度も受信できずスピナーが永久に残っていた。
// 週間生成側 subscribeToRequestStatus (2406行付近) は 3秒ポーリング + フォールバックが
// 既に実装済みなのに、再生成・改善側だけ欠けていたのが原因。
//
// このテストは page.tsx をソースとして grep し、
// 1. subscribeToRegenerateStatus 内にステータスAPIへのポーリング呼び出しと
//    5分 (5 * 60 * 1000ms) の上限タイムアウトが存在すること
// 2. onImprove ハンドラ内にも同様のポーリング呼び出しと5分タイムアウトが存在すること
// を機械的に検知する。片方だけ復活・削除されて Realtime 単独に戻る回帰を防ぐ。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_TSX_PATH = path.resolve(
  __dirname,
  '../../../../app/(main)/menus/weekly/page.tsx'
);

const pageSource = fs.readFileSync(PAGE_TSX_PATH, 'utf-8');

function extractFunctionBody(source: string, startMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  expect(startIdx, `"${startMarker}" が page.tsx に見つかりません`).toBeGreaterThan(-1);

  // startMarker 以降で最初の '{' から始めて、対応する '}' までを大雑把に抽出する
  // (厳密な JS パーサではないが、grep ベースの静的ガードとしては十分)
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

describe('page.tsx regenerate/improve polling guard (#1033 F1b-06 regression)', () => {
  it('page.tsx が存在し、空でないこと (前提条件)', () => {
    expect(pageSource.length).toBeGreaterThan(1000);
  });

  it('subscribeToRegenerateStatus がステータスAPIへのフォールバックポーリングを持つこと', () => {
    const body = extractFunctionBody(pageSource, 'const subscribeToRegenerateStatus = useCallback(');
    expect(body).toMatch(/\/api\/ai\/menu\/weekly\/status\?requestId=/);
    expect(body).toMatch(/setInterval\(/);
  });

  it('subscribeToRegenerateStatus が5分の上限タイムアウトを持つこと', () => {
    const body = extractFunctionBody(pageSource, 'const subscribeToRegenerateStatus = useCallback(');
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/5\s*\*\s*60\s*\*\s*1000/);
  });

  it('onImprove ハンドラがステータスAPIへのフォールバックポーリングを持つこと', () => {
    const body = extractFunctionBody(pageSource, 'onImprove={async () => {');
    expect(body).toMatch(/\/api\/ai\/menu\/weekly\/status\?requestId=/);
    expect(body).toMatch(/setInterval\(/);
  });

  it('onImprove ハンドラが5分の上限タイムアウトを持つこと', () => {
    const body = extractFunctionBody(pageSource, 'onImprove={async () => {');
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/5\s*\*\s*60\s*\*\s*1000/);
  });
});
