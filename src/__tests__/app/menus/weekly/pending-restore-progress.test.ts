// src/__tests__/app/menus/weekly/pending-restore-progress.test.ts
// Issue #1609 (#1597 の残り):
//   2. 画面に入り直して生成中の行 (GET /api/ai/menu/weekly/pending) を見つけたとき、最初の進捗 (ポーリング・Realtime の応答)
//      が届くまでの間 (数百 ms) は進捗が null で、カード (ProgressTodoCard) は isUltimateMode を読めず通常の段 (PROGRESS_PHASES)
//      で描かれていた。究極モードの生成で一瞬だけ通常の段が出る。
//      → pending の ultimateMode だけを持つ空の進捗 (pendingRestoreProgress) を、監視を始める前に置く。
//   4. 入り直しで他の週の生成中の行なら週を切り替える分岐があったが、pending の route は start_date が違う行を
//      hasPending: false で返すので通らなかった (route の振る舞いは weekly-pending.test.ts で検査する)。
//      → 分岐を消し、表示中の週 (targetDate) で監視する。
//
// 1. 空の進捗の形 (純関数) と、aiGenerationReducer に置いたあとの状態
// 2. その進捗で、カードが画面と同じ選び方 (isUltimateMode で段を選ぶ) で究極の段を描くこと (描画)
// 3. 週間献立の画面 (page.tsx) の入り直しの 2 か所が、監視を始める前に空の進捗を置くこと・週を切り替えないこと
//    (page.tsx は巨大なクライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テストと同じくソースを検査する)

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { PROGRESS_PHASES, ULTIMATE_PROGRESS_PHASES, isUltimateModeWeeklyMenuRequest } from '@homegohan/shared';

import { ProgressTodoCard } from '@/app/(main)/menus/weekly/_components/ProgressTodoCard';
import { convertV4ProgressToUIFormat, pendingRestoreProgress } from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  type GenerationProgress,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';

const WEEKLY_DIR = path.resolve(__dirname, '../../../../app/(main)/menus/weekly');
const pageSource = fs.readFileSync(path.join(WEEKLY_DIR, 'page.tsx'), 'utf-8');

/** コメントの行を除いたソース (経緯のコメントに当たらないように、コードの行だけを検査する) */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
    .join('\n');
}
const pageCode = stripCommentLines(pageSource);

/** 究極モードの段にだけある工程の名前 (通常の段 PROGRESS_PHASES には無い) */
const ULTIMATE_ONLY_LABEL = '栄養バランスを詳細分析';

/** 画面 (page.tsx の ProgressTodoCard の phases) と同じ段の選び方 */
function phasesOf(progress: GenerationProgress | null) {
  return progress?.isUltimateMode ? ULTIMATE_PROGRESS_PHASES : PROGRESS_PHASES;
}

describe('pendingRestoreProgress: 入り直しの最初の進捗が届くまでの空の進捗 (#1609)', () => {
  it.each([true, false])('印 (ultimateMode: %p) だけを持ち、どの工程も始まっていない', (ultimateMode) => {
    expect(pendingRestoreProgress(ultimateMode)).toEqual({
      phase: '',
      message: '',
      percentage: 0,
      isUltimateMode: ultimateMode,
    });
  });

  it('pending の ultimateMode の判定をそのまま段にする (true だけが究極の段・印の無い応答は通常の段)', () => {
    expect(phasesOf(pendingRestoreProgress(isUltimateModeWeeklyMenuRequest(true)))).toBe(ULTIMATE_PROGRESS_PHASES);
    expect(phasesOf(pendingRestoreProgress(isUltimateModeWeeklyMenuRequest(false)))).toBe(PROGRESS_PHASES);
    expect(phasesOf(pendingRestoreProgress(isUltimateModeWeeklyMenuRequest(undefined)))).toBe(PROGRESS_PHASES);
  });

  it('生成の開始 (GEN_START) のあとに置くと究極の段になり、最初の進捗が届いても段と割合が戻らない', () => {
    // 以前: 開始直後の進捗は null で、段は通常 (phasesOf(null) = PROGRESS_PHASES)
    const started = aiGenerationReducer(initialAiGenerationState, { type: 'GEN_START' });
    expect(started.generationProgress).toBeNull();
    expect(phasesOf(started.generationProgress)).toBe(PROGRESS_PHASES);

    const placed = aiGenerationReducer(started, { type: 'GEN_PROGRESS', payload: pendingRestoreProgress(true) });
    expect(placed.isGenerating).toBe(true);
    expect(placed.generationProgress?.isUltimateMode).toBe(true);
    expect(phasesOf(placed.generationProgress)).toBe(ULTIMATE_PROGRESS_PHASES);

    // 最初の進捗 (行を作ったときの V4 形式) が届いたあとも究極の段のまま。割合は空の進捗 (0) から進む
    const first = aiGenerationReducer(placed, {
      type: 'GEN_PROGRESS',
      payload: convertV4ProgressToUIFormat({ currentStep: 0, totalSteps: 6, message: '献立生成を開始しています...' }, true),
    });
    expect(phasesOf(first.generationProgress)).toBe(ULTIMATE_PROGRESS_PHASES);
    expect(first.generationProgress?.percentage).toBeGreaterThan(0);
  });
});

describe('ProgressTodoCard: 空の進捗で、段は印のとおりに描かれる (#1609)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const COLORS = { accent: '#5B8266', purple: '#8B5CF6' };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  /** 画面と同じ選び方で段を渡して描き、カードを開いた (工程の一覧を出した) あとの文 */
  function renderExpanded(progress: GenerationProgress | null): string {
    act(() => {
      root.render(React.createElement(ProgressTodoCard, { progress, colors: COLORS, phases: phasesOf(progress) }));
    });
    const card = container.firstElementChild as HTMLElement;
    act(() => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return container.textContent ?? '';
  }

  it('究極モードの空の進捗は、究極の段 (栄養バランスの詳細分析などの 4〜6 工程) を描く', () => {
    const text = renderExpanded(pendingRestoreProgress(true));
    expect(text).toContain(ULTIMATE_ONLY_LABEL);
    expect(text).toContain(ULTIMATE_PROGRESS_PHASES[ULTIMATE_PROGRESS_PHASES.length - 1].label);
    // message が空なので、見出しは既定の文
    expect(text).toContain('AIが献立を生成中...');
  });

  it('通常の空の進捗は、通常の段を描く', () => {
    const text = renderExpanded(pendingRestoreProgress(false));
    expect(text).not.toContain(ULTIMATE_ONLY_LABEL);
    expect(text).toContain(PROGRESS_PHASES[PROGRESS_PHASES.length - 1].label);
  });

  it('(以前の状態) 進捗が null のときは、究極モードの生成でも通常の段になる — 空の進捗を置く理由', () => {
    const text = renderExpanded(null);
    expect(text).not.toContain(ULTIMATE_ONLY_LABEL);
  });
});

describe('page.tsx: 入り直しの 2 か所は、監視を始める前に空の進捗を置く (#1609 配線)', () => {
  it('カードの段は generationProgress の isUltimateMode で選ぶ (上の描画の検査と同じ選び方)', () => {
    expect(pageSource).toContain(
      'phases={generationProgress?.isUltimateMode ? ULTIMATE_PROGRESS_PHASES : PROGRESS_PHASES}',
    );
  });

  it('pending の判定を受けた 2 か所とも、判定 → 生成中にして空の進捗を置く (すでに進捗があれば残す) → 同じ印で監視を始める、の順', () => {
    const marker = 'const pendingIsUltimateMode = isUltimateModeWeeklyMenuRequest(pendingUltimateMode);';
    const starts: number[] = [];
    for (let i = pageCode.indexOf(marker); i !== -1; i = pageCode.indexOf(marker, i + 1)) starts.push(i);
    expect(starts).toHaveLength(2);

    for (const start of starts) {
      // #1629: 判定の直前で setIsGenerating(true) (GEN_START = 進捗を null に戻す) を呼ばない
      const before = pageCode.slice(0, start).trimEnd();
      expect(before.endsWith('setIsGenerating(true);')).toBe(false);

      const after = pageCode.slice(start + marker.length);
      const lines = after.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      // 生成中にすることと空の進捗を置くことは、reducer が今の状態で見分ける 1 つの action で行う (#1629)
      expect(lines[0]).toBe('resumePendingGeneration(pendingIsUltimateMode);');
      expect(lines[1]).toMatch(/^subscribeToRequestStatus\((targetDate|targetDateStr), requestId, pendingIsUltimateMode\);$/);
    }
    // 空の進捗を setGenerationProgress で直に置き直す経路は残っていない
    expect(pageCode).not.toMatch(/setGenerationProgress\(\s*pendingRestoreProgress\(/);
  });

  it('入り直しで週を切り替えない (pending は他の週の行を返さないので、切り替える分岐は通らなかった)', () => {
    expect(pageCode).not.toMatch(/setWeekStart\(new Date\(pendingStartDate\)\)/);
    expect(pageCode).not.toMatch(/pendingStartDate\s*!==/);
    // 監視は表示中の週 (targetDate) で行う (pending の startDate は、表示中の週と同じか無いかのどちらか)
    expect(pageCode).not.toMatch(/subscribeToRequestStatus\(pendingStartDate/);
  });
});
