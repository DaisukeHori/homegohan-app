// src/__tests__/app/menus/weekly/progress-if-empty-stale-setter.test.ts
// Issue #1644 (#1629 の整合ゲートの候補):
//   週間献立の setGenerationProgress は関数形 (prev) => … を受け取り、prev をその setter を握った描画の時点の
//   aiGen.generationProgress で解決していた。ポーリング (restoreGeneration・献立の改善) の closure は古い setter を握るので、
//   setGenerationProgress((prev) => prev ?? DB の進捗) の「null のときだけ置く」が効かず、prev が古い値 (null) になって
//   今の進捗を DB の値で置き直していた (割合は GEN_PROGRESS の Math.max で戻らないが、文・段は古い DB の値に変わりうる)。
//   → GEN_PROGRESS_IF_EMPTY: 「今の進捗が null のときだけ置く」を reducer の action にし、今の状態で判定させる。
//     setGenerationProgress は関数形を受け取らない形にした (古い値で解決する経路そのものを無くす)。
//
// 1. reducer の挙動 (今が null なら置く・進捗があれば残す・Math.max のクランプは GEN_PROGRESS と同じ)
// 2. 既存の action (GEN_RESUME_PENDING・GEN_PROGRESS・GEN_PROGRESS_CLEAR・GEN_SUCCESS・GEN_FAIL) の挙動は変わらない
// 3. 画面と同じ組み方 (useReducer + 前の描画で握った setter) で、古い setter から呼んでも今の進捗を上書きしない
// 4. page.tsx の配線 (2 か所のポーリングが setGenerationProgressIfEmpty を呼ぶ・関数形の setter が残っていない)

import React, { act, useCallback, useReducer } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { convertV4ProgressToUIFormat, pendingRestoreProgress } from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  type AiGenerationAction,
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

describe('aiGenerationReducer GEN_PROGRESS_IF_EMPTY: 今の進捗が null のときだけ置く (#1644)', () => {
  it('前提: 今の進捗と DB の進捗は、文・段・割合が違う', () => {
    expect(liveProgress.message).not.toBe(dbProgress.message);
    expect(liveProgress.completedSlots).not.toBe(dbProgress.completedSlots);
    expect(liveProgress.percentage).toBeGreaterThan(dbProgress.percentage);
  });

  it('今が null なら payload を置く (GEN_PROGRESS を null から送ったときと同じ結果)', () => {
    const before = generatingWith(null);
    const after = aiGenerationReducer(before, { type: 'GEN_PROGRESS_IF_EMPTY', payload: dbProgress });
    expect(after.generationProgress).toEqual(dbProgress);
    expect(after).toEqual(aiGenerationReducer(before, { type: 'GEN_PROGRESS', payload: dbProgress }));
  });

  it('今が null で生成中でもないときも置く (以前の関数形 prev ?? x と同じ意図)', () => {
    const after = aiGenerationReducer(initialAiGenerationState, { type: 'GEN_PROGRESS_IF_EMPTY', payload: dbProgress });
    expect(after.generationProgress).toEqual(dbProgress);
    expect(after.isGenerating).toBe(false);
  });

  it('今に進捗があれば何も変えない (同じ state をそのまま返す・文も段も割合も残る)', () => {
    const before = generatingWith(liveProgress);
    const after = aiGenerationReducer(before, { type: 'GEN_PROGRESS_IF_EMPTY', payload: dbProgress });
    expect(after).toBe(before);
    expect(after.generationProgress?.message).toBe(LIVE_MESSAGE);
    expect(after.generationProgress?.completedSlots).toBe(LIVE_COMPLETED_SLOTS);
    expect(after.generationProgress?.percentage).toBe(liveProgress.percentage);
  });

  it('今の進捗の割合が payload より低くても置き直さない (「残す」は割合の大小によらない)', () => {
    const low: GenerationProgress = { ...liveProgress, percentage: dbProgress.percentage - 1 };
    const before = generatingWith(low);
    const after = aiGenerationReducer(before, { type: 'GEN_PROGRESS_IF_EMPTY', payload: dbProgress });
    expect(after.generationProgress).toBe(low);
  });

  it('置いたあとの GEN_PROGRESS は Math.max のクランプを今までどおり受ける (割合は戻らない)', () => {
    const placed = aiGenerationReducer(generatingWith(null), { type: 'GEN_PROGRESS_IF_EMPTY', payload: liveProgress });
    const older = aiGenerationReducer(placed, { type: 'GEN_PROGRESS', payload: dbProgress });
    expect(older.generationProgress?.percentage).toBe(liveProgress.percentage);
    expect(older.generationProgress?.message).toBe(DB_MESSAGE);
  });

  it('isGenerating・generatingMeal・失敗の文には触れない', () => {
    const before: AiGenerationState = {
      ...generatingWith(null),
      generationFailedError: 'err',
      generationFailedRequestId: 'req-1',
    };
    const after = aiGenerationReducer(before, { type: 'GEN_PROGRESS_IF_EMPTY', payload: dbProgress });
    expect(after.isGenerating).toBe(true);
    expect(after.generatingMeal).toEqual({ dayIndex: 3, mealType: 'dinner' });
    expect(after.generationFailedError).toBe('err');
    expect(after.generationFailedRequestId).toBe('req-1');
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

describe('画面と同じ組み方: 古い描画の setter から呼んでも、今の進捗を上書きしない (#1644)', () => {
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
    setProgressIfEmpty: (v: GenerationProgress) => void;
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
      const setProgressIfEmpty = useCallback((v: GenerationProgress) => {
        dispatch({ type: 'GEN_PROGRESS_IF_EMPTY', payload: v } satisfies AiGenerationAction);
      }, []);
      const legacySetProgress = useCallback(
        (v: GenerationProgress | null | ((prev: GenerationProgress | null) => GenerationProgress | null)) => {
          const next = typeof v === 'function' ? v(state.generationProgress) : v;
          if (next === null) dispatch({ type: 'GEN_PROGRESS_CLEAR' });
          else dispatch({ type: 'GEN_PROGRESS', payload: next });
        },
        [state.generationProgress],
      );
      renders.push({ state, setProgress, setProgressIfEmpty, legacySetProgress });
      return null;
    }
    act(() => {
      root.render(React.createElement(Harness));
    });
    return { latest: () => renders[renders.length - 1], first: renders[0] };
  }

  it('ポーリングが握った (進捗が null だった描画の) setter から呼んでも、Realtime の今の進捗が残る', () => {
    const { latest, first } = mount();
    // ポーリングの closure はマウント時の描画の setter を握ったまま、5 秒ごとに DB の進捗を読む
    const pollingSetIfEmpty = first.setProgressIfEmpty;
    expect(first.state.generationProgress).toBeNull();

    // その間に Realtime が今の進捗を置く
    act(() => {
      latest().setProgress(liveProgress);
    });
    expect(latest().state.generationProgress).toEqual(liveProgress);

    // ポーリングが DB の (古い) 進捗で「null のときだけ置く」を呼ぶ
    act(() => {
      pollingSetIfEmpty(dbProgress);
    });
    expect(latest().state.generationProgress).toEqual(liveProgress);
    expect(latest().state.generationProgress?.message).toBe(LIVE_MESSAGE);
    expect(latest().state.generationProgress?.completedSlots).toBe(LIVE_COMPLETED_SLOTS);
  });

  it('今がまだ null なら、古い setter からでも DB の進捗が置かれる (Realtime が届く前の表示)', () => {
    const { latest, first } = mount();
    act(() => {
      first.setProgressIfEmpty(dbProgress);
    });
    expect(latest().state.generationProgress).toEqual(dbProgress);
  });

  it('進捗を消した (GEN_PROGRESS_CLEAR) あとは、古い setter から置き直せる', () => {
    const { latest, first } = mount();
    act(() => {
      latest().setProgress(liveProgress);
    });
    act(() => {
      latest().setProgress(null);
    });
    act(() => {
      first.setProgressIfEmpty(dbProgress);
    });
    expect(latest().state.generationProgress).toEqual(dbProgress);
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

  it('setGenerationProgressIfEmpty は GEN_PROGRESS_IF_EMPTY を送る (deps が空)', () => {
    const body = callbackBody('setGenerationProgressIfEmpty');
    expect(body).toContain("dispatchAiGen({ type: 'GEN_PROGRESS_IF_EMPTY', payload: v });");
    expect(body).toMatch(/\}, \[\]\);$/);
  });

  it('ポーリングの 2 か所 (restoreGeneration・献立の改善) は setGenerationProgressIfEmpty で DB の進捗を置く', () => {
    expect(codeOnly).toContain(
      'setGenerationProgressIfEmpty(convertV4ProgressToUIFormat(dbProgress, requestedUltimateMode));',
    );
    expect(codeOnly).toContain('setGenerationProgressIfEmpty(convertV4ProgressToUIFormat(dbProgress, false));');
    const calls = codeOnly.match(/setGenerationProgressIfEmpty\(convertV4ProgressToUIFormat\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('setGenerationProgress を関数形で呼ぶ箇所が残っていない', () => {
    expect(codeOnly).not.toMatch(/setGenerationProgress\(\s*\(?\s*[A-Za-z_]+\s*\)?\s*=>/);
    expect(codeOnly).not.toMatch(/v\(aiGen\./);
  });
});
