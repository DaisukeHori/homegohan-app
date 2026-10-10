/**
 * #1177 (T26) src/lib/plan/entitlements.ts の単体テスト
 *
 * - recordAiUsage: DB の record_ai_usage を呼んで記録するだけ (止める判定はしない。#1149 / T40 が足す)。失敗したら
 *   (DB エラー・応答が遅い・service role の設定漏れ)、例外を投げず、ログに残して戻る (止めない)
 * - aiUsageRecordedHeaders: Next.js が Edge Function を呼ぶときに付ける、記録済みの印 (署名)
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

import * as entitlements from '@/lib/plan/entitlements';
import {
  AI_FEATURES,
  AI_USAGE_RECORDED_HEADER,
  aiUsageRecordedHeaders,
  getEffectivePlan,
  recordAiUsage,
  type PlanRpcClient,
} from '@/lib/plan/entitlements';
import { verifyAiUsageRecorded } from '../../../../supabase/functions/_shared/ai-usage-core';

const USER_ID = '11111111-2222-3333-4444-555555555555';

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

function clientReturning(result: RpcResult | (() => PromiseLike<RpcResult>)) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    typeof result === 'function' ? result() : Promise.resolve(result),
  );
  return { rpc, client: { rpc } as PlanRpcClient };
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

describe('recordAiUsage: 記録する (止めない)', () => {
  it('record_ai_usage を、ユーザー ID と機能名で 1 回呼ぶ。戻り値は無い (呼び出し側は結果で分岐しない)', async () => {
    const { rpc, client } = clientReturning({ data: null, error: null });

    await expect(recordAiUsage(USER_ID, 'photo_analysis', { client })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_ai_usage', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('client を渡さなければ service_role のクライアント (getSupabaseAdmin) を使う', async () => {
    const { rpc, client } = clientReturning({ data: null, error: null });
    mocks.getSupabaseAdmin.mockReturnValue(client);

    await recordAiUsage(USER_ID, 'menu_generation');

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_ai_usage', { p_user_id: USER_ID, p_feature: 'menu_generation' });
  });

  it('機能名はすべて AI_FEATURES にある名前をそのまま渡す', async () => {
    const { rpc, client } = clientReturning({ data: null, error: null });
    for (const feature of AI_FEATURES) await recordAiUsage(USER_ID, feature, { client });

    expect(rpc.mock.calls.map((call) => call[1].p_feature)).toEqual([...AI_FEATURES]);
  });

  it('上限と比べて止める部品 (429 の応答・上限の読み取り) は公開しない (止める処理は #1149 / T40 が足す)', () => {
    expect(Object.keys(entitlements).sort()).toEqual(
      ['AI_FEATURES', 'AI_USAGE_RECORDED_HEADER', 'AI_USAGE_TIMEOUT_MS', 'aiUsageRecordedHeaders', 'getEffectivePlan', 'recordAiUsage'].sort(),
    );
  });
});

describe('recordAiUsage: 失敗しても止めない', () => {
  it('DB のエラーが返っても、例外を投げず、ユーザー ID と機能つきでログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    await expect(recordAiUsage(USER_ID, 'photo_analysis', { client })).resolves.toBeUndefined();

    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('記録に失敗');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'photo_analysis' });
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さない', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(recordAiUsage(USER_ID, 'photo_analysis', { client })).resolves.toBeUndefined();
  });

  it('rpc が例外を投げても (同期・非同期のどちらも)、例外を出さない', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as PlanRpcClient;
    const asyncReject = { rpc: vi.fn(() => Promise.reject(new Error('network down'))) } as unknown as PlanRpcClient;

    await expect(recordAiUsage(USER_ID, 'consultation', { client: syncThrow })).resolves.toBeUndefined();
    await expect(recordAiUsage(USER_ID, 'consultation', { client: asyncReject })).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });

  it('service role の設定が無く getSupabaseAdmin が例外を投げても、例外を出さない', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    await expect(recordAiUsage(USER_ID, 'menu_generation')).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('env is missing');
  });

  it('応答が遅いときは、待ち続けずに先へ進む (AI の応答を遅らせない)', async () => {
    const never = () => new Promise<RpcResult>(() => {});
    const { client } = clientReturning(never);
    const TIMEOUT_FOR_TEST_MS = 30;

    const startedAt = Date.now();
    await recordAiUsage(USER_ID, 'photo_analysis', { client, timeoutMs: TIMEOUT_FOR_TEST_MS });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('timed out');
  });

  it('タイマーを残さない (正常に返った場合も、タイムアウトの待ちを残さない)', async () => {
    vi.useFakeTimers();
    const { client } = clientReturning({ data: null, error: null });

    await recordAiUsage(USER_ID, 'consultation', { client });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('aiUsageRecordedHeaders: 記録済みの印 (Next.js -> Edge Function)', () => {
  it('service role key で署名した印を返し、Edge Function 側の検証 (verifyAiUsageRecorded) を通る', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);

    const headers = await aiUsageRecordedHeaders(USER_ID, now);

    expect(Object.keys(headers)).toEqual([AI_USAGE_RECORDED_HEADER]);
    const value = headers[AI_USAGE_RECORDED_HEADER];
    expect(await verifyAiUsageRecorded(value, USER_ID, ['service-role-key-for-test'], now)).toBe(true);
    // 別のユーザーでは通らない (他人の操作の分を記録しないことにはできない)
    expect(await verifyAiUsageRecorded(value, '99999999-2222-3333-4444-555555555555', ['service-role-key-for-test'], now)).toBe(false);
  });

  it('SERVICE_ROLE_JWT があればそちらで署名する (meal image のワーカー呼び出しと同じ優先順位)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', 'jwt-form-of-the-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'the-other-key');

    const value = (await aiUsageRecordedHeaders(USER_ID))[AI_USAGE_RECORDED_HEADER];

    expect(await verifyAiUsageRecorded(value, USER_ID, ['jwt-form-of-the-key'])).toBe(true);
    expect(await verifyAiUsageRecorded(value, USER_ID, ['the-other-key'])).toBe(false);
  });

  it('呼ぶたびに署名し直す (古い印を使い回さない)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');

    const first = (await aiUsageRecordedHeaders(USER_ID, 1_000_000_000_000))[AI_USAGE_RECORDED_HEADER];
    const later = (await aiUsageRecordedHeaders(USER_ID, 1_000_000_060_000))[AI_USAGE_RECORDED_HEADER];

    expect(first).not.toBe(later);
  });

  it('SERVICE_ROLE_JWT が空白だけなら、設定されていないものとして SUPABASE_SERVICE_ROLE_KEY で署名する (#1434)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '   ');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');

    const value = (await aiUsageRecordedHeaders(USER_ID))[AI_USAGE_RECORDED_HEADER];

    expect(await verifyAiUsageRecorded(value, USER_ID, ['service-role-key-for-test'])).toBe(true);
  });

  it('鍵が空白だけでも、鍵が無い環境として印を付けない (#1434)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '   ');

    expect(await aiUsageRecordedHeaders(USER_ID)).toEqual({});
  });

  it('鍵が無い環境・ユーザー ID が空のときは、印を付けない (空のヘッダー。Edge Function が記録するだけ)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    expect(await aiUsageRecordedHeaders(USER_ID)).toEqual({});

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');
    expect(await aiUsageRecordedHeaders('')).toEqual({});
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

  it('DB のエラーは例外にする (AI の利用回数の記録と違い、プランが分からないまま先へ進めない)', async () => {
    const { client } = clientReturning({ data: null, error: { code: '42501', message: 'permission denied for function get_effective_plan' } });

    await expect(getEffectivePlan(USER_ID, { client })).rejects.toThrow(/42501/);
  });

  it('client を渡さなければ getSupabaseAdmin を使う', async () => {
    const { client } = clientReturning({ data: 'pro', error: null });
    mocks.getSupabaseAdmin.mockReturnValue(client);

    expect(await getEffectivePlan(USER_ID)).toBe('pro');
  });
});
