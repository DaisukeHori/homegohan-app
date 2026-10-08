/**
 * use-v4-menu-generation-storage.test.tsx
 * V4 献立生成フック (src/hooks/useV4MenuGeneration.ts) が、生成中の状態を端末に保存しないことのテスト (#1049 F7-20)
 *
 * 以前は、生成を依頼するたびに AsyncStorage の "v4MenuGenerating" へ生の JSON を書いていた。
 *   - 読む処理がアプリのどこにも無かった (週間献立画面はサーバーの pending API で復元する)
 *   - persistence.ts が決めている TTL 付きの形式 ({ data, expiresAt }) と食い違っていた
 *   - サインアウトしても消されず、完了・失敗の通知を受け取れなかった場合は残り続けた
 * 読み手のいない状態を端末に保存するのをやめた。依頼・進捗の購読・中止の動きは変えていないことも確かめる。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';

import type { MenuGenerationConstraints, TargetSlot } from '../../../../types/domain';

// ── API クライアントのモック ───────────────────────────────────────────────────
const mockPost = jest.fn();
jest.mock('../../src/lib/api', () => ({
  getApi: () => ({ post: (...args: unknown[]) => mockPost(...args) }),
}));

// ── Supabase Realtime のモック ─────────────────────────────────────────────────
type ProgressPayload = { new: Record<string, unknown> };

const mockUnsubscribe = jest.fn();
const mockChannelFactory = jest.fn();
let mockProgressHandler: ((payload: ProgressPayload) => void) | null = null;

jest.mock('../../src/lib/supabase', () => ({
  supabase: {
    channel: (...args: unknown[]) => mockChannelFactory(...args),
  },
}));

import { useV4MenuGeneration } from '../../src/hooks/useV4MenuGeneration';

const TARGET_SLOTS: TargetSlot[] = [{ date: '2026-10-08', mealType: 'dinner' }];
const CONSTRAINTS: MenuGenerationConstraints = { quickMeals: true };

function generateParams() {
  return { targetSlots: TARGET_SLOTS, constraints: CONSTRAINTS, note: '魚が食べたい' };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockProgressHandler = null;

  const channel: { on: jest.Mock; subscribe: jest.Mock } = {
    on: jest.fn(),
    subscribe: jest.fn(),
  };
  channel.on.mockImplementation((_type: string, _filter: unknown, handler: (payload: ProgressPayload) => void) => {
    mockProgressHandler = handler;
    return channel;
  });
  // フックは .subscribe() の戻り値のチャンネルに対して unsubscribe を呼ぶ
  channel.subscribe.mockReturnValue({ unsubscribe: mockUnsubscribe });
  mockChannelFactory.mockReturnValue(channel);

  mockPost.mockResolvedValue({ requestId: 'req-1', totalSlots: 1 });
});

describe('useV4MenuGeneration — 生成の依頼', () => {
  it('依頼内容を V4 生成 API に送り、返ってきた requestId を通知する', async () => {
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onGenerationStart }));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.generate(generateParams());
    });

    expect(mockPost).toHaveBeenCalledWith('/api/ai/menu/v4/generate', {
      targetSlots: TARGET_SLOTS,
      resolveExistingMeals: false,
      constraints: CONSTRAINTS,
      note: '魚が食べたい',
      ultimateMode: false,
    });
    expect(returned).toEqual({ requestId: 'req-1', totalSlots: 1 });
    expect(onGenerationStart).toHaveBeenCalledWith('req-1');
    expect(result.current.requestId).toBe('req-1');
    // 依頼が通ったあとは、進捗の追跡で完了が分かるまで「生成中」のまま
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('生成中の状態を端末 (AsyncStorage) に保存しない (読む処理が無く、保存形式も食い違っていたため)', async () => {
    const { result } = renderHook(() => useV4MenuGeneration());

    await act(async () => {
      await result.current.generate(generateParams());
    });

    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    expect(await AsyncStorage.getItem('v4MenuGenerating')).toBeNull();
  });

  it('依頼が失敗したら、エラーを通知して例外を投げ直し、端末には何も残さない', async () => {
    mockPost.mockRejectedValue(new Error('サーバーが混み合っています'));
    const onError = jest.fn();
    const onGenerationStart = jest.fn();
    const { result } = renderHook(() => useV4MenuGeneration({ onError, onGenerationStart }));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.generate(generateParams());
      } catch (e) {
        caught = e;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledWith('サーバーが混み合っています');
    expect(onGenerationStart).not.toHaveBeenCalled();
    expect(result.current.error).toBe('サーバーが混み合っています');
    expect(result.current.requestId).toBeNull();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });
});

describe('useV4MenuGeneration — 進捗の購読', () => {
  function subscribe(options: Parameters<typeof useV4MenuGeneration>[0] = {}) {
    const hook = renderHook(() => useV4MenuGeneration(options));
    const onProgress = jest.fn();
    let unsubscribe: () => void = () => {};
    act(() => {
      unsubscribe = hook.result.current.subscribeToProgress('req-1', onProgress);
    });
    return { ...hook, onProgress, unsubscribe };
  }

  async function emit(newRecord: Record<string, unknown>) {
    await act(async () => {
      mockProgressHandler?.({ new: newRecord });
    });
  }

  it('依頼ごとのチャンネルで、その依頼の行の更新だけを購読する', () => {
    subscribe();

    expect(mockChannelFactory).toHaveBeenCalledWith('v4-menu-progress-req-1');
    const channel = mockChannelFactory.mock.results[0].value as { on: jest.Mock };
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'weekly_menu_requests', filter: 'id=eq.req-1' },
      expect.any(Function),
    );
  });

  it('途中経過は、状態とエラーメッセージを足して渡す。完了前は購読を続ける', async () => {
    const { onProgress, result } = subscribe();
    // 先に依頼が通って「生成中」になっている状態にする
    await act(async () => {
      await result.current.generate(generateParams());
    });

    await emit({ status: 'processing', progress: { percentage: 40 }, error_message: null });

    expect(onProgress).toHaveBeenCalledWith({ percentage: 40, status: 'processing', errorMessage: null });
    expect(result.current.isGenerating).toBe(true);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('完了したら、完了を通知し、「生成中」を戻して購読を解除する', async () => {
    const onGenerationComplete = jest.fn();
    const onError = jest.fn();
    const { result } = subscribe({ onGenerationComplete, onError });
    await act(async () => {
      await result.current.generate(generateParams());
    });
    expect(result.current.isGenerating).toBe(true);

    await emit({ status: 'completed', progress: { percentage: 100 } });

    expect(onGenerationComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    // 完了の通知でも、端末には何も残さない
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('失敗したら、エラーメッセージを通知し、「生成中」を戻して購読を解除する', async () => {
    const onGenerationComplete = jest.fn();
    const onError = jest.fn();
    const { result } = subscribe({ onGenerationComplete, onError });
    await act(async () => {
      await result.current.generate(generateParams());
    });

    await emit({ status: 'failed', error_message: '食材が足りません' });

    expect(onError).toHaveBeenCalledWith('食材が足りません');
    expect(onGenerationComplete).not.toHaveBeenCalled();
    expect(result.current.isGenerating).toBe(false);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('失敗でメッセージが無ければ、既定のメッセージを通知する', async () => {
    const onError = jest.fn();
    subscribe({ onError });

    await emit({ status: 'failed', error_message: null });

    expect(onError).toHaveBeenCalledWith('生成に失敗しました');
  });

  it('戻り値の関数で購読を解除できる', () => {
    const { unsubscribe } = subscribe();

    unsubscribe();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('useV4MenuGeneration — 中止', () => {
  it('中止すると、「生成中」と requestId を戻す', async () => {
    const { result } = renderHook(() => useV4MenuGeneration());
    await act(async () => {
      await result.current.generate(generateParams());
    });
    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      await result.current.cancelGeneration();
    });

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.requestId).toBeNull();
  });
});
