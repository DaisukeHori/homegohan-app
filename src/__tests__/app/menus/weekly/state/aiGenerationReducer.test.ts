// src/__tests__/app/menus/weekly/state/aiGenerationReducer.test.ts
// Issue #1032 (F1b-02 / F1b-03): 互換 setter 層の二重 dispatch バグの回帰防止。
//
// F1b-02: GEN_FAIL は必ず { error, requestId } を単一 dispatch でセットする。
//         (旧: setGenerationFailedError → setGenerationFailedRequestId の2連続 dispatch で
//          後発の requestId 側 dispatch が error を null 上書きし、失敗モーダルが出なくなっていた)
// F1b-03: 進捗クリアは GEN_PROGRESS_CLEAR を使い、isGenerating/generatingMeal には触れない。
//         (旧: setGenerationProgress(null) が GEN_SUCCESS を誤って流用し、生成中UIが強制解除されていた)

import { describe, it, expect } from 'vitest';
import {
  aiGenerationReducer,
  initialAiGenerationState,
  photoAnalyzeStateForSession,
  type AiGenerationState,
} from '@/app/(main)/menus/weekly/_state/reducers/aiGenerationReducer';

describe('aiGenerationReducer', () => {
  it('GEN_FAIL は error と requestId を同時に保持する（#1032 F1b-02）', () => {
    const next = aiGenerationReducer(initialAiGenerationState, {
      type: 'GEN_FAIL',
      payload: { error: '生成に失敗しました', requestId: 'req-123' },
    });
    expect(next.generationFailedError).toBe('生成に失敗しました');
    expect(next.generationFailedRequestId).toBe('req-123');
    expect(next.isGenerating).toBe(false);
    expect(next.generationProgress).toBeNull();
  });

  it('GEN_FAILED_CLEAR で error/requestId が両方クリアされる', () => {
    const failed: AiGenerationState = {
      ...initialAiGenerationState,
      generationFailedError: 'err',
      generationFailedRequestId: 'req-1',
    };
    const next = aiGenerationReducer(failed, { type: 'GEN_FAILED_CLEAR' });
    expect(next.generationFailedError).toBeNull();
    expect(next.generationFailedRequestId).toBeNull();
  });

  it('GEN_PROGRESS_CLEAR は generationProgress のみを null にし、isGenerating/generatingMeal は変更しない（#1032 F1b-03）', () => {
    const generating: AiGenerationState = {
      ...initialAiGenerationState,
      isGenerating: true,
      generatingMeal: { dayIndex: 2, mealType: 'dinner' },
      generationProgress: { phase: 'generating', message: '生成中...', percentage: 40 },
    };
    const next = aiGenerationReducer(generating, { type: 'GEN_PROGRESS_CLEAR' });
    expect(next.generationProgress).toBeNull();
    // 進捗クリアだけでは生成中UIを強制解除しない
    expect(next.isGenerating).toBe(true);
    expect(next.generatingMeal).toEqual({ dayIndex: 2, mealType: 'dinner' });
  });

  it('GEN_SUCCESS は isGenerating/generatingMeal/generationProgress を全てリセットする（GEN_PROGRESS_CLEAR とは別物）', () => {
    const generating: AiGenerationState = {
      ...initialAiGenerationState,
      isGenerating: true,
      generatingMeal: { dayIndex: 0, mealType: 'lunch' },
      generationProgress: { phase: 'generating', message: '生成中...', percentage: 90 },
    };
    const next = aiGenerationReducer(generating, { type: 'GEN_SUCCESS' });
    expect(next.isGenerating).toBe(false);
    expect(next.generatingMeal).toBeNull();
    expect(next.generationProgress).toBeNull();
  });
});

// Issue #2047: 写真の解析は、解析している写真を送ったモーダルの回 (photoEditSession) を持つ。
// 結果を待つあいだ (最大 2 分) に開いた別のモーダルに「AIが解析中...」を出さず、解析のボタンだけ押せなくするため
describe('aiGenerationReducer: 写真の解析の回 (#2047)', () => {
  const ANALYZED_SESSION = 3;
  const OTHER_SESSION = 4;

  it('PHOTO_ANALYZE_START は解析中にし、写真を送ったモーダルの回を持つ。PHOTO_ANALYZE_END は両方を戻す', () => {
    const started = aiGenerationReducer(initialAiGenerationState, {
      type: 'PHOTO_ANALYZE_START',
      payload: { session: ANALYZED_SESSION },
    });
    expect(started.isAnalyzingPhoto).toBe(true);
    expect(started.analyzingPhotoSession).toBe(ANALYZED_SESSION);

    const ended = aiGenerationReducer(started, { type: 'PHOTO_ANALYZE_END' });
    expect(ended.isAnalyzingPhoto).toBe(false);
    expect(ended.analyzingPhotoSession).toBeNull();
  });

  it('photoAnalyzeStateForSession: 解析していなければ idle・写真を送った回なら own・ほかの回なら other', () => {
    expect(photoAnalyzeStateForSession(initialAiGenerationState, ANALYZED_SESSION)).toBe('idle');
    const started = aiGenerationReducer(initialAiGenerationState, {
      type: 'PHOTO_ANALYZE_START',
      payload: { session: ANALYZED_SESSION },
    });
    expect(photoAnalyzeStateForSession(started, ANALYZED_SESSION)).toBe('own');
    expect(photoAnalyzeStateForSession(started, OTHER_SESSION)).toBe('other');
    const ended = aiGenerationReducer(started, { type: 'PHOTO_ANALYZE_END' });
    expect(photoAnalyzeStateForSession(ended, ANALYZED_SESSION)).toBe('idle');
    expect(photoAnalyzeStateForSession(ended, OTHER_SESSION)).toBe('idle');
  });
});
