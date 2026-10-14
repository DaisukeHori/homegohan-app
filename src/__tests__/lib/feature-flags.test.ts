// @vitest-environment node
/**
 * src/__tests__/lib/feature-flags.test.ts
 *
 * #1148 機能フラグの判定ヘルパー isFeatureEnabled のユニットテスト。
 *
 * 確認すること:
 *   - 行があれば enabled / rollout_strategy / constraints で判定する (evaluateFlag の判定をそのまま使う)
 *   - 行が無い・読み出しに失敗した・待ちきれなかったときは、止めない側 (ai_chat_enabled = ON / maintenance_mode = OFF) の
 *     既定値で答え、例外を投げない。失敗は構造化ログに残る
 *   - フラグの行は 30 秒メモリに覚える。同時の読み出しは 1 回にまとめる。失敗したあとは 10 秒は読み直さない
 *   - plan / role / org の段階公開や条件があるときだけ、ユーザーの属性を user_profiles から 1 回読む
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchFlagRecord = vi.fn();
const mockProfileMaybeSingle = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('@/lib/super-admin/evaluate-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/super-admin/evaluate-flag')>();
  return { ...actual, fetchFlagRecord: (...args: unknown[]) => mockFetchFlagRecord(...args) };
});

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'user_profiles') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: (column: string, value: string) => ({
            maybeSingle: () => mockProfileMaybeSingle(column, value),
          }),
        }),
      };
    },
  }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  CLIENT_FEATURE_FLAG_KEYS,
  FEATURE_FLAG_CACHE_TTL_MS,
  FEATURE_FLAG_DEFAULTS,
  FEATURE_FLAG_FAILURE_RETRY_MS,
  FEATURE_FLAG_READ_TIMEOUT_MS,
  clearFeatureFlagCache,
  invalidateFeatureFlag,
  isFeatureEnabled,
} from '@/lib/feature-flags';

function row(key: string, overrides: Record<string, unknown> = {}) {
  return { key, enabled: true, rollout_strategy: null, constraints: null, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
  // 前のテストで差し込んだ実装 (例外を投げるロガーなど) を残さない
  mockFetchFlagRecord.mockReset();
  mockProfileMaybeSingle.mockReset();
  mockLoggerError.mockReset();
  mockLoggerWarn.mockReset();
  clearFeatureFlagCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isFeatureEnabled — 既定値', () => {
  it('止めない側の既定値になっている (ai_chat_enabled = ON / maintenance_mode = OFF / 献立生成 = v5)', () => {
    expect(FEATURE_FLAG_DEFAULTS).toEqual({
      ai_chat_enabled: true,
      maintenance_mode: false,
      menu_generation_v5_wrapped: true,
      menu_generation_v5_direct: true,
    });
  });

  it('クライアントに返すフラグは ai_chat_enabled と maintenance_mode だけ', () => {
    expect([...CLIENT_FEATURE_FLAG_KEYS]).toEqual(['ai_chat_enabled', 'maintenance_mode']);
  });
});

describe('isFeatureEnabled — 行があるとき', () => {
  it('enabled = true なら ON、false なら OFF', async () => {
    mockFetchFlagRecord.mockResolvedValueOnce(row('ai_chat_enabled', { enabled: true }));
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(true);

    clearFeatureFlagCache();
    mockFetchFlagRecord.mockResolvedValueOnce(row('ai_chat_enabled', { enabled: false }));
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(false);
  });

  it('既定値と逆の値も、行の値が優先される (maintenance_mode を ON にできる)', async () => {
    mockFetchFlagRecord.mockResolvedValueOnce(row('maintenance_mode', { enabled: true }));
    expect(await isFeatureEnabled('maintenance_mode')).toBe(true);
  });

  it('percentage の段階公開は、同じユーザーなら何度でも同じ結果 (userId だけで決まる)', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('new_flag', { rollout_strategy: { type: 'percentage', value: 50 } }),
    );
    const results = new Set<boolean>();
    for (let i = 0; i < 5; i++) results.add(await isFeatureEnabled('new_flag', 'stable-user'));
    expect(results.size).toBe(1);

    let enabled = 0;
    for (let i = 0; i < 400; i++) {
      if (await isFeatureEnabled('new_flag', `user-${i}`)) enabled++;
    }
    expect(enabled).toBeGreaterThan(120);
    expect(enabled).toBeLessThan(280);
  });

  it('運営画面で作った、既定値の無い key も判定できる', async () => {
    mockFetchFlagRecord.mockResolvedValueOnce(row('brand_new_flag', { enabled: true }));
    expect(await isFeatureEnabled('brand_new_flag', 'user-1')).toBe(true);
  });
});

describe('isFeatureEnabled — 行が無いとき (既定値)', () => {
  it.each([
    ['ai_chat_enabled', true],
    ['maintenance_mode', false],
    ['menu_generation_v5_wrapped', true],
    ['menu_generation_v5_direct', true],
    ['unknown_flag', false],
    ['constructor', false],
    ['__proto__', false],
  ])('%s は %s', async (key, expected) => {
    mockFetchFlagRecord.mockResolvedValueOnce(null);
    expect(await isFeatureEnabled(key, 'user-1')).toBe(expected);
  });

  it('「行が無い」警告は、キャッシュが切れて読み直しても 1 回しか出さない', async () => {
    mockFetchFlagRecord.mockResolvedValue(null);
    await isFeatureEnabled('ai_chat_enabled', 'user-1');
    await vi.advanceTimersByTimeAsync(FEATURE_FLAG_CACHE_TTL_MS + 1);
    await isFeatureEnabled('ai_chat_enabled', 'user-1');

    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});

describe('isFeatureEnabled — 読み出しに失敗したとき (止めない側に倒す)', () => {
  it('ai_chat_enabled は ON、maintenance_mode は OFF で答え、例外を投げず、失敗をログに残す', async () => {
    mockFetchFlagRecord.mockRejectedValue(new Error('connection refused'));

    await expect(isFeatureEnabled('ai_chat_enabled', 'user-1')).resolves.toBe(true);
    await expect(isFeatureEnabled('maintenance_mode', 'user-1')).resolves.toBe(false);
    await expect(isFeatureEnabled('menu_generation_v5_wrapped', 'user-1')).resolves.toBe(true);
    await expect(isFeatureEnabled('some_unknown_flag', 'user-1')).resolves.toBe(false);

    expect(mockLoggerError).toHaveBeenCalledTimes(4);
    const [message, error, metadata] = mockLoggerError.mock.calls[0];
    expect(message).toContain('読み出しに失敗');
    expect((error as Error).message).toBe('connection refused');
    expect(metadata).toMatchObject({ key: 'ai_chat_enabled', reason: 'read_error', fallback: true });
  });

  it('同期的に例外を投げる読み出し (環境変数が無い等) でも同じ', async () => {
    mockFetchFlagRecord.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });
    await expect(isFeatureEnabled('ai_chat_enabled', 'user-1')).resolves.toBe(true);
    await expect(isFeatureEnabled('maintenance_mode')).resolves.toBe(false);
  });

  it('失敗のあと 10 秒は読み直さず、10 秒たつと読み直して回復する', async () => {
    mockFetchFlagRecord.mockRejectedValueOnce(new Error('boom'));
    expect(await isFeatureEnabled('maintenance_mode')).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);

    // 障害中は毎回読みに行かない
    mockFetchFlagRecord.mockResolvedValue(row('maintenance_mode', { enabled: true }));
    await vi.advanceTimersByTimeAsync(FEATURE_FLAG_FAILURE_RETRY_MS - 1_000);
    expect(await isFeatureEnabled('maintenance_mode')).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await isFeatureEnabled('maintenance_mode')).toBe(true);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
  });

  it('ログが書けなくても、判定の結果は変わらず例外も出ない', async () => {
    mockFetchFlagRecord.mockRejectedValue(new Error('boom'));
    mockLoggerError.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    await expect(isFeatureEnabled('ai_chat_enabled', 'user-1')).resolves.toBe(true);
    await expect(isFeatureEnabled('maintenance_mode', 'user-1')).resolves.toBe(false);
  });
});

describe('isFeatureEnabled — 読み出しが遅いとき', () => {
  it('待ち時間の上限を超えたら既定値で答える。遅れて返った値は次の判定から使われる', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    mockFetchFlagRecord.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const pending = isFeatureEnabled('maintenance_mode', undefined, { timeoutMs: 800 });
    await vi.advanceTimersByTimeAsync(799);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toBe(false); // 既定値 (OFF) で答えた
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ key: 'maintenance_mode', reason: 'timeout', timeoutMs: 800 });

    // 待ちきれなかったあとは、読み出しの結果が返るまで、待たずに既定値で答える (リクエストを遅くしない)
    expect(await isFeatureEnabled('maintenance_mode', undefined, { timeoutMs: 800 })).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);

    // 遅れて返った本物の値がキャッシュに入る
    resolveRead(row('maintenance_mode', { enabled: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await isFeatureEnabled('maintenance_mode', undefined, { timeoutMs: 800 })).toBe(true);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);
  });

  it('既定の待ち時間の上限は 1.5 秒', async () => {
    expect(FEATURE_FLAG_READ_TIMEOUT_MS).toBe(1_500);
    mockFetchFlagRecord.mockReturnValueOnce(new Promise(() => {}));
    const pending = isFeatureEnabled('ai_chat_enabled', 'user-1');
    await vi.advanceTimersByTimeAsync(FEATURE_FLAG_READ_TIMEOUT_MS + 1);
    expect(await pending).toBe(true);
  });

  it('永遠に返ってこない読み出しがあっても、10 秒で打ち切って、あとで読み直せる', async () => {
    mockFetchFlagRecord.mockReturnValueOnce(new Promise(() => {}));
    const first = isFeatureEnabled('ai_chat_enabled', 'user-1');
    await vi.advanceTimersByTimeAsync(FEATURE_FLAG_READ_TIMEOUT_MS + 1);
    expect(await first).toBe(true); // 待ちきれず、既定値 (ON) で答えた

    // 打ち切り (10 秒) と、そのあとの読み直しの待ち (10 秒) が過ぎれば、新しい読み出しができる
    await vi.advanceTimersByTimeAsync(21_000);
    mockFetchFlagRecord.mockResolvedValueOnce(row('ai_chat_enabled', { enabled: false }));
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
  });
});

describe('isFeatureEnabled — メモリのキャッシュ', () => {
  it('30 秒以内は DB を読み直さない。30 秒たつと読み直す', async () => {
    mockFetchFlagRecord.mockResolvedValue(row('ai_chat_enabled', { enabled: true }));

    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(true);
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-2')).toBe(true);
    await vi.advanceTimersByTimeAsync(FEATURE_FLAG_CACHE_TTL_MS - 1);
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-3')).toBe(true);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);

    mockFetchFlagRecord.mockResolvedValue(row('ai_chat_enabled', { enabled: false }));
    await vi.advanceTimersByTimeAsync(2);
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
  });

  it('key ごとに別々に覚える', async () => {
    mockFetchFlagRecord.mockImplementation(async (key: string) => row(key, { enabled: key === 'a_flag' }));
    expect(await isFeatureEnabled('a_flag')).toBe(true);
    expect(await isFeatureEnabled('b_flag')).toBe(false);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
    expect(mockFetchFlagRecord).toHaveBeenCalledWith('a_flag');
    expect(mockFetchFlagRecord).toHaveBeenCalledWith('b_flag');
  });

  it('同時の読み出しは 1 回にまとめる', async () => {
    let resolveRead: (value: unknown) => void = () => {};
    mockFetchFlagRecord.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const calls = Array.from({ length: 10 }, (_, i) => isFeatureEnabled('ai_chat_enabled', `user-${i}`));
    resolveRead(row('ai_chat_enabled', { enabled: true }));
    expect(await Promise.all(calls)).toEqual(new Array(10).fill(true));
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(1);
  });

  it('invalidateFeatureFlag で、その key だけ即座に読み直す', async () => {
    mockFetchFlagRecord.mockResolvedValue(row('maintenance_mode', { enabled: false }));
    expect(await isFeatureEnabled('maintenance_mode')).toBe(false);

    mockFetchFlagRecord.mockResolvedValue(row('maintenance_mode', { enabled: true }));
    expect(await isFeatureEnabled('maintenance_mode')).toBe(false); // まだ覚えている

    invalidateFeatureFlag('maintenance_mode');
    expect(await isFeatureEnabled('maintenance_mode')).toBe(true);
    expect(mockFetchFlagRecord).toHaveBeenCalledTimes(2);
  });
});

describe('isFeatureEnabled — ユーザーの属性が要るフラグ', () => {
  it('属性が要らないフラグでは user_profiles を読まない', async () => {
    mockFetchFlagRecord.mockResolvedValue(row('ai_chat_enabled'));
    await isFeatureEnabled('ai_chat_enabled', 'user-1');
    expect(mockProfileMaybeSingle).not.toHaveBeenCalled();
  });

  it('role の段階公開: userId だけ渡すと、そのユーザーの行を id で絞って 1 回読んで判定する', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('staff_only', { rollout_strategy: { type: 'role', roles: ['admin'] } }),
    );
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: ['user', 'admin'], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('staff_only', 'admin-1')).toBe(true);
    expect(mockProfileMaybeSingle).toHaveBeenCalledWith('id', 'admin-1');

    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: ['user'], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('staff_only', 'user-1')).toBe(false);
  });

  it('plan の段階公開: plan_key_cached が空のユーザーは free として判定する', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('paid_only', { rollout_strategy: { type: 'plan', plans: ['pro'] } }),
    );
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: [], organization_id: null, plan_key_cached: 'pro', created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('paid_only', 'pro-user')).toBe(true);

    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: [], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('paid_only', 'free-user')).toBe(false);

    // free を除外する条件も、plan_key_cached が空なら free として効く
    mockFetchFlagRecord.mockResolvedValue(row('not_for_free', { constraints: { exclude_plans: ['free'] } }));
    clearFeatureFlagCache();
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: [], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('not_for_free', 'free-user')).toBe(false);
  });

  it('呼び出し側が渡した属性は DB から読み直さない (ミドルウェアは roles を持っている)', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('staff_only', { rollout_strategy: { type: 'role', roles: ['admin'] } }),
    );
    expect(await isFeatureEnabled('staff_only', 'admin-1', { context: { roles: ['admin'] } })).toBe(true);
    expect(await isFeatureEnabled('staff_only', 'user-1', { context: { roles: ['user'] } })).toBe(false);
    expect(mockProfileMaybeSingle).not.toHaveBeenCalled();
  });

  it('渡した属性が足りない項目だけを読んで補う。渡した項目は読んだ値で上書きされない', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('both', { constraints: { include_roles: ['admin'], include_plans: ['pro'] } }),
    );
    mockProfileMaybeSingle.mockResolvedValue({
      data: { roles: ['user'], organization_id: null, plan_key_cached: 'pro', created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    // roles は渡した値 (admin) が使われ、planKey は読んだ値 (pro) で補われる
    expect(await isFeatureEnabled('both', 'user-1', { context: { roles: ['admin'] } })).toBe(true);
    expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('属性が要るのに未ログイン (userId なし) なら、判定できないので既定値で答える', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('maintenance_mode', { rollout_strategy: { type: 'role', roles: ['user'] } }),
    );
    expect(await isFeatureEnabled('maintenance_mode')).toBe(false); // maintenance_mode の既定値 OFF
    mockFetchFlagRecord.mockResolvedValue(row('ai_chat_enabled', { rollout_strategy: { type: 'plan', plans: ['pro'] } }));
    expect(await isFeatureEnabled('ai_chat_enabled')).toBe(true); // ai_chat_enabled の既定値 ON
    expect(mockProfileMaybeSingle).not.toHaveBeenCalled();
  });

  it('属性の読み出しに失敗したら、既定値で答えてログに残す (例外は投げない)', async () => {
    mockFetchFlagRecord.mockResolvedValue(
      row('ai_chat_enabled', { rollout_strategy: { type: 'plan', plans: ['pro'] } }),
    );
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });

    // plan が読めなかったので判定できない。AI 相談は止めずに ON
    expect(await isFeatureEnabled('ai_chat_enabled', 'user-1')).toBe(true);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError.mock.calls[0][2]).toMatchObject({ key: 'ai_chat_enabled', reason: 'evaluate_error' });
  });

  it('min_user_age_days の条件は、アカウント作成日時を読んで判定する', async () => {
    mockFetchFlagRecord.mockResolvedValue(row('veterans', { constraints: { min_user_age_days: 30 } }));
    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: [], organization_id: null, plan_key_cached: null, created_at: '2026-10-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('veterans', 'new-user')).toBe(false);

    mockProfileMaybeSingle.mockResolvedValueOnce({
      data: { roles: [], organization_id: null, plan_key_cached: null, created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    expect(await isFeatureEnabled('veterans', 'old-user')).toBe(true);
  });
});
