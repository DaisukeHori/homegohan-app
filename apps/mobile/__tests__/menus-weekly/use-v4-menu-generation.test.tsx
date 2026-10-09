/**
 * useV4MenuGeneration のテスト (#1138)
 *
 * 「献立を改善」は専用 API を作らず、既存の POST /api/ai/menu/v4/generate をこのフックから呼ぶ。
 * 1. 改善が実際にサーバーへ送るリクエスト本文 (Web の handleImprove と同じ形)
 * 2. 失敗時の振る舞い
 *    - 既定: onError (画面全体のエラー表示) に通知する
 *    - silent: onError に通知せず、例外だけを返す (改善モーダルが自分でエラーを表示するため)
 *    - どちらも失敗後に isGenerating が true のまま残らない
 * 3. 「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたら、onError を呼ばず onAiConsentRequired を呼ぶ
 *    (渡されていなければ、フックが同意画面への案内を出す)
 * を固定する。
 */

import { act, renderHook } from '@testing-library/react-native';

const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost, get: jest.fn() }),
}));

// フックは supabase を import するが、このテストでは Realtime を使わない
jest.mock('../../src/lib/supabase', () => ({
  supabase: { channel: jest.fn(), from: jest.fn(), removeChannel: jest.fn() },
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import { Alert } from 'react-native';
import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import { AI_CONSENT_REQUIRED_CODE, AI_CONSENT_REQUIRED_MESSAGE } from '../../../../supabase/functions/_shared/ai-consent';
import { submitImprove } from '../../src/lib/improve-meal';

const params = {
  targetSlots: [{ date: '2026-10-08', mealType: 'dinner' as const }],
  constraints: {},
  note: 'メモ',
  ultimateMode: false,
  resolveExistingMeals: true,
};

beforeEach(() => {
  mockPost.mockReset();
  (Alert.alert as jest.Mock).mockClear();
  resetAiConsentPromptForTests();
});

/** getApi() が「同意が必要です」で投げるエラー (T15 / #1154) */
const CONSENT_ERROR_MESSAGE = `HTTP 403 Forbidden: ${JSON.stringify({ error: AI_CONSENT_REQUIRED_MESSAGE, code: AI_CONSENT_REQUIRED_CODE })}`;

describe('useV4MenuGeneration.generate', () => {
  it('v4 生成 API に targetSlots / resolveExistingMeals / constraints / note / ultimateMode を送り、開始を通知する', async () => {
    mockPost.mockResolvedValue({ requestId: 'req-1', totalSlots: 1 });
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onGenerationStart }));

    await act(async () => {
      await result.current.generate(params);
    });

    expect(mockPost).toHaveBeenCalledWith('/api/ai/menu/v4/generate', {
      targetSlots: [{ date: '2026-10-08', mealType: 'dinner' }],
      resolveExistingMeals: true,
      constraints: {},
      note: 'メモ',
      ultimateMode: false,
    });
    expect(onGenerationStart).toHaveBeenCalledWith('req-1');
  });

  it('失敗したら onError に通知して例外を投げ、生成中のままにしない', async () => {
    mockPost.mockRejectedValue(new Error('HTTP 500 Internal Server Error'));
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));

    await act(async () => {
      await expect(result.current.generate(params)).rejects.toThrow('HTTP 500');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('HTTP 500 Internal Server Error');
    expect(result.current.isGenerating).toBe(false);
  });

  it('silent 指定の失敗は onError に通知せず、例外だけを投げる', async () => {
    mockPost.mockRejectedValue(new Error('HTTP 429 Too Many Requests'));
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));

    await act(async () => {
      await expect(result.current.generate(params, { silent: true })).rejects.toThrow('HTTP 429');
    });

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
  });

  it('silent 指定でも成功時は通常どおり開始を通知する', async () => {
    mockPost.mockResolvedValue({ requestId: 'req-2', totalSlots: 1 });
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onGenerationStart }));

    await act(async () => {
      await result.current.generate(params, { silent: true });
    });

    expect(onGenerationStart).toHaveBeenCalledWith('req-2');
  });
});

describe('useV4MenuGeneration.generate — 「同意が必要です」で止められたとき (T15 / #1154)', () => {
  it('onError (失敗の表示) を呼ばず onAiConsentRequired を呼び、例外を返して、生成中のままにしない', async () => {
    mockPost.mockRejectedValue(new Error(CONSENT_ERROR_MESSAGE));
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError, onAiConsentRequired, onGenerationStart }));

    await act(async () => {
      await expect(result.current.generate(params)).rejects.toThrow('HTTP 403');
    });

    expect(onAiConsentRequired).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onGenerationStart).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.isGenerating).toBe(false);
    // 案内は呼び出し元 (onAiConsentRequired) が出す。フック自身は出さない (二重に出さない)
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('onAiConsentRequired を渡さなければ、フックが同意画面への案内を出す (onError は呼ばない)', async () => {
    mockPost.mockRejectedValue(new Error(CONSENT_ERROR_MESSAGE));
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));

    await act(async () => {
      await expect(result.current.generate(params)).rejects.toThrow('HTTP 403');
    });

    expect(onError).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
    expect(result.current.isGenerating).toBe(false);
  });

  it('silent 指定でも、同意が必要なら onAiConsentRequired を呼ぶ', async () => {
    mockPost.mockRejectedValue(new Error(CONSENT_ERROR_MESSAGE));
    const onAiConsentRequired = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onAiConsentRequired }));

    await act(async () => {
      await expect(result.current.generate(params, { silent: true })).rejects.toThrow('HTTP 403');
    });

    expect(onAiConsentRequired).toHaveBeenCalledTimes(1);
  });
});

describe('献立を改善 → v4 生成 API まで通した結果', () => {
  it('Web の handleImprove と同じ本文 (targetSlots + resolveExistingMeals: true + note + constraints: {}) を送る', async () => {
    mockPost.mockResolvedValue({ requestId: 'req-3', totalSlots: 2 });
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onGenerationStart }));

    await act(async () => {
      await submitImprove({
        request: {
          date: '2026-10-08',
          mealTypes: ['dinner', 'lunch'],
          nextDay: true,
          advice: '野菜が不足しています',
        },
        today: '2026-10-08',
        isBusy: false,
        generate: result.current.generate,
      });
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/ai/menu/v4/generate', {
      targetSlots: [
        { date: '2026-10-09', mealType: 'lunch' },
        { date: '2026-10-09', mealType: 'dinner' },
      ],
      resolveExistingMeals: true,
      constraints: {},
      note: '2026-10-08の栄養分析に基づくAI栄養士の提案を参考に改善してください：\n野菜が不足しています',
      ultimateMode: false,
    });
    // 進捗カード (weekly 画面の pendingRequestId) が始まる
    expect(onGenerationStart).toHaveBeenCalledWith('req-3');
  });

  it('改善の失敗は画面全体のエラー表示 (onError) を出さず、呼び出し元 (モーダル) に例外で返る', async () => {
    mockPost.mockRejectedValue(new Error('HTTP 429 Too Many Requests'));
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));

    await act(async () => {
      await expect(
        submitImprove({
          request: { date: '2026-10-08', mealTypes: ['dinner'], nextDay: false },
          today: '2026-10-08',
          isBusy: false,
          generate: result.current.generate,
        }),
      ).rejects.toThrow('HTTP 429');
    });

    expect(onError).not.toHaveBeenCalled();
  });
});
