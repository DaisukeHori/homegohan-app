// src/__tests__/app/menus/weekly/v4-progress-ultimate-mode.test.ts
// Issue #1597: Web の週間献立が progress.totalSteps === 6 で究極モード (#1142) を見分けていて、
// 生成の始めに通常と究極の段を取り違えていた (モバイルの同じ修正は #1582 / PR #1595)。
//
// 行を作ったときの progress.totalSteps は、v4 / v5 の生成の route では枠の数 (targetSlots.length)、
// AI 相談では固定値 (1 / 3 / 21)。Edge Function が最初の進捗で 3 / 6 に書き直すまでの間、
//   - 枠がちょうど 6 の通常の生成 → 究極モードの段
//   - 枠が 6 でない究極モードの生成 → 通常の段
// で表示されていた。直したあとは、究極モードかを生成の印で決める:
//   - 生成を始めた直後: 生成を始めたときの要求 (handleV4Generate の params.ultimateMode)
//   - 入り直し: 生成中の行の確認 (GET /api/ai/menu/weekly/pending) の ultimateMode
//   - 再読み込みの復元: 生成を始めたときに localStorage (v4MenuGenerating) へ保存した要求
//
// 1. 変換 (convertV4ProgressToUIFormat) は、渡された印だけで段を決め、totalSteps を見ないこと
// 2. 週間献立の画面 (page.tsx) が、どの道でも印を渡していること (ソースの検査。page.tsx は巨大な
//    クライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テストと同じ形にする)
// を検査する。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROGRESS_PHASES, ULTIMATE_PROGRESS_PHASES } from '@homegohan/shared';
import { convertV4ProgressToUIFormat } from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import { isUltimateModeWeeklyMenuRequest } from '@/lib/ai/weekly-menu-request-ultimate';

const WEEKLY_DIR = path.resolve(__dirname, '../../../../app/(main)/menus/weekly');
const pageSource = fs.readFileSync(path.join(WEEKLY_DIR, 'page.tsx'), 'utf-8');
const converterSource = fs.readFileSync(path.join(WEEKLY_DIR, '_state/v4ProgressUi.ts'), 'utf-8');

/** 行を作ったとき (v4 / v5 の生成の route) の進捗。totalSteps は枠の数 */
function rowCreatedProgress(slotCount: number) {
  return { currentStep: 0, totalSteps: slotCount, message: '献立生成を開始しています...' };
}

/** 段 (表示の工程の一覧) — 画面は isUltimateMode でこれを選ぶ (page.tsx の ProgressTodoCard の phases) */
function phasesOf(progress: { isUltimateMode?: boolean }) {
  return progress.isUltimateMode ? ULTIMATE_PROGRESS_PHASES : PROGRESS_PHASES;
}

describe('convertV4ProgressToUIFormat: 究極モードの段かは生成の印で決める (#1597)', () => {
  it('枠 6 の通常の生成 (行を作ったときの totalSteps = 6) は通常の段', () => {
    const ui = convertV4ProgressToUIFormat(rowCreatedProgress(6), false);
    expect(ui.isUltimateMode).toBe(false);
    expect(phasesOf(ui)).toBe(PROGRESS_PHASES);
    // 通常の段の生成の工程の割合 (12% から) で、究極モードの割合 (8% から) ではない
    expect(ui.phase).toBe('generating');
    expect(ui.percentage).toBe(12);
  });

  it.each([1, 3, 21])('totalSteps = %i の究極モードの生成 (AI 相談の固定値・枠の数) は究極の段', (totalSteps) => {
    const ui = convertV4ProgressToUIFormat(rowCreatedProgress(totalSteps), true);
    expect(ui.isUltimateMode).toBe(true);
    expect(phasesOf(ui)).toBe(ULTIMATE_PROGRESS_PHASES);
    expect(ui.phase).toBe('generating');
    expect(ui.percentage).toBe(8);
  });

  it('Edge Function が書き直したあとの totalSteps (通常 3 / 究極 6) とも、印と同じ段になる', () => {
    const normal = convertV4ProgressToUIFormat({ currentStep: 3, totalSteps: 3, message: '保存中...（1/2）' }, false);
    expect(normal.isUltimateMode).toBe(false);
    expect(normal.phase).toBe('saving');

    const ultimate = convertV4ProgressToUIFormat({ currentStep: 4, totalSteps: 6, message: '栄養バランスを分析中...（1/2日）' }, true);
    expect(ultimate.isUltimateMode).toBe(true);
    expect(ultimate.phase).toBe('nutrition_analyzing');
  });

  it('totalSteps が 6 でも、印が通常なら通常の段 (以前の totalSteps === 6 の判定には戻さない)', () => {
    const ui = convertV4ProgressToUIFormat({ currentStep: 2, totalSteps: 6, message: 'バランスをチェック中...' }, false);
    expect(ui.isUltimateMode).toBe(false);
    // 通常の段のレビューの割合 (47%)。究極モードなら 28%
    expect(ui.percentage).toBe(47);
  });

  it('UI 形式の進捗・形の分からない進捗でも、段は印で決める', () => {
    expect(convertV4ProgressToUIFormat({ phase: 'generating', percentage: 10 }, true).isUltimateMode).toBe(true);
    expect(convertV4ProgressToUIFormat({ phase: 'generating', percentage: 10 }, false).isUltimateMode).toBe(false);
    expect(convertV4ProgressToUIFormat({ totalSlots: 6 }, true).isUltimateMode).toBe(true);
    expect(convertV4ProgressToUIFormat({ totalSlots: 6 }, false).isUltimateMode).toBe(false);
  });

  it('変換は totalSteps の値で究極モードかを見分けない', () => {
    expect(converterSource).not.toMatch(/totalSteps\s*(===|==|!==|!=|>=|<=|>|<)/);
    expect(converterSource).not.toMatch(/(===|==|!==|!=)\s*progress\.totalSteps/);
  });
});

describe('入り直し (pending の応答) からの印 (#1597)', () => {
  // 画面は pending の ultimateMode を isUltimateModeWeeklyMenuRequest で読み、変換に渡す (下の配線の検査)
  function uiFromPending(pendingUltimateMode: unknown, slotCount: number) {
    return convertV4ProgressToUIFormat(rowCreatedProgress(slotCount), isUltimateModeWeeklyMenuRequest(pendingUltimateMode));
  }

  it('枠 6 の通常の生成 (ultimateMode: false) は通常の段', () => {
    expect(phasesOf(uiFromPending(false, 6))).toBe(PROGRESS_PHASES);
  });

  it('枠 21 の究極モード (ultimateMode: true) は究極の段', () => {
    expect(phasesOf(uiFromPending(true, 21))).toBe(ULTIMATE_PROGRESS_PHASES);
  });

  it('印の無い古い行 (ultimateMode が無い応答) は通常の段', () => {
    expect(phasesOf(uiFromPending(undefined, 6))).toBe(PROGRESS_PHASES);
    expect(phasesOf(uiFromPending(null, 6))).toBe(PROGRESS_PHASES);
  });
});

describe('page.tsx: どの道でも生成の印を渡す (#1597 配線)', () => {
  it('page.tsx に totalSteps による究極モードの判定が残っていない', () => {
    expect(pageSource).not.toMatch(/totalSteps\s*===\s*6/);
    expect(pageSource).not.toMatch(/isUltimateMode\s*=\s*[^;\n]*totalSteps/);
  });

  it('変換の呼び出しはすべて印 (2 つ目の引数) を渡す', () => {
    const calls = pageSource.match(/convertV4ProgressToUIFormat\(([^()]|\([^()]*\))*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, call).toMatch(/,\s*[A-Za-z]+\)$/);
    }
  });

  it('生成を始めた直後は、生成を始めたときの要求 (params.ultimateMode) で決める', () => {
    const start = pageSource.indexOf('const handleV4Generate = async');
    expect(start).toBeGreaterThan(-1);
    const handler = pageSource.slice(start, pageSource.indexOf('\n  };\n', start));
    expect(handler).toContain('const requestedUltimateMode = params.ultimateMode === true;');
    // 最初の進捗 (pending の応答・最初の進捗より前) も要求の段
    expect(handler).toMatch(/setGenerationProgress\(\{[^}]*isUltimateMode: requestedUltimateMode,[^}]*\}\)/);
    expect(handler).toContain('convertV4ProgressToUIFormat(progress, requestedUltimateMode)');
    expect(handler).toContain('convertV4ProgressToUIFormat(dbProgress, requestedUltimateMode)');
  });

  it('入り直し (pending から) は、pending の ultimateMode で決める (週間献立の 2 か所)', () => {
    const destructures = pageSource.match(/ultimateMode: pendingUltimateMode\b/g) ?? [];
    expect(destructures).toHaveLength(2);
    const subscribes = pageSource.match(
      /subscribeToRequestStatus\([^;]*isUltimateModeWeeklyMenuRequest\(pendingUltimateMode\)\)/g,
    ) ?? [];
    expect(subscribes).toHaveLength(2);
  });

  it('監視 (Realtime・ポーリング) は受け取った印で変換する', () => {
    expect(pageSource).toContain(
      'const subscribeToRequestStatus = useCallback((targetDate: string, requestId: string, ultimateMode: boolean) =>',
    );
    expect(pageSource).toContain(
      'const startPolling = useCallback((targetDate: string, requestId: string, ultimateMode: boolean) =>',
    );
    expect(pageSource).toContain('convertV4ProgressToUIFormat(data.progress, ultimateMode)');
    expect(pageSource).toContain('convertV4ProgressToUIFormat(newData.progress, ultimateMode)');
    const pollingCalls = pageSource.match(/startPolling\(targetDate, requestId, ultimateMode\)/g) ?? [];
    expect(pollingCalls).toHaveLength(3);
  });

  it('再読み込みの復元は、生成を始めたときに保存した要求 (v4MenuGenerating の ultimateMode) で決める', () => {
    expect(pageSource).toContain('ultimateMode: storedUltimateMode } = JSON.parse(stored)');
    expect(pageSource).toContain('const restoredUltimateMode = isUltimateModeWeeklyMenuRequest(storedUltimateMode);');
    const restoreCalls = pageSource.match(/convertV4ProgressToUIFormat\([a-zA-Z]+, restoredUltimateMode\)/g) ?? [];
    expect(restoreCalls).toHaveLength(2);
  });
});
