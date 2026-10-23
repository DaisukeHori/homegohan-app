/**
 * useV4MenuGeneration のテスト (#1138)
 *
 * このフックは POST /api/ai/menu/v4/generate を呼ぶ (使うのは AI の「1日献立変更」のモーダル AIDayMenuModal)。
 * (「献立を改善」の改善モーダルもこのフックで呼んでいたが、それを持つ週の献立のネイティブの画面は、通常の操作で届かない画面として
 * 消した。#1598)
 * 1. サーバーへ送るリクエスト本文
 * 2. 失敗時の振る舞い
 *    - 既定: onError (画面全体のエラー表示) に通知する
 *    - silent: onError に通知せず、例外だけを返す (呼び出し側が自分でエラーを表示するため)
 *    - どちらも失敗後に isGenerating が true のまま残らない
 * 3. 「同意が必要です」(403 AI_CONSENT_REQUIRED。T15 / #1154) で止められたら、onError を呼ばず onAiConsentRequired を呼ぶ
 *    (渡されていなければ、フックが同意画面への案内を出す)。例外にはせず null を返す
 *    (呼び出し側の catch が「失敗しました」を案内に重ねて出さないように。silent でも同じ)
 * 4. 受け付けたあと (Realtime) に、サーバーが同意の判定で止めた文 (AI_CONSENT_REQUIRED_MESSAGE) で失敗したら、
 *    onError を呼ばず onAiConsentRequired を呼ぶ。同意の状況を読めなかった文 (一時的) は onError にそのまま渡す
 * 5. 受け付けたあとの失敗の文のうち、こちらで書いた文 (定型・同意・上限) 以外は汎用の文にして渡す (#1478)。
 *    文字列でない error_message も汎用の文にし、progress の中身と status はそのまま onProgress に渡す。
 *    Realtime の行は型で受ける (フックのソースで any へキャストしない)
 * を固定する。
 */

import fs from 'fs';
import path from 'path';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: mockPost, get: jest.fn() }),
}));

// Realtime (subscribeToProgress) は、登録された UPDATE の受け取り口を mockRealtime.handler に取っておき、テストから呼ぶ
const mockRealtime: { handler: ((payload: { new: Record<string, unknown> }) => Promise<void> | void) | null } = { handler: null };
jest.mock('../../src/lib/supabase', () => {
  const channel: Record<string, jest.Mock> = {};
  channel.on = jest.fn((_event: string, _filter: unknown, handler: (payload: { new: Record<string, unknown> }) => void) => {
    mockRealtime.handler = handler;
    return channel;
  });
  channel.subscribe = jest.fn(() => channel);
  channel.unsubscribe = jest.fn();
  return { supabase: { channel: jest.fn(() => channel), from: jest.fn(), removeChannel: jest.fn() } };
});

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import { Alert } from 'react-native';
import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';
import { resetAiConsentPromptForTests } from '../../src/lib/ai-consent';
import {
  AI_CONSENT_CHECK_FAILED_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_MESSAGE,
} from '../../../../supabase/functions/_shared/ai-consent';
import { aiDailyLimitMessage } from '../../../../supabase/functions/_shared/ai-daily-limit';
import {
  MENU_REQUEST_EXISTING_PROTECTED_MESSAGE,
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_STALE_DISPLAY_MESSAGE,
} from '../../../../supabase/functions/_shared/stored-failure-messages';

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
  mockRealtime.handler = null;
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
    // 本文の無い生の "HTTP ..." の文字列は画面に出さず、汎用の文にする (#1917)
    expect(onError).toHaveBeenCalledWith('生成に失敗しました');
    expect(result.current.isGenerating).toBe(false);
  });

  it.each([
    {
      name: '500 INTERNAL_ERROR',
      error: `HTTP 500 Internal Server Error: ${JSON.stringify({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' })}`,
      shown: '処理中にエラーが発生しました',
      hidden: ['HTTP', 'INTERNAL_ERROR'],
    },
    {
      name: '400 の枠の検証',
      error: `HTTP 400 Bad Request: ${JSON.stringify({ error: '献立を作る枠を 1 つ以上指定してください' })}`,
      shown: '献立を作る枠を 1 つ以上指定してください',
      hidden: ['HTTP', '{'],
    },
  ])('失敗の本文 ($name) は、本文の日本語の文だけを onError に渡す (#1917)', async ({ error, shown, hidden }) => {
    mockPost.mockRejectedValue(new Error(error));
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));

    await act(async () => {
      await expect(result.current.generate(params)).rejects.toThrow('HTTP');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(shown);
    for (const text of hidden) expect(onError.mock.calls[0][0]).not.toContain(text);
    expect(result.current.error).toBe(shown);
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
  it('onError (失敗の表示) を呼ばず onAiConsentRequired を呼び、例外にせず null を返して、生成中のままにしない', async () => {
    mockPost.mockRejectedValue(new Error(CONSENT_ERROR_MESSAGE));
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError, onAiConsentRequired, onGenerationStart }));

    await act(async () => {
      await expect(result.current.generate(params)).resolves.toBeNull();
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
      await expect(result.current.generate(params)).resolves.toBeNull();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
    expect(result.current.isGenerating).toBe(false);
  });

  it('silent 指定でも、同意が必要なら onAiConsentRequired を呼び、例外にしない (呼び出し側の catch に失敗を返さない)', async () => {
    mockPost.mockRejectedValue(new Error(CONSENT_ERROR_MESSAGE));
    const onAiConsentRequired = jest.fn();
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onAiConsentRequired, onError }));

    await act(async () => {
      await expect(result.current.generate(params, { silent: true })).resolves.toBeNull();
    });

    expect(onAiConsentRequired).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('useV4MenuGeneration.subscribeToProgress — 受け付けたあとの失敗 (T15 / #1154)', () => {
  async function failWith(errorMessage: string, options: Parameters<typeof useV4MenuGeneration>[0]) {
    const { result } = renderHook(() => useV4MenuGeneration(options));
    const onProgress = jest.fn();
    act(() => {
      result.current.subscribeToProgress('req-9', onProgress);
    });
    expect(mockRealtime.handler).not.toBeNull();
    await act(async () => {
      await mockRealtime.handler!({ new: { status: 'failed', error_message: errorMessage, progress: null } });
    });
    return { onProgress };
  }

  it('サーバーが同意の判定で止めた文で失敗したら、onError を呼ばず onAiConsentRequired を 1 回呼ぶ', async () => {
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    await failWith(AI_CONSENT_REQUIRED_MESSAGE, { onError, onAiConsentRequired });

    expect(onAiConsentRequired).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('onAiConsentRequired を渡さなければ、フックが同意画面への案内を出す (失敗の表示は出さない)', async () => {
    const onError = jest.fn();
    await failWith(AI_CONSENT_REQUIRED_MESSAGE, { onError });

    expect(onError).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith('同意が必要です', AI_CONSENT_REQUIRED_MESSAGE, expect.any(Array));
  });

  it('同意の状況を読めなかった文 (一時的) は、人向けの文のまま onError に渡す (同意画面へは案内しない)', async () => {
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    await failWith(AI_CONSENT_CHECK_FAILED_MESSAGE, { onError, onAiConsentRequired });

    expect(onError).toHaveBeenCalledWith(AI_CONSENT_CHECK_FAILED_MESSAGE);
    expect(onAiConsentRequired).not.toHaveBeenCalled();
  });

  it('それ以外の失敗は、従来どおり onError に保存された文を渡す', async () => {
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    await failWith(MENU_REQUEST_EXISTING_PROTECTED_MESSAGE, { onError, onAiConsentRequired });

    expect(onError).toHaveBeenCalledWith(MENU_REQUEST_EXISTING_PROTECTED_MESSAGE);
    expect(onAiConsentRequired).not.toHaveBeenCalled();
  });

  // #1576: 進まなくなった行の印 'stale_request_timeout' は英語のまま利用者に出さない
  it('進まなくなった行の印は、日本語の文にして onError と onProgress に渡す', async () => {
    const onError = jest.fn();
    const onAiConsentRequired = jest.fn();
    const { onProgress } = await failWith('stale_request_timeout', { onError, onAiConsentRequired });

    expect(onError).toHaveBeenCalledWith(MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: MENU_REQUEST_STALE_DISPLAY_MESSAGE }));
    expect(JSON.stringify([onError.mock.calls, onProgress.mock.calls])).not.toContain('stale_request_timeout');
    expect(onAiConsentRequired).not.toHaveBeenCalled();
  });

  // #1478: Edge Function が以前、例外の文面をそのまま error_message に書いていた。こちらで書いた文以外は汎用の文に寄せる
  it('こちらで書いた文でない失敗の文 (例外の文面・DB の生のエラー文) は、汎用の文にして onError と onProgress に渡す', async () => {
    const raw = 'duplicate key value violates unique constraint "planned_meals_pkey"';
    const onError = jest.fn();
    const { onProgress } = await failWith(raw, { onError });

    expect(onError).toHaveBeenCalledWith(MENU_REQUEST_FAILED_MESSAGE);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: MENU_REQUEST_FAILED_MESSAGE }));
    expect(JSON.stringify([onError.mock.calls, onProgress.mock.calls])).not.toContain('duplicate key');
  });

  it('1 日の上限で止めた文と、既存の献立を守った定型の文は、そのまま onError に渡す (#1478)', async () => {
    for (const stored of [aiDailyLimitMessage(10), MENU_REQUEST_EXISTING_PROTECTED_MESSAGE]) {
      const onError = jest.fn();
      await failWith(stored, { onError });
      expect(onError).toHaveBeenCalledWith(stored);
    }
  });

  // #1478 R1: Realtime の行を any へのキャストでなく型 (error_message は unknown) で受ける。文字列でない値も汎用の文に寄せる
  it('error_message が文字列でない値 (オブジェクト) なら汎用の文にし、progress の中身と status はそのまま onProgress に渡す', async () => {
    const onError = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError }));
    const onProgress = jest.fn();
    act(() => {
      result.current.subscribeToProgress('req-10', onProgress);
    });
    await act(async () => {
      await mockRealtime.handler!({
        new: {
          status: 'failed',
          error_message: { message: 'relation "planned_meals" does not exist' },
          progress: { currentStep: 3, totalSteps: 6 },
        },
      });
    });

    expect(onProgress).toHaveBeenCalledWith({
      currentStep: 3,
      totalSteps: 6,
      status: 'failed',
      errorMessage: MENU_REQUEST_FAILED_MESSAGE,
    });
    expect(onError).toHaveBeenCalledWith(MENU_REQUEST_FAILED_MESSAGE);
    expect(JSON.stringify([onError.mock.calls, onProgress.mock.calls])).not.toContain('does not exist');
  });

  it('フックのソースは Realtime の行を any へキャストして受けない (読む列は型で確かめる #1478)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/hooks/useV4MenuGeneration.ts'), 'utf8');
    // コメントを除いた実コードで判定する (説明の文に語が出ても誤検知しない)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bas\s+any\b/);
    expect(code).toMatch(/payload\.new as WeeklyMenuRequestRealtimeRow\b/);
  });
});

describe('生成中の状態を端末に保存しない (#1049 F7-20)', () => {
  // 以前は受け付けのたびに AsyncStorage の "v4MenuGenerating" に書いていたが、読む処理がどこにも無かった
  // (形式も persistence.ts の TTL 付きの形と違っていた)。書かないことと、ソースから読み書きが消えたことを確かめる
  const LEGACY_KEY = 'v4MenuGenerating';

  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('受け付け・完了・取り消しのどれでも、端末の保存領域に何も書かない', async () => {
    mockPost.mockResolvedValue({ requestId: 'req-1', totalSlots: 1 });
    const onGenerationComplete = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onGenerationComplete }));

    await act(async () => {
      await result.current.generate(params);
    });
    // 受け付けた直後 (生成中) も何も書かれていない (以前はここで { requestId, timestamp, totalSlots } が書かれていた)
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    act(() => {
      result.current.subscribeToProgress('req-1', jest.fn());
    });
    await act(async () => {
      await mockRealtime.handler!({ new: { status: 'completed', error_message: null, progress: null } });
    });
    await act(async () => {
      await result.current.cancelGeneration();
    });

    expect(onGenerationComplete).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('フックのソースは AsyncStorage も "v4MenuGenerating" のキーも使わない (読み手の無い保存を戻さない)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/hooks/useV4MenuGeneration.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/AsyncStorage/);
    expect(code).not.toContain(LEGACY_KEY);
  });
});
