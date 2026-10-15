// src/__tests__/app/menus/weekly/progress-if-empty-stale-setter.test.ts
// Issue #1644 (#1629 の整合ゲートの候補):
//   週間献立の setGenerationProgress は関数形 (prev) => … を受け取り、prev をその setter を握った描画の時点の
//   aiGen.generationProgress で解決していた。ポーリング (restoreGeneration・献立の改善) の closure は古い setter を握るので、
//   setGenerationProgress((prev) => prev ?? DB の進捗) の「null のときだけ置く」が効かず、prev が古い値 (null) になって
//   今の進捗を DB の値で置き直していた (割合は GEN_PROGRESS の Math.max で戻らないが、文・段は古い DB の値に変わりうる)。
//   → GEN_PROGRESS_IF_EMPTY: 「今の進捗が null のときだけ置く」を reducer の action にし、今の状態で判定させる。
//     setGenerationProgress は関数形を受け取らない形にした (古い値で解決する経路そのものを無くす)。
//
// #1663 (#1644 の整合ゲートで見つかった挙動の変化): GEN_PROGRESS_IF_EMPTY をポーリングに使うと、生成の開始で初期の進捗
//   (3% / 5%) を置いたあとは一度も DB の進捗を置かず、Realtime が不通の間は完了まで初期の進捗のまま止まって見えた。
//   ポーリングは GEN_PROGRESS_WHILE_GENERATING (生成中のときだけ GEN_PROGRESS で置く) に替え、「今が null のときだけ置く」が
//   要る経路が無くなったので GEN_PROGRESS_IF_EMPTY と setGenerationProgressIfEmpty は外した
//   (ポーリングの進捗の検査は poll-progress-while-generating.test.ts)。このファイルには、#1644 の残り (関数形を受けない setter) を残す。
//
// 1. 既存の action (GEN_RESUME_PENDING・GEN_PROGRESS・GEN_PROGRESS_CLEAR・GEN_SUCCESS・GEN_FAIL) の挙動は変わらない
// 2. 画面と同じ組み方 (useReducer + 前の描画で握った setter) で、以前の関数形の setter が今の進捗を古い値で上書きしていたこと
// 3. page.tsx の配線 (関数形の setter が残っていない・「今が null のときだけ置く」の経路が残っていない)

import React, { act, useCallback, useReducer } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { convertV4ProgressToUIFormat, pendingRestoreProgress } from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  type AiGenerationState,
  type GenerationProgress,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';

const WEEKLY_DIR = path.resolve(__dirname, '../../../../app/(main)/menus/weekly');
const pageSource = fs.readFileSync(path.join(WEEKLY_DIR, 'page.tsx'), 'utf-8');

/** Realtime で届いた今の進捗 (枠 21 のうち 12 済み・3 工程目) */
const TOTAL_SLOTS = 21;
const LIVE_COMPLETED_SLOTS = 12;
const LIVE_STEP = 3;
const TOTAL_STEPS = 6;
const LIVE_MESSAGE = '献立の栄養を計算中...';
const liveProgress: GenerationProgress = convertV4ProgressToUIFormat(
  {
    currentStep: LIVE_STEP,
    totalSteps: TOTAL_STEPS,
    message: LIVE_MESSAGE,
    completedSlots: LIVE_COMPLETED_SLOTS,
    totalSlots: TOTAL_SLOTS,
  },
  true,
);

/** ポーリングが DB から読んだ、今より古い進捗 (枠 21 のうち 9 済み・2 工程目・別の文) */
const DB_COMPLETED_SLOTS = 9;
const DB_STEP = 2;
const DB_MESSAGE = '献立のバランスをチェック中...';
const dbProgress: GenerationProgress = convertV4ProgressToUIFormat(
  {
    currentStep: DB_STEP,
    totalSteps: TOTAL_STEPS,
    message: DB_MESSAGE,
    completedSlots: DB_COMPLETED_SLOTS,
    totalSlots: TOTAL_SLOTS,
  },
  true,
);

function generatingWith(progress: GenerationProgress | null): AiGenerationState {
  return {
    ...initialAiGenerationState,
    isGenerating: true,
    generatingMeal: { dayIndex: 3, mealType: 'dinner' },
    generationProgress: progress,
  };
}

describe('前提: 今の進捗と DB の進捗', () => {
  it('文・段・割合が違う', () => {
    expect(liveProgress.message).not.toBe(dbProgress.message);
    expect(liveProgress.completedSlots).not.toBe(dbProgress.completedSlots);
    expect(liveProgress.percentage).toBeGreaterThan(dbProgress.percentage);
  });
});

describe('既存の action の挙動は変わらない (#1644 の範囲の外)', () => {
  it('GEN_PROGRESS は今の進捗があっても payload で置き直す (割合だけ Math.max)', () => {
    const after = aiGenerationReducer(generatingWith(liveProgress), { type: 'GEN_PROGRESS', payload: dbProgress });
    expect(after.generationProgress).toEqual({ ...dbProgress, percentage: liveProgress.percentage });
  });

  it('GEN_PROGRESS は割合が上がるときは payload の割合を使う', () => {
    const after = aiGenerationReducer(generatingWith(dbProgress), { type: 'GEN_PROGRESS', payload: liveProgress });
    expect(after.generationProgress).toEqual(liveProgress);
  });

  it('GEN_PROGRESS_CLEAR は進捗だけを null にする', () => {
    const after = aiGenerationReducer(generatingWith(liveProgress), { type: 'GEN_PROGRESS_CLEAR' });
    expect(after.generationProgress).toBeNull();
    expect(after.isGenerating).toBe(true);
    expect(after.generatingMeal).toEqual({ dayIndex: 3, mealType: 'dinner' });
  });

  it('GEN_RESUME_PENDING は生成中で進捗があれば残し、生成中でなければ payload を置く', () => {
    const kept = aiGenerationReducer(generatingWith(liveProgress), {
      type: 'GEN_RESUME_PENDING',
      payload: pendingRestoreProgress(true),
    });
    expect(kept.generationProgress).toBe(liveProgress);
    const stale: AiGenerationState = { ...initialAiGenerationState, generationProgress: liveProgress };
    const replaced = aiGenerationReducer(stale, { type: 'GEN_RESUME_PENDING', payload: pendingRestoreProgress(false) });
    expect(replaced.isGenerating).toBe(true);
    expect(replaced.generationProgress).toEqual(pendingRestoreProgress(false));
  });

  it('GEN_SUCCESS・GEN_FAIL は進捗を null に戻す', () => {
    const success = aiGenerationReducer(generatingWith(liveProgress), { type: 'GEN_SUCCESS' });
    expect(success.generationProgress).toBeNull();
    expect(success.isGenerating).toBe(false);
    expect(success.generatingMeal).toBeNull();
    const fail = aiGenerationReducer(generatingWith(liveProgress), {
      type: 'GEN_FAIL',
      payload: { error: 'e', requestId: 'r' },
    });
    expect(fail.generationProgress).toBeNull();
    expect(fail.isGenerating).toBe(false);
  });
});

describe('画面と同じ組み方: 以前の関数形の setter は、古い描画の値で今の進捗を上書きしていた (#1644)', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  interface Captured {
    state: AiGenerationState;
    setProgress: (v: GenerationProgress | null) => void;
    /** 以前の page.tsx の setGenerationProgress と同じ形 (関数形を握った描画の値で解決する) — 直した理由を示すためだけに使う */
    legacySetProgress: (v: GenerationProgress | null | ((prev: GenerationProgress | null) => GenerationProgress | null)) => void;
  }

  /** 週間献立の画面と同じく useReducer(aiGenerationReducer) を持ち、page.tsx と同じ形の setter を作る */
  function mount(): { latest: () => Captured; first: Captured } {
    const renders: Captured[] = [];
    function Harness() {
      const [state, dispatch] = useReducer(aiGenerationReducer, initialAiGenerationState);
      const setProgress = useCallback((v: GenerationProgress | null) => {
        if (v === null) dispatch({ type: 'GEN_PROGRESS_CLEAR' });
        else dispatch({ type: 'GEN_PROGRESS', payload: v });
      }, []);
      const legacySetProgress = useCallback(
        (v: GenerationProgress | null | ((prev: GenerationProgress | null) => GenerationProgress | null)) => {
          const next = typeof v === 'function' ? v(state.generationProgress) : v;
          if (next === null) dispatch({ type: 'GEN_PROGRESS_CLEAR' });
          else dispatch({ type: 'GEN_PROGRESS', payload: next });
        },
        [state.generationProgress],
      );
      renders.push({ state, setProgress, legacySetProgress });
      return null;
    }
    act(() => {
      root.render(React.createElement(Harness));
    });
    return { latest: () => renders[renders.length - 1], first: renders[0] };
  }

  it('今の setter (GEN_PROGRESS) は握った描画によらず今の状態に対して置く (古い描画の setter と今の setter が同じ)', () => {
    const { latest, first } = mount();
    expect(first.setProgress).toBe(latest().setProgress);
    act(() => {
      latest().setProgress(liveProgress);
    });
    act(() => {
      first.setProgress(dbProgress);
    });
    // 割合は Math.max で戻らない (文・段は届いた値)
    expect(latest().state.generationProgress).toEqual({ ...dbProgress, percentage: liveProgress.percentage });
  });

  it('(以前の形) 関数形 prev ?? x を古い setter で呼ぶと、今の進捗の文と段を DB の値で上書きしていた — 直した理由', () => {
    const { latest, first } = mount();
    const pollingLegacySet = first.legacySetProgress;
    act(() => {
      latest().setProgress(liveProgress);
    });
    act(() => {
      pollingLegacySet((prev) => prev ?? dbProgress);
    });
    expect(latest().state.generationProgress?.message).toBe(DB_MESSAGE);
    expect(latest().state.generationProgress?.completedSlots).toBe(DB_COMPLETED_SLOTS);
    // 割合だけは GEN_PROGRESS の Math.max で戻らない (Issue の記述どおり)
    expect(latest().state.generationProgress?.percentage).toBe(liveProgress.percentage);
  });
});

describe('page.tsx の配線 (#1644)', () => {
  /** コメントの行を除いたコード */
  const codeOnly = pageSource
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  function callbackBody(name: string): string {
    const start = codeOnly.indexOf(`const ${name} = useCallback(`);
    expect(start).toBeGreaterThan(-1);
    const end = codeOnly.indexOf('}, [', start);
    expect(end).toBeGreaterThan(start);
    return codeOnly.slice(start, codeOnly.indexOf('\n', end));
  }

  it('setGenerationProgress は関数形を受け取らず、今の値を握らない (deps が空)', () => {
    const body = callbackBody('setGenerationProgress');
    expect(body).not.toMatch(/typeof v === 'function'/);
    expect(body).not.toContain('aiGen.generationProgress');
    expect(body).toMatch(/\}, \[\]\);$/);
    expect(body).toContain("dispatchAiGen({ type: 'GEN_PROGRESS_CLEAR' });");
    expect(body).toContain("dispatchAiGen({ type: 'GEN_PROGRESS', payload: v });");
  });

  it('「今が null のときだけ置く」の経路 (setGenerationProgressIfEmpty・GEN_PROGRESS_IF_EMPTY) は残っていない (#1663)', () => {
    expect(codeOnly).not.toContain('setGenerationProgressIfEmpty');
    expect(codeOnly).not.toContain('GEN_PROGRESS_IF_EMPTY');
  });

  it('setGenerationProgress を関数形で呼ぶ箇所が残っていない', () => {
    expect(codeOnly).not.toMatch(/setGenerationProgress\(\s*\(?\s*[A-Za-z_]+\s*\)?\s*=>/);
    expect(codeOnly).not.toMatch(/v\(aiGen\./);
  });
});
