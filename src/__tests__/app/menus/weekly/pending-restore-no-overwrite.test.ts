// src/__tests__/app/menus/weekly/pending-restore-no-overwrite.test.ts
// Issue #1629 (#1609 の整合ゲートの残り):
//   週間献立の画面に入り直したとき、生成中の行 (GET /api/ai/menu/weekly/pending) を見つけた経路 (fetchPlan・checkPendingRequests) が、
//   すでに生成中で進捗が進んでいても setIsGenerating(true) (GEN_START = 進捗を null に戻す) と空の進捗 (pendingRestoreProgress) で
//   進捗を置き直していた。phase・message・totalSlots が最初のポーリングが返るまでの 1 往復だけ空になり、見出しが既定の文に戻る。
//   起きる場面: (a) 生成中にリロードしたとき、restoreGeneration が DB の進捗を置いたあとに fetchPlan の pending の経路が遅れて着く
//              (b) 週のキャッシュが切れたあとに同じ週へ戻ったとき
//   → GEN_RESUME_PENDING (resumePendingGenerationAction): 生成中にし、進捗がまだ無い (null) ときだけ空の進捗を置く。
//     見分けは reducer の中で今の状態に対して行う (fetchPlan は前の描画の setter を握っているので、呼び出し側では古い値を見る)。
//
// 1. reducer の挙動 (すでに進捗があるときは残す・null のときは置く・生成中でないときは前の進捗を引き継がない)
// 2. 画面と同じ組み方 (useReducer + 前の描画で握った callback) で、場面 (a) (b) の順に action が届いても進捗が残ること
// 3. page.tsx の resumePendingGeneration がこの action を送ること (配線)

import React, { useCallback, useReducer } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import {
  convertV4ProgressToUIFormat,
  pendingRestoreProgress,
  resumePendingGenerationAction,
} from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  type AiGenerationAction,
  type AiGenerationState,
  type GenerationProgress,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';

const WEEKLY_DIR = path.resolve(__dirname, '../../../../app/(main)/menus/weekly');
const pageSource = fs.readFileSync(path.join(WEEKLY_DIR, 'page.tsx'), 'utf-8');

/** 生成中に DB から復元した進捗 (究極モードの 2 工程目・枠 21 のうち 9 済み) */
const DB_TOTAL_SLOTS = 21;
const DB_COMPLETED_SLOTS = 9;
const DB_REVIEW_STEP = 2;
const DB_ULTIMATE_TOTAL_STEPS = 6;
const dbProgress: GenerationProgress = convertV4ProgressToUIFormat(
  {
    currentStep: DB_REVIEW_STEP,
    totalSteps: DB_ULTIMATE_TOTAL_STEPS,
    message: '献立のバランスをチェック中...',
    completedSlots: DB_COMPLETED_SLOTS,
    totalSlots: DB_TOTAL_SLOTS,
  },
  true,
);

/** 生成中で、進捗がすでに進んでいる状態 */
function generatingWith(progress: GenerationProgress | null): AiGenerationState {
  return { ...initialAiGenerationState, isGenerating: true, generationProgress: progress };
}

describe('aiGenerationReducer GEN_RESUME_PENDING: 入り直しの復元は進んだ進捗を上書きしない (#1629)', () => {
  it('前提: 復元した進捗には見出しの文・工程・枠の数がある (空の進捗とは違う)', () => {
    expect(dbProgress.phase).not.toBe('');
    expect(dbProgress.message).toBe('献立のバランスをチェック中...');
    expect(dbProgress.totalSlots).toBe(DB_TOTAL_SLOTS);
    expect(dbProgress.percentage).toBeGreaterThan(0);
  });

  it.each([true, false])(
    'すでに生成中で進捗があるときは、空の進捗 (ultimateMode: %p) で上書きしない (phase・message・totalSlots・割合が残る)',
    (ultimateMode) => {
      const before = generatingWith(dbProgress);
      const after = aiGenerationReducer(before, resumePendingGenerationAction(ultimateMode));
      expect(after.isGenerating).toBe(true);
      expect(after.generationProgress).toBe(dbProgress);
      expect(after.generationProgress).toEqual(dbProgress);
    },
  );

  it.each([true, false])('生成中で進捗が null のときは、空の進捗 (ultimateMode: %p) を置く', (ultimateMode) => {
    const after = aiGenerationReducer(generatingWith(null), resumePendingGenerationAction(ultimateMode));
    expect(after.isGenerating).toBe(true);
    expect(after.generationProgress).toEqual(pendingRestoreProgress(ultimateMode));
  });

  it('生成中でないときは生成中にして空の進捗を置く (以前の setIsGenerating(true) + 空の進捗と同じ)', () => {
    const after = aiGenerationReducer(initialAiGenerationState, resumePendingGenerationAction(true));
    expect(after.isGenerating).toBe(true);
    expect(after.generationProgress).toEqual(pendingRestoreProgress(true));
  });

  it('生成中でないのに前の進捗が残っているときは引き継がない (GEN_START と同じく別の生成の進捗を持ち越さない)', () => {
    const stale: AiGenerationState = { ...initialAiGenerationState, isGenerating: false, generationProgress: dbProgress };
    const after = aiGenerationReducer(stale, resumePendingGenerationAction(false));
    expect(after.isGenerating).toBe(true);
    expect(after.generationProgress).toEqual(pendingRestoreProgress(false));
  });

  it('生成中の 1 食 (generatingMeal) や失敗の表示など、他の状態には触れない', () => {
    const before: AiGenerationState = {
      ...generatingWith(dbProgress),
      generatingMeal: { dayIndex: 3, mealType: 'dinner' },
      isRegenerating: true,
    };
    const after = aiGenerationReducer(before, resumePendingGenerationAction(true));
    expect(after).toEqual(before);
  });

  it('(以前の経路) GEN_START → 空の進捗の置き直しは、進んだ進捗を消していた — この action に替えた理由', () => {
    const restarted = aiGenerationReducer(generatingWith(dbProgress), { type: 'GEN_START' });
    const placed = aiGenerationReducer(restarted, { type: 'GEN_PROGRESS', payload: pendingRestoreProgress(true) });
    expect(placed.generationProgress?.message).toBe('');
    expect(placed.generationProgress?.phase).toBe('');
    expect(placed.generationProgress?.totalSlots).toBeUndefined();
  });
});

describe('画面と同じ組み方: 前の描画で握った callback から届いても、進んだ進捗を上書きしない (#1629)', () => {
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
    dispatch: React.Dispatch<AiGenerationAction>;
    resume: (ultimateMode: boolean) => void;
  }

  /** 週間献立の画面と同じく useReducer(aiGenerationReducer) を持ち、resumePendingGeneration と同じ形の callback を作る */
  function mount(): { latest: () => Captured; first: Captured } {
    const renders: Captured[] = [];
    function Harness() {
      const [state, dispatch] = useReducer(aiGenerationReducer, initialAiGenerationState);
      const resume = useCallback((ultimateMode: boolean) => {
        dispatch(resumePendingGenerationAction(ultimateMode));
      }, []);
      renders.push({ state, dispatch, resume });
      return null;
    }
    act(() => {
      root.render(React.createElement(Harness));
    });
    return { latest: () => renders[renders.length - 1], first: renders[0] };
  }

  it('(a) 生成中のリロード: restoreGeneration が DB の進捗を置いたあとに、fetchPlan の pending の経路が遅れて着く', () => {
    const { latest, first } = mount();
    // fetchPlan はマウント時の描画の callback を握ったまま、週のデータと pending の応答を待つ
    const fetchPlanResume = first.resume;
    expect(first.state.generationProgress).toBeNull();

    // その間に restoreGeneration が生成中にし、DB の進捗を置く
    act(() => {
      latest().dispatch({ type: 'GEN_START' });
      latest().dispatch({ type: 'GEN_PROGRESS', payload: dbProgress });
    });
    expect(latest().state.generationProgress).toEqual(dbProgress);

    // fetchPlan の pending の経路が遅れて着く (握っているのは進捗が null だった描画の callback)
    act(() => {
      fetchPlanResume(true);
    });
    expect(latest().state.isGenerating).toBe(true);
    expect(latest().state.generationProgress).toEqual(dbProgress);
    expect(latest().state.generationProgress?.message).toBe('献立のバランスをチェック中...');
  });

  it('(b) キャッシュが切れたあとに同じ週へ戻る: ポーリングで進んだ進捗のまま、もう一度 pending の経路を通る', () => {
    const { latest } = mount();
    act(() => {
      latest().resume(true);
    });
    expect(latest().state.generationProgress).toEqual(pendingRestoreProgress(true));

    // 最初のポーリングで進捗が進む
    act(() => {
      latest().dispatch({ type: 'GEN_PROGRESS', payload: dbProgress });
    });
    // 週を移って戻ってきた fetchPlan が、もう一度 pending の経路を通る
    act(() => {
      latest().resume(true);
    });
    expect(latest().state.generationProgress).toEqual(dbProgress);
  });

  it('進捗がまだ無いときは、その callback から空の進捗が置かれる (段の印が入る)', () => {
    const { latest, first } = mount();
    act(() => {
      first.resume(true);
    });
    expect(latest().state.isGenerating).toBe(true);
    expect(latest().state.generationProgress).toEqual(pendingRestoreProgress(true));
    expect(latest().state.generationProgress?.isUltimateMode).toBe(true);
  });
});

describe('page.tsx: resumePendingGeneration は GEN_RESUME_PENDING を送る (#1629 配線)', () => {
  it('resumePendingGeneration は resumePendingGenerationAction を dispatchAiGen へ送り、setIsGenerating(true) を呼ばない', () => {
    const start = pageSource.indexOf('const resumePendingGeneration = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const end = pageSource.indexOf('}, []);', start);
    expect(end).toBeGreaterThan(start);
    const body = pageSource.slice(start, end);
    expect(body).toContain('dispatchAiGen(resumePendingGenerationAction(ultimateMode));');
    expect(body).toContain('generationCancelledRef.current = false;');
    expect(body).not.toContain('setIsGenerating(true)');
    expect(body).not.toContain('setGenerationProgress(');
  });

  it('入り直しの 2 か所 (fetchPlan・checkPendingRequests) がどちらも resumePendingGeneration を呼ぶ', () => {
    const calls = pageSource.match(/^\s*resumePendingGeneration\(pendingIsUltimateMode\);$/gm) ?? [];
    expect(calls).toHaveLength(2);
  });
});
