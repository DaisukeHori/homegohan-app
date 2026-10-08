/**
 * #1177 (T26) src/lib/plan/entitlements.ts の単体テスト
 *
 * - consumeAiQuota: DB の consume_ai_quota を呼び、結果を読む。失敗したら (DB エラー・応答が遅い・想定外の形・
 *   service role の設定漏れ)、例外を投げず、記録して許可する (止めない)
 * - aiQuotaExceededResponse: 上限を超えたときの 429 (いまは通らない)
 * - aiQuotaCountedHeaders: Next.js が Edge Function を呼ぶときに付ける、数え済みの印 (署名)
 * - getEffectivePlan: いま効いているプラン
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  withUser: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    withUser: (userId: string) => {
      mocks.withUser(userId);
      return { error: mocks.loggerError };
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mocks.getSupabaseAdmin(...args),
}));

import {
  AI_FEATURES,
  AI_QUOTA_COUNTED_HEADER,
  aiQuotaCountedHeaders,
  aiQuotaExceededResponse,
  consumeAiQuota,
  getEffectivePlan,
  type QuotaRpcClient,
} from '@/lib/plan/entitlements';
import { verifyAiQuotaCounted } from '../../../../supabase/functions/_shared/ai-quota-core';

const USER_ID = '11111111-2222-3333-4444-555555555555';

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

function clientReturning(result: RpcResult | (() => PromiseLike<RpcResult>)) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    typeof result === 'function' ? result() : Promise.resolve(result),
  );
  return { rpc, client: { rpc } as QuotaRpcClient };
}

beforeEach(() => {
  mocks.loggerError.mockReset();
  mocks.withUser.mockReset();
  mocks.getSupabaseAdmin.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('consumeAiQuota: 数える', () => {
  it('consume_ai_quota を、ユーザー ID と機能名で呼ぶ。無制限なら allowed=true・remaining=null', async () => {
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null, plan_key: 'free' }, error: null });

    const result = await consumeAiQuota(USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_quota', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(result).toEqual({ allowed: true, remaining: null, planKey: 'free' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('client を渡さなければ service_role のクライアント (getSupabaseAdmin) を使う', async () => {
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: 4, plan_key: 'pro' }, error: null });
    mocks.getSupabaseAdmin.mockReturnValue(client);

    const result = await consumeAiQuota(USER_ID, 'menu_generation');

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_quota', { p_user_id: USER_ID, p_feature: 'menu_generation' });
    expect(result).toEqual({ allowed: true, remaining: 4, planKey: 'pro' });
  });

  it('上限を超えたときは allowed=false と、上限の種類・値・戻る時刻を返す', async () => {
    const { client } = clientReturning({
      data: {
        allowed: false,
        remaining: 0,
        plan_key: 'free',
        limit_kind: 'daily',
        limit: 5,
        reset_at: '2026-10-08T15:00:00Z',
      },
      error: null,
    });

    expect(await consumeAiQuota(USER_ID, 'consultation', { client })).toEqual({
      allowed: false,
      remaining: 0,
      planKey: 'free',
      limitKind: 'daily',
      limit: 5,
      resetAt: '2026-10-08T15:00:00Z',
    });
  });

  it('機能名はすべて AI_FEATURES にある名前をそのまま渡す', async () => {
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });
    for (const feature of AI_FEATURES) await consumeAiQuota(USER_ID, feature, { client });

    expect(rpc.mock.calls.map((call) => call[1].p_feature)).toEqual([...AI_FEATURES]);
  });
});

describe('consumeAiQuota: 失敗しても止めない (fail-open)', () => {
  it('DB のエラーが返っても、例外を投げず、許可して、ユーザー ID と機能つきでログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    const result = await consumeAiQuota(USER_ID, 'photo_analysis', { client });

    expect(result).toEqual({ allowed: true, remaining: null });
    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('許可');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'photo_analysis' });
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さずに許可する', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(consumeAiQuota(USER_ID, 'photo_analysis', { client })).resolves.toEqual({ allowed: true, remaining: null });
  });

  it('rpc が例外を投げても (同期・非同期のどちらも)、許可する', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as QuotaRpcClient;
    const asyncReject = { rpc: vi.fn(() => Promise.reject(new Error('network down'))) } as unknown as QuotaRpcClient;

    expect(await consumeAiQuota(USER_ID, 'consultation', { client: syncThrow })).toEqual({ allowed: true, remaining: null });
    expect(await consumeAiQuota(USER_ID, 'consultation', { client: asyncReject })).toEqual({ allowed: true, remaining: null });
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });

  it('応答が想定外の形 (null・allowed が無い・remaining が文字列) でも許可する', async () => {
    for (const data of [null, undefined, 'ok', {}, { allowed: 'true' }, { allowed: true, remaining: '3' }]) {
      const { client } = clientReturning({ data, error: null });
      expect(await consumeAiQuota(USER_ID, 'consultation', { client }), JSON.stringify(data)).toEqual({ allowed: true, remaining: null });
    }
    expect(mocks.loggerError).toHaveBeenCalledTimes(6);
  });

  it('service role の設定が無く getSupabaseAdmin が例外を投げても、許可する', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    expect(await consumeAiQuota(USER_ID, 'menu_generation')).toEqual({ allowed: true, remaining: null });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('env is missing');
  });

  it('応答が遅いときは、待ち続けずに許可して先へ進む (AI の応答を遅らせない)', async () => {
    const never = () => new Promise<RpcResult>(() => {});
    const { client } = clientReturning(never);

    const startedAt = Date.now();
    const result = await consumeAiQuota(USER_ID, 'photo_analysis', { client, timeoutMs: 30 });

    expect(result).toEqual({ allowed: true, remaining: null });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('timed out');
  });

  it('タイマーを残さない (正常に返った場合も、タイムアウトの待ちを残さない)', async () => {
    vi.useFakeTimers();
    const { client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });

    await consumeAiQuota(USER_ID, 'consultation', { client });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('aiQuotaExceededResponse: 上限を超えたときの 429', () => {
  const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

  it('日次: 429・code=AI_DAILY_LIMIT・Retry-After (回数が戻るまでの秒数)', async () => {
    const response = aiQuotaExceededResponse(
      { allowed: false, remaining: 0, limitKind: 'daily', limit: 10, resetAt: '2026-10-08T15:00:00Z' },
      NOW,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe(String(3 * 60 * 60));
    const body = await response.json();
    expect(body).toMatchObject({ code: 'AI_DAILY_LIMIT', limit: 10, resetAt: '2026-10-08T15:00:00Z', retryAfter: 3 * 60 * 60 });
    expect(body.error).toContain('本日');
  });

  it('月次: code=AI_MONTHLY_LIMIT', async () => {
    const response = aiQuotaExceededResponse({ allowed: false, remaining: 0, limitKind: 'monthly', limit: 100 }, NOW);

    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('AI_MONTHLY_LIMIT');
  });

  it('戻る時刻が分からなければ Retry-After は付けない。レート制限の 429 とは code が違う', async () => {
    const response = aiQuotaExceededResponse({ allowed: false, remaining: 0 }, NOW);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeNull();
    const body = await response.json();
    expect(body.code).toBe('AI_DAILY_LIMIT');
    expect(body.code).not.toBe('RATE_LIMITED');
  });
});

describe('aiQuotaCountedHeaders: 数え済みの印 (Next.js -> Edge Function)', () => {
  it('service role key で署名した印を返し、Edge Function 側の検証 (verifyAiQuotaCounted) を通る', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);

    const headers = await aiQuotaCountedHeaders(USER_ID, now);

    expect(Object.keys(headers)).toEqual([AI_QUOTA_COUNTED_HEADER]);
    const value = headers[AI_QUOTA_COUNTED_HEADER];
    expect(await verifyAiQuotaCounted(value, USER_ID, ['service-role-key-for-test'], now)).toBe(true);
    // 別のユーザーでは通らない (他人の操作の分を数えないことにはできない)
    expect(await verifyAiQuotaCounted(value, '99999999-2222-3333-4444-555555555555', ['service-role-key-for-test'], now)).toBe(false);
  });

  it('SERVICE_ROLE_JWT があればそちらで署名する (meal image のワーカー呼び出しと同じ優先順位)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', 'jwt-form-of-the-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'the-other-key');

    const value = (await aiQuotaCountedHeaders(USER_ID))[AI_QUOTA_COUNTED_HEADER];

    expect(await verifyAiQuotaCounted(value, USER_ID, ['jwt-form-of-the-key'])).toBe(true);
    expect(await verifyAiQuotaCounted(value, USER_ID, ['the-other-key'])).toBe(false);
  });

  it('呼ぶたびに署名し直す (古い印を使い回さない)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');

    const first = (await aiQuotaCountedHeaders(USER_ID, 1_000_000_000_000))[AI_QUOTA_COUNTED_HEADER];
    const later = (await aiQuotaCountedHeaders(USER_ID, 1_000_000_060_000))[AI_QUOTA_COUNTED_HEADER];

    expect(first).not.toBe(later);
  });

  it('鍵が無い環境・ユーザー ID が空のときは、印を付けない (空のヘッダー。Edge Function が数えるだけ)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    expect(await aiQuotaCountedHeaders(USER_ID)).toEqual({});

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
    expect(await aiQuotaCountedHeaders('')).toEqual({});
  });
});

describe('getEffectivePlan: いま効いているプラン', () => {
  it('get_effective_plan を呼び、plan_key を返す', async () => {
    const { rpc, client } = clientReturning({ data: 'family_basic', error: null });

    expect(await getEffectivePlan(USER_ID, { client })).toBe('family_basic');
    expect(rpc).toHaveBeenCalledWith('get_effective_plan', { p_user_id: USER_ID });
  });

  it('空・null が返ったら free', async () => {
    for (const data of [null, '', undefined]) {
      const { client } = clientReturning({ data, error: null });
      expect(await getEffectivePlan(USER_ID, { client })).toBe('free');
    }
  });

  it('DB のエラーは例外にする (AI の計測と違い、プランが分からないまま先へ進めない)', async () => {
    const { client } = clientReturning({ data: null, error: { code: '42501', message: 'permission denied for function get_effective_plan' } });

    await expect(getEffectivePlan(USER_ID, { client })).rejects.toThrow(/42501/);
  });

  it('client を渡さなければ getSupabaseAdmin を使う', async () => {
    const { client } = clientReturning({ data: 'pro', error: null });
    mocks.getSupabaseAdmin.mockReturnValue(client);

    expect(await getEffectivePlan(USER_ID)).toBe('pro');
  });
});
