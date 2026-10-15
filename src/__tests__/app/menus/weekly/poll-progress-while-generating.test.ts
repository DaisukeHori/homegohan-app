// src/__tests__/app/menus/weekly/poll-progress-while-generating.test.ts
// Issue #1663 (#1644 の整合ゲートで見つかった挙動の変化):
//   #1644 で、週間献立の画面のポーリング (V4 の生成・献立の改善) は「今の進捗が null のときだけ置く」(GEN_PROGRESS_IF_EMPTY) を
//   使うようになった。ところが V4 の生成と献立の改善は、ポーリングより先に初期の進捗 (3% / 5%) を置くので、Realtime が
//   つながらない間は、ポーリングが DB の進捗を一度も置かず、完了まで「ユーザー情報を取得中... 3%」のまま止まって見えた。
//   → ポーリングは GEN_PROGRESS_WHILE_GENERATING で置く: 生成中のときだけ GEN_PROGRESS と同じに置く (割合は Math.max で戻らない。
//     Realtime も GEN_PROGRESS なので、届くときはそちらが先に進み、遅れて着いたポーリングの応答で割合は戻らない)。
//     完了・失敗・中止のあとに着いた応答では何も置かない (reducer が今の isGenerating で判定)。
//     別の生成が始まったあと (isGenerating はまた true) に着いた前の生成の応答は、tick の監視の印 (#1657) で止める。
//   あわせて、週の表示の setter (setCalendarMealDates・setIsDayNutritionExpanded ほか) を、値だけ受ける形にした
//   (関数形を受けて、setter を握った描画の時点の値で解決する #1644 と同じ型の芽を消す)。
//
// 1. reducer の挙動 (生成中なら GEN_PROGRESS と同じ・生成中でなければ何も変えない)
// 2. 画面の流れ (初期の進捗 → ポーリングの応答・Realtime の進捗・完了・中止・次の生成の開始) を reducer に順に送った結果
// 3. 画面と同じ組み方 (useReducer + 前の描画で握った setter と監視の印を持つ tick) で、Realtime が来なくても 3% から進むこと
// 4. page.tsx の配線 (2 か所のポーリングが印を確かめてから setGenerationProgressWhileGenerating で置く・値だけ受ける setter)
//    (page.tsx は巨大なクライアントコンポーネントで、全体の描画での検証は現実的でないため、既存の配線テストと同じくソースを検査する)

import React, { act, useCallback, useReducer } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  convertV4ProgressToUIFormat,
  type V4GenerationProgress,
} from '@/app/(main)/menus/weekly/_state/v4ProgressUi';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  type AiGenerationAction,
  type AiGenerationState,
  type GenerationProgress,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';
import {
  weekViewReducer,
  initialWeekViewState,
  type WeekViewState,
} from '@/app/(main)/menus/weekly/_state/reducers/weekViewReducer';

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

// ---------------------------------------------------------------------------
// 進捗の値
// ---------------------------------------------------------------------------

const TOTAL_SLOTS = 21;
const NORMAL_TOTAL_STEPS = 3;
const ULTIMATE_TOTAL_STEPS = 6;

/** V4 の生成の初期の進捗 (page.tsx の handleV4Generate と同じ形・3%) */
const V4_INITIAL_PERCENTAGE = 3;
const v4Initial = (ultimateMode: boolean): GenerationProgress => ({
  phase: 'user_context',
  message: 'ユーザー情報を取得中...',
  percentage: V4_INITIAL_PERCENTAGE,
  totalSlots: TOTAL_SLOTS,
  completedSlots: 0,
  isUltimateMode: ultimateMode,
});

/** 献立の改善の初期の進捗 (page.tsx の献立の改善と同じ形・5%) */
const IMPROVE_INITIAL_PERCENTAGE = 5;
const IMPROVE_TARGET_SLOTS = 3;
const improveInitial: GenerationProgress = {
  phase: 'analyzing',
  message: 'AI栄養士の提案を反映中...',
  percentage: IMPROVE_INITIAL_PERCENTAGE,
  totalSlots: IMPROVE_TARGET_SLOTS,
  completedSlots: 0,
};

/** DB の行の進捗 (通常の生成: 1 工程目で 3 枠済み → 2 工程目のバランスの確認 → 3 工程目の栄養計算) */
const COMPLETED_IN_STEP1 = 3;
const dbStep1: V4GenerationProgress = {
  currentStep: 1,
  totalSteps: NORMAL_TOTAL_STEPS,
  message: `献立を生成中... (${COMPLETED_IN_STEP1}/${TOTAL_SLOTS})`,
  completedSlots: COMPLETED_IN_STEP1,
  totalSlots: TOTAL_SLOTS,
};
const dbStep2: V4GenerationProgress = {
  currentStep: 2,
  totalSteps: NORMAL_TOTAL_STEPS,
  message: '献立のバランスをチェック中...',
  completedSlots: TOTAL_SLOTS,
  totalSlots: TOTAL_SLOTS,
};
const dbStep3: V4GenerationProgress = {
  currentStep: 3,
  totalSteps: NORMAL_TOTAL_STEPS,
  message: '栄養計算中...',
  completedSlots: TOTAL_SLOTS,
  totalSlots: TOTAL_SLOTS,
};
/** 究極モードの生成の DB の進捗 (2 工程目のバランスの確認) */
const dbUltimateStep2: V4GenerationProgress = {
  currentStep: 2,
  totalSteps: ULTIMATE_TOTAL_STEPS,
  message: '献立のバランスをチェック中...',
  completedSlots: TOTAL_SLOTS,
  totalSlots: TOTAL_SLOTS,
};

const ui = (db: V4GenerationProgress, ultimateMode = false) => convertV4ProgressToUIFormat(db, ultimateMode);

function generatingWith(progress: GenerationProgress | null): AiGenerationState {
  return { ...initialAiGenerationState, isGenerating: true, generationProgress: progress };
}

function run(state: AiGenerationState, actions: AiGenerationAction[]): AiGenerationState {
  return actions.reduce(aiGenerationReducer, state);
}

const pollAction = (payload: GenerationProgress): AiGenerationAction => ({ type: 'GEN_PROGRESS_WHILE_GENERATING', payload });
const realtimeAction = (payload: GenerationProgress): AiGenerationAction => ({ type: 'GEN_PROGRESS', payload });

describe('前提: DB の進捗の割合は初期の進捗より上で、工程が進むほど上がる', () => {
  it('通常の生成', () => {
    const p1 = ui(dbStep1).percentage;
    const p2 = ui(dbStep2).percentage;
    const p3 = ui(dbStep3).percentage;
    expect(p1).toBeGreaterThan(V4_INITIAL_PERCENTAGE);
    expect(p1).toBeGreaterThan(IMPROVE_INITIAL_PERCENTAGE);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it('究極モードの生成', () => {
    expect(ui(dbUltimateStep2, true).percentage).toBeGreaterThan(V4_INITIAL_PERCENTAGE);
  });
});

// ---------------------------------------------------------------------------
// 1. reducer
// ---------------------------------------------------------------------------

describe('aiGenerationReducer GEN_PROGRESS_WHILE_GENERATING: 生成中のときだけ GEN_PROGRESS と同じに置く (#1663)', () => {
  it('生成中で初期の進捗 (3%) があっても、DB の進捗 (文・段・割合) を置く', () => {
    const before = generatingWith(v4Initial(false));
    const after = aiGenerationReducer(before, pollAction(ui(dbStep1)));
    expect(after.generationProgress).toEqual(ui(dbStep1));
    expect(after.generationProgress?.percentage).toBeGreaterThan(V4_INITIAL_PERCENTAGE);
  });

  it('生成中なら GEN_PROGRESS を送ったときと同じ結果 (今の進捗が null でも・あっても)', () => {
    for (const current of [null, v4Initial(false), ui(dbStep2), ui(dbStep3)]) {
      const before = generatingWith(current);
      expect(aiGenerationReducer(before, pollAction(ui(dbStep2)))).toEqual(
        aiGenerationReducer(before, realtimeAction(ui(dbStep2))),
      );
    }
  });

  it('今の割合より低い応答でも、割合は Math.max で戻らない', () => {
    const before = generatingWith(ui(dbStep3));
    const after = aiGenerationReducer(before, pollAction(ui(dbStep1)));
    expect(after.generationProgress?.percentage).toBe(ui(dbStep3).percentage);
  });

  it('生成中でなければ何も変えない (同じ state をそのまま返す)', () => {
    const idle = initialAiGenerationState;
    expect(aiGenerationReducer(idle, pollAction(ui(dbStep2)))).toBe(idle);
    const failed: AiGenerationState = {
      ...initialAiGenerationState,
      generationFailedError: 'err',
      generationFailedRequestId: 'req-1',
    };
    expect(aiGenerationReducer(failed, pollAction(ui(dbStep2)))).toBe(failed);
  });

  it('isGenerating・generatingMeal・失敗の文には触れない', () => {
    const before: AiGenerationState = {
      ...generatingWith(v4Initial(true)),
      generatingMeal: { dayIndex: 2, mealType: 'lunch' },
      generationFailedError: 'err',
      generationFailedRequestId: 'req-1',
    };
    const after = aiGenerationReducer(before, pollAction(ui(dbUltimateStep2, true)));
    expect(after.isGenerating).toBe(true);
    expect(after.generatingMeal).toEqual({ dayIndex: 2, mealType: 'lunch' });
    expect(after.generationFailedError).toBe('err');
    expect(after.generationFailedRequestId).toBe('req-1');
  });
});

// ---------------------------------------------------------------------------
// 2. 画面の流れを reducer に順に送る
// ---------------------------------------------------------------------------

describe('画面の流れ: Realtime が来なくても、ポーリングの進捗で 3% / 5% から進む (#1663)', () => {
  it('V4 の生成 (通常): 開始 → 初期の進捗 3% → ポーリングの応答ごとに進む', () => {
    let s = run(initialAiGenerationState, [{ type: 'GEN_START' }, realtimeAction(v4Initial(false))]);
    expect(s.generationProgress?.percentage).toBe(V4_INITIAL_PERCENTAGE);
    const seen: number[] = [];
    for (const db of [dbStep1, dbStep2, dbStep3]) {
      s = aiGenerationReducer(s, pollAction(ui(db)));
      seen.push(s.generationProgress?.percentage ?? -1);
      expect(s.generationProgress?.message).toBe(ui(db).message);
      expect(s.generationProgress?.completedSlots).toBe(ui(db).completedSlots);
    }
    expect(seen).toEqual([ui(dbStep1).percentage, ui(dbStep2).percentage, ui(dbStep3).percentage]);
  });

  it('V4 の生成 (究極モード): 初期の進捗 3% → ポーリングの応答で進み、究極の段のまま', () => {
    const s = run(initialAiGenerationState, [
      { type: 'GEN_START' },
      realtimeAction(v4Initial(true)),
      pollAction(ui(dbUltimateStep2, true)),
    ]);
    expect(s.generationProgress?.percentage).toBe(ui(dbUltimateStep2, true).percentage);
    expect(s.generationProgress?.isUltimateMode).toBe(true);
  });

  it('献立の改善: 開始 → 初期の進捗 5% → ポーリングの応答で進む', () => {
    const s = run(initialAiGenerationState, [
      { type: 'GEN_START' },
      realtimeAction(improveInitial),
      pollAction(ui(dbStep1)),
    ]);
    expect(s.generationProgress?.percentage).toBe(ui(dbStep1).percentage);
    expect(s.generationProgress?.percentage).toBeGreaterThan(IMPROVE_INITIAL_PERCENTAGE);
  });
});

describe('画面の流れ: Realtime とポーリングが混ざっても、割合は戻らない (#1663)', () => {
  it('Realtime が先に進めたあとに着いた古いポーリングの応答では割合が戻らず、新しい応答では進む', () => {
    const steps: Array<[string, AiGenerationAction]> = [
      ['Realtime 2 工程目', realtimeAction(ui(dbStep2))],
      ['古いポーリング 1 工程目', pollAction(ui(dbStep1))],
      ['ポーリング 3 工程目', pollAction(ui(dbStep3))],
      ['遅れた Realtime 2 工程目', realtimeAction(ui(dbStep2))],
    ];
    let s = run(initialAiGenerationState, [{ type: 'GEN_START' }, realtimeAction(v4Initial(false))]);
    const percentages: number[] = [];
    for (const [, action] of steps) {
      s = aiGenerationReducer(s, action);
      percentages.push(s.generationProgress?.percentage ?? -1);
    }
    expect(percentages).toEqual([
      ui(dbStep2).percentage,
      ui(dbStep2).percentage,
      ui(dbStep3).percentage,
      ui(dbStep3).percentage,
    ]);
    // 割合は一度も下がらない
    for (let i = 1; i < percentages.length; i++) expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1]);
  });
});

describe('画面の流れ: 完了・失敗・中止のあとに着いたポーリングの応答では進捗が変わらない (#1663)', () => {
  const inProgress = () =>
    run(initialAiGenerationState, [{ type: 'GEN_START' }, realtimeAction(v4Initial(false)), pollAction(ui(dbStep1))]);

  it('完了 (setIsGenerating(false) = GEN_SUCCESS → 進捗を消す) のあと', () => {
    const done = run(inProgress(), [{ type: 'GEN_SUCCESS' }, { type: 'GEN_PROGRESS_CLEAR' }]);
    const after = aiGenerationReducer(done, pollAction(ui(dbStep2)));
    expect(after).toBe(done);
    expect(after.generationProgress).toBeNull();
    expect(after.isGenerating).toBe(false);
  });

  it('失敗 (GEN_FAIL) のあと: 進捗は出ず、失敗の文は残る', () => {
    const failed = aiGenerationReducer(inProgress(), {
      type: 'GEN_FAIL',
      payload: { error: '献立の生成に失敗しました。', requestId: 'req-1' },
    });
    const after = aiGenerationReducer(failed, pollAction(ui(dbStep3)));
    expect(after).toBe(failed);
    expect(after.generationProgress).toBeNull();
    expect(after.generationFailedError).toBe('献立の生成に失敗しました。');
  });

  it('中止 (handleCancelGeneration: setIsGenerating(false) → setGenerationProgress(null)) のあと', () => {
    const cancelled = run(inProgress(), [{ type: 'GEN_SUCCESS' }, { type: 'GEN_PROGRESS_CLEAR' }]);
    const after = aiGenerationReducer(cancelled, pollAction(ui(dbStep3)));
    expect(after.generationProgress).toBeNull();
  });

  it('(以前の形と比べて) GEN_PROGRESS で置くと、完了のあとに着いた応答で進捗が出直していた — isGenerating で止める理由', () => {
    const done = run(inProgress(), [{ type: 'GEN_SUCCESS' }]);
    expect(aiGenerationReducer(done, realtimeAction(ui(dbStep2))).generationProgress).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 画面と同じ組み方 (前の描画で握った setter と監視の印を持つ tick)
// ---------------------------------------------------------------------------

describe('画面と同じ組み方: 握った setter と監視の印を持つポーリングの tick (#1663)', () => {
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
    setIsGenerating: (v: boolean) => void;
    setProgress: (v: GenerationProgress | null) => void;
    setProgressWhileGenerating: (v: GenerationProgress) => void;
  }

  /** 週間献立の画面と同じく useReducer(aiGenerationReducer) を持ち、page.tsx と同じ形の setter を作る */
  function mount(): { latest: () => Captured; first: Captured } {
    const renders: Captured[] = [];
    function Harness() {
      const [state, dispatch] = useReducer(aiGenerationReducer, initialAiGenerationState);
      const setIsGenerating = useCallback((v: boolean) => {
        dispatch(v ? { type: 'GEN_START' } : { type: 'GEN_SUCCESS' });
      }, []);
      const setProgress = useCallback((v: GenerationProgress | null) => {
        if (v === null) dispatch({ type: 'GEN_PROGRESS_CLEAR' });
        else dispatch({ type: 'GEN_PROGRESS', payload: v });
      }, []);
      const setProgressWhileGenerating = useCallback((v: GenerationProgress) => {
        dispatch({ type: 'GEN_PROGRESS_WHILE_GENERATING', payload: v });
      }, []);
      renders.push({ state, setIsGenerating, setProgress, setProgressWhileGenerating });
      return null;
    }
    act(() => {
      root.render(React.createElement(Harness));
    });
    return { latest: () => renders[renders.length - 1], first: renders[0] };
  }

  /**
   * page.tsx の V4 の生成・献立の改善のポーリングの tick の、状態の確認が返ってきたあとの進捗の分岐と同じ形
   * (印が下りていれば何も置かない → setGenerationProgressWhileGenerating で置く。配線は下の page.tsx の検査で確かめる)
   */
  function makePollTick(watch: { active: boolean }, setWhileGenerating: (v: GenerationProgress) => void, ultimateMode: boolean) {
    return (dbProgress: V4GenerationProgress) => {
      if (!watch.active) return;
      setWhileGenerating(convertV4ProgressToUIFormat(dbProgress, ultimateMode));
    };
  }

  /** 生成を始めた描画の setter を握った tick を作る (page.tsx の setInterval の closure と同じ) */
  function startGeneration(c: Captured, ultimateMode = false) {
    const watch = { active: true };
    act(() => {
      c.setIsGenerating(true);
      c.setProgress(v4Initial(ultimateMode));
    });
    return { watch, tick: makePollTick(watch, c.setProgressWhileGenerating, ultimateMode) };
  }

  it('Realtime が来ない間、マウント時の setter を握った tick の応答で 3% から進む', () => {
    const { latest, first } = mount();
    const { tick } = startGeneration(first);
    expect(latest().state.generationProgress?.percentage).toBe(V4_INITIAL_PERCENTAGE);
    act(() => tick(dbStep1));
    expect(latest().state.generationProgress?.percentage).toBe(ui(dbStep1).percentage);
    act(() => tick(dbStep2));
    expect(latest().state.generationProgress?.percentage).toBe(ui(dbStep2).percentage);
    expect(latest().state.generationProgress?.message).toBe(ui(dbStep2).message);
  });

  it('Realtime (今の setter) が先に進めたあと、古い tick の遅れた応答では割合が戻らない', () => {
    const { latest, first } = mount();
    const { tick } = startGeneration(first);
    act(() => latest().setProgress(ui(dbStep3)));
    act(() => tick(dbStep1));
    expect(latest().state.generationProgress?.percentage).toBe(ui(dbStep3).percentage);
  });

  it('Realtime が完了を処理した (生成中でなくなった) あと、印がまだ下りていない tick の応答でも進捗は出ない', () => {
    const { latest, first } = mount();
    const { watch, tick } = startGeneration(first);
    act(() => tick(dbStep1));
    act(() => {
      latest().setIsGenerating(false);
      latest().setProgress(null);
    });
    expect(watch.active).toBe(true);
    act(() => tick(dbStep3));
    expect(latest().state.generationProgress).toBeNull();
    expect(latest().state.isGenerating).toBe(false);
  });

  it('中止 (印を下ろす → 生成中でなくする) のあとに着いた応答では、進捗は出ない', () => {
    const { latest, first } = mount();
    const { watch, tick } = startGeneration(first);
    act(() => {
      watch.active = false;
      latest().setIsGenerating(false);
      latest().setProgress(null);
    });
    act(() => tick(dbStep2));
    expect(latest().state.generationProgress).toBeNull();
  });

  it('次の生成を始めたあと、前の生成の tick の応答は新しい生成の進捗に出ない (印で止める)', () => {
    const { latest, first } = mount();
    const prev = startGeneration(first);
    act(() => prev.tick(dbStep1));
    // 次の生成の開始: 前の印を下ろし、新しい生成の初期の進捗を置く (isGenerating はまた true)
    prev.watch.active = false;
    const next = startGeneration(latest());
    act(() => prev.tick(dbStep3));
    expect(latest().state.isGenerating).toBe(true);
    expect(latest().state.generationProgress).toEqual(v4Initial(false));
    // 新しい生成の tick は進める
    act(() => next.tick(dbStep1));
    expect(latest().state.generationProgress?.percentage).toBe(ui(dbStep1).percentage);
  });
});

// ---------------------------------------------------------------------------
// 4. page.tsx の配線
// ---------------------------------------------------------------------------

/** `const name = useCallback(` から、対応する `)` までのコード */
function callbackSourceOf(code: string, name: string): string {
  const marker = `const ${name} = useCallback(`;
  const start = code.indexOf(marker);
  if (start < 0) throw new Error(`見つからない: ${marker}`);
  let depth = 0;
  for (let i = start + marker.length - 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`終わりが見つからない: ${marker}`);
}

/** from から、そのあとで最初に出る end までの区間 (end を含む) */
function sliceUntil(code: string, from: number, end: string): string {
  const to = code.indexOf(end, from);
  if (to < 0) throw new Error(`見つからない: ${end}`);
  return code.slice(from, to + end.length);
}

describe('page.tsx の配線: ポーリングの進捗 (#1663)', () => {
  const V4_CALL = 'setGenerationProgressWhileGenerating(convertV4ProgressToUIFormat(dbProgress, requestedUltimateMode));';
  const IMPROVE_CALL = 'setGenerationProgressWhileGenerating(convertV4ProgressToUIFormat(dbProgress, false));';

  it('setGenerationProgressWhileGenerating は GEN_PROGRESS_WHILE_GENERATING を送り、今の値を握らない (deps が空)', () => {
    const body = callbackSourceOf(pageCode, 'setGenerationProgressWhileGenerating');
    expect(body).toContain("dispatchAiGen({ type: 'GEN_PROGRESS_WHILE_GENERATING', payload: v });");
    expect(body).toMatch(/\}, \[\]\)$/);
    expect(body).not.toContain('aiGen.');
  });

  it('ポーリングで DB の進捗を置くのは 2 か所 (V4 の生成・献立の改善) で、どちらも setGenerationProgressWhileGenerating', () => {
    const calls = pageCode.match(/setGenerationProgressWhileGenerating\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(pageCode).toContain(V4_CALL);
    expect(pageCode).toContain(IMPROVE_CALL);
    // DB の進捗 (dbProgress) を GEN_PROGRESS (setGenerationProgress) で生成中かを見ずに置く経路は残っていない
    expect(pageCode).not.toMatch(/setGenerationProgress\(convertV4ProgressToUIFormat\(dbProgress, (requestedUltimateMode|false)\)\)/);
  });

  it('V4 の生成の tick: 応答を読んだあと、完了の印と監視の印 (#1657) を確かめてから置く', () => {
    const readAt = pageCode.indexOf('const { status, progress: dbProgress } = await statusRes.json();');
    expect(readAt).toBeGreaterThan(-1);
    const between = sliceUntil(pageCode, readAt, V4_CALL);
    expect(between).toContain('if (v4ResolvedRef.current) return;');
    expect(between).toContain('if (!v4Watch.active) return;');
    expect(between).toContain('} else if (dbProgress) {');
  });

  it('献立の改善の tick: 応答を読んだあと、完了の印と監視の印 (#1657) を確かめてから置く', () => {
    const readAt = pageCode.indexOf(
      'const { status, errorMessage, error_message: errorMessageSnake, progress: dbProgress } = await statusRes.json();',
    );
    expect(readAt).toBeGreaterThan(-1);
    const between = sliceUntil(pageCode, readAt, IMPROVE_CALL);
    expect(between).toContain('if (improveResolvedRef.current) return;');
    expect(between).toContain('if (!improveWatch.active) return;');
    expect(between).toContain('} else if (dbProgress) {');
  });

  it('初期の進捗 (V4 の生成 3%・献立の改善 5%) は GEN_PROGRESS で置き、Realtime の進捗も GEN_PROGRESS (同じ単調の置き方)', () => {
    expect(pageCode).toMatch(
      new RegExp(`setGenerationProgress\\(\\{\\s*phase: 'user_context',\\s*message: 'ユーザー情報を取得中\\.\\.\\.',\\s*percentage: ${V4_INITIAL_PERCENTAGE},`),
    );
    expect(pageCode).toMatch(
      new RegExp(`setGenerationProgress\\(\\{\\s*phase: 'analyzing',\\s*message: 'AI栄養士の提案を反映中\\.\\.\\.',\\s*percentage: ${IMPROVE_INITIAL_PERCENTAGE},`),
    );
    expect(pageCode).toContain('setGenerationProgress(convertV4ProgressToUIFormat(progress, requestedUltimateMode));');
    expect(pageCode).toContain('const uiProgress = convertV4ProgressToUIFormat(progress, false);');
  });
});

// ---------------------------------------------------------------------------
// 値だけ受ける setter (#1663 の 2)
// ---------------------------------------------------------------------------

describe('page.tsx の配線: 状態の setter は関数形を受けず、握った描画の値で解決しない (#1663)', () => {
  const VALUE_ONLY_SETTERS = [
    'setCurrentPlan',
    'setDisplayMonth',
    'setHolidays',
    'setCalendarMealDates',
    'setIsDayNutritionExpanded',
    'setGenerationProgress',
  ];

  it.each(VALUE_ONLY_SETTERS)('%s は値だけ受け、deps が空 (今の値を握らない)', (name) => {
    const body = callbackSourceOf(pageCode, name);
    expect(body).not.toMatch(/typeof \w+ === 'function'/);
    // 引数の型に関数形 ((prev: …) => …) を持たない
    expect(body).not.toMatch(/\bprev\b/);
    expect(body).not.toMatch(/\b(weekView|aiGen|modal|nutrition|recipe|uiFlag)\./);
    expect(body).toMatch(/\}, \[\]\)$/);
  });

  it('page.tsx の useCallback の setter のどれも、関数形を握った描画の値で解決しない', () => {
    const names = [...pageCode.matchAll(/const (set\w+) = useCallback\(/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(VALUE_ONLY_SETTERS.length);
    for (const name of names) {
      const body = callbackSourceOf(pageCode, name);
      expect(body, name).not.toMatch(/typeof \w+ === 'function'/);
    }
  });

  it('値だけ受ける setter を関数形 (prev => …) で呼ぶ箇所が無い', () => {
    for (const name of VALUE_ONLY_SETTERS) {
      expect(pageCode, name).not.toMatch(new RegExp(`\\b${name}\\(\\s*\\(?\\s*[A-Za-z_]+\\s*\\)?\\s*=>`));
    }
  });

  it('前月・次月は shiftDisplayMonth (DISPLAY_MONTH_SHIFT) で、今の表示月から動かす', () => {
    const body = callbackSourceOf(pageCode, 'shiftDisplayMonth');
    expect(body).toContain("dispatchWeekView({ type: 'DISPLAY_MONTH_SHIFT', payload: months });");
    expect(body).toMatch(/\}, \[\]\)$/);
    expect(pageCode).toContain('shiftDisplayMonth(PREVIOUS_MONTH);');
    expect(pageCode).toContain('shiftDisplayMonth(NEXT_MONTH);');
    expect(pageCode).toMatch(/const PREVIOUS_MONTH = -1;/);
    expect(pageCode).toMatch(/const NEXT_MONTH = 1;/);
  });

  it('祝日は取ってきた分だけを渡し、reducer (HOLIDAYS_SET) が今の祝日に足す', () => {
    expect(pageCode).toContain('setHolidays(data);');
    expect(pageCode).toContain('setHolidays(prevYearData);');
    expect(pageCode).toContain('setHolidays(nextYearData);');
  });
});

describe('weekViewReducer: 今の状態から解決する action (#1663)', () => {
  const PREV = -1;
  const NEXT = 1;
  const YEAR = 2026;
  const JANUARY = 0;
  const DECEMBER = 11;
  const MID_MONTH_DAY = 15;
  const LAST_DAY_OF_DECEMBER = 31;

  it('DISPLAY_MONTH_SHIFT は今の表示月から動かした月の 1 日にする (年をまたぐ)', () => {
    const jan: WeekViewState = { ...initialWeekViewState, displayMonth: new Date(YEAR, JANUARY, MID_MONTH_DAY) };
    const prev = weekViewReducer(jan, { type: 'DISPLAY_MONTH_SHIFT', payload: PREV });
    expect(prev.displayMonth.getFullYear()).toBe(YEAR - 1);
    expect(prev.displayMonth.getMonth()).toBe(DECEMBER);
    expect(prev.displayMonth.getDate()).toBe(1);

    const dec: WeekViewState = { ...initialWeekViewState, displayMonth: new Date(YEAR, DECEMBER, LAST_DAY_OF_DECEMBER) };
    const next = weekViewReducer(dec, { type: 'DISPLAY_MONTH_SHIFT', payload: NEXT });
    expect(next.displayMonth.getFullYear()).toBe(YEAR + 1);
    expect(next.displayMonth.getMonth()).toBe(JANUARY);
    expect(next.displayMonth.getDate()).toBe(1);
  });

  it('HOLIDAYS_SET は今の祝日に足す (上書きしない)', () => {
    const s1 = weekViewReducer(initialWeekViewState, { type: 'HOLIDAYS_SET', payload: { '2026-01-01': '元日' } });
    const s2 = weekViewReducer(s1, { type: 'HOLIDAYS_SET', payload: { '2025-12-31': 'x' } });
    expect(s2.holidays).toEqual({ ...initialWeekViewState.holidays, '2026-01-01': '元日', '2025-12-31': 'x' });
  });

  describe('画面と同じ組み方: マウント時に握った setter から続けて呼んでも、今の状態から解決する', () => {
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
      state: WeekViewState;
      shiftDisplayMonth: (months: number) => void;
      setHolidays: (v: Record<string, string>) => void;
      setIsDayNutritionExpanded: (v: boolean) => void;
    }

    function mount(initial: WeekViewState): { latest: () => Captured; first: Captured } {
      const renders: Captured[] = [];
      function Harness() {
        const [state, dispatch] = useReducer(weekViewReducer, initial);
        const shiftDisplayMonth = useCallback((months: number) => dispatch({ type: 'DISPLAY_MONTH_SHIFT', payload: months }), []);
        const setHolidays = useCallback((v: Record<string, string>) => dispatch({ type: 'HOLIDAYS_SET', payload: v }), []);
        const setIsDayNutritionExpanded = useCallback((v: boolean) => dispatch({ type: 'DAY_NUTRITION_SET', payload: v }), []);
        renders.push({ state, shiftDisplayMonth, setHolidays, setIsDayNutritionExpanded });
        return null;
      }
      act(() => {
        root.render(React.createElement(Harness));
      });
      return { latest: () => renders[renders.length - 1], first: renders[0] };
    }

    it('前月を 2 回 (同じ握った setter で) 押すと 2 か月戻る', () => {
      const { latest, first } = mount({ ...initialWeekViewState, displayMonth: new Date(YEAR, JANUARY, 1) });
      act(() => first.shiftDisplayMonth(PREV));
      act(() => first.shiftDisplayMonth(PREV));
      expect(latest().state.displayMonth.getFullYear()).toBe(YEAR - 1);
      expect(latest().state.displayMonth.getMonth()).toBe(DECEMBER - 1);
    });

    it('祝日を年ごとに (同じ握った setter で) 足しても、先に足した年が消えない', () => {
      const { latest, first } = mount({ ...initialWeekViewState, holidays: {} });
      act(() => first.setHolidays({ '2026-01-01': '元日' }));
      act(() => first.setHolidays({ '2025-01-01': '元日' }));
      expect(latest().state.holidays).toEqual({ '2026-01-01': '元日', '2025-01-01': '元日' });
    });

    it('栄養パネルの開閉は渡した値をそのまま置く', () => {
      const { latest, first } = mount({ ...initialWeekViewState, isDayNutritionExpanded: true });
      act(() => first.setIsDayNutritionExpanded(false));
      expect(latest().state.isDayNutritionExpanded).toBe(false);
      act(() => first.setIsDayNutritionExpanded(false));
      expect(latest().state.isDayNutritionExpanded).toBe(false);
    });
  });
});
