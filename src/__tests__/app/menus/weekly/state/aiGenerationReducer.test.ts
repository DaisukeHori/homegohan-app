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
