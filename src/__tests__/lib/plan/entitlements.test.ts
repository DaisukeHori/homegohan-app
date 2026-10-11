/**
 * #1177 (T26) / #1149 (T40) src/lib/plan/entitlements.ts の単体テスト
 *
 * - consumeAiUsage: DB の consume_ai_usage を 1 回呼んで、上限の判定と記録を受け取る (判定と記録は DB が原子的に行う)。
 *   上限に達していれば { allowed: false, limit, used }。失敗したら (DB エラー・応答が遅い・戻り値の形が違う・service role の設定漏れ)、
 *   例外を投げず、ログに残して許可する (止めない)
 * - refundAiUsage: 数えた 1 回を戻す (数えていない結果では何もしない)
 * - aiDailyLimitResponse: 429 AI_DAILY_LIMIT の応答 (固定の文・retryAfter・Retry-After)
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
  AI_DAILY_LIMIT_CODE,
  AI_FEATURES,
  AI_USAGE_RECORDED_HEADER,
  aiDailyLimitResponse,
  aiUsageRecordedHeaders,
  consumeAiUsage,
  getEffectivePlan,
  refundAiUsage,
  type AiUsageAllowed,
  type PlanRpcClient,
} from '@/lib/plan/entitlements';
import { verifyAiUsageRecorded } from '../../../../supabase/functions/_shared/ai-usage-core';
import { AI_USAGE_NOT_COUNTED } from '../../../../supabase/functions/_shared/ai-daily-limit';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const TODAY_JST = '2026-10-11';
const LIMIT = 10;

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

function clientReturning(result: RpcResult | (() => PromiseLike<RpcResult>)) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    typeof result === 'function' ? result() : Promise.resolve(result),
  );
  return { rpc, client: { rpc } as PlanRpcClient };
}

/** DB の consume_ai_usage の戻り値 (許可) */
const allowedRow = (used: number) => ({ allowed: true, metered: true, plan: 'free', limit: LIMIT, used, usage_date: TODAY_JST });
/** DB の consume_ai_usage の戻り値 (止め) */
const deniedRow = { allowed: false, metered: true, plan: 'free', limit: LIMIT, used: LIMIT, usage_date: TODAY_JST };

beforeEach(() => {
  mocks.loggerError.mockReset();
  mocks.withUser.mockReset();
  mocks.getSupabaseAdmin.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('consumeAiUsage: 上限の判定と記録を DB の 1 回の呼び出しで受け取る', () => {
  it('consume_ai_usage を、ユーザー ID と機能名で 1 回呼び、許可の結果 (数えた日・上限・数えたあとの回数) を返す', async () => {
    const { rpc, client } = clientReturning({ data: allowedRow(3), error: null });

    const result = await consumeAiUsage(USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_usage', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(result).toEqual({ allowed: true, metered: true, usageDate: TODAY_JST, limit: LIMIT, used: 3 });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('上限に達していれば { allowed: false, limit, used, usageDate } を返す (記録していない)', async () => {
    const { client } = clientReturning({ data: deniedRow, error: null });

    expect(await consumeAiUsage(USER_ID, 'menu_generation', { client })).toEqual({
      allowed: false,
      limit: LIMIT,
      used: LIMIT,
      usageDate: TODAY_JST,
    });
  });

  it('無制限のプラン (limit が null) と、上限に数えない機能 (metered: false) も許可として読む', async () => {
    const unlimited = clientReturning({ data: { ...allowedRow(25), limit: null }, error: null });
    expect(await consumeAiUsage(USER_ID, 'consultation', { client: unlimited.client })).toMatchObject({ allowed: true, limit: null, used: 25 });

    const unmetered = clientReturning({
      data: { allowed: true, metered: false, plan: null, limit: null, used: null, usage_date: TODAY_JST },
      error: null,
    });
    expect(await consumeAiUsage(USER_ID, 'nutrition_advice_auto', { client: unmetered.client })).toEqual({
      allowed: true,
      metered: false,
      usageDate: TODAY_JST,
      limit: null,
      used: null,
    });
  });

  it('client を渡さなければ service_role のクライアント (getSupabaseAdmin) を使う', async () => {
    const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
    mocks.getSupabaseAdmin.mockReturnValue(client);

    await consumeAiUsage(USER_ID, 'menu_generation');

    expect(mocks.getSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_usage', { p_user_id: USER_ID, p_feature: 'menu_generation' });
  });

  it('機能名はすべて AI_FEATURES にある名前をそのまま渡す', async () => {
    const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
    for (const feature of AI_FEATURES) await consumeAiUsage(USER_ID, feature, { client });

    expect(rpc.mock.calls.map((call) => call[1].p_feature)).toEqual([...AI_FEATURES]);
  });

  it('公開するのは判定・数え戻し・429 の応答・印・プランの部品だけ (記録だけの関数 recordAiUsage は無い: 入口は必ず判定を通す)', () => {
    expect(Object.keys(entitlements).sort()).toEqual(
      [
        'AI_DAILY_LIMIT_CODE',
        'AI_DAILY_LIMIT_STATUS',
        'AI_FEATURES',
        'AI_UNMETERED_FEATURES',
        'AI_USAGE_RECORDED_HEADER',
        'AI_USAGE_TIMEOUT_MS',
        'aiDailyLimitResponse',
        'aiDailyLimitSkippedField',
        'aiUsageRecordedHeaders',
        'consumeAiUsage',
        'getEffectivePlan',
        'refundAiUsage',
      ].sort(),
    );
  });
});

describe('consumeAiUsage: 失敗しても止めない (許可する)', () => {
  it('DB のエラーが返っても、例外を投げず、ユーザー ID と機能つきでログに残して、数えずに許可する', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    await expect(consumeAiUsage(USER_ID, 'photo_analysis', { client })).resolves.toEqual(AI_USAGE_NOT_COUNTED);

    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('判定と記録に失敗');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'photo_analysis' });
  });

  it.each([
    ['null', null],
    ['allowed が無い', { usage_date: TODAY_JST }],
    ['日付が無い', { allowed: false, limit: LIMIT, used: LIMIT }],
    ['止めなのに上限の回数が無い', { allowed: false, usage_date: TODAY_JST, used: LIMIT }],
    ['配列', [allowedRow(1)]],
  ])('戻り値の形が違う (%s) ときは、ログに残して許可する (止める根拠にしない)', async (_label, data) => {
    const { client } = clientReturning({ data, error: null });

    expect(await consumeAiUsage(USER_ID, 'photo_analysis', { client })).toEqual(AI_USAGE_NOT_COUNTED);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('unexpected value');
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さない', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(consumeAiUsage(USER_ID, 'photo_analysis', { client })).resolves.toEqual(AI_USAGE_NOT_COUNTED);
  });

  it('rpc が例外を投げても (同期・非同期のどちらも)、例外を出さない', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as PlanRpcClient;
    const asyncReject = { rpc: vi.fn(() => Promise.reject(new Error('network down'))) } as unknown as PlanRpcClient;

    await expect(consumeAiUsage(USER_ID, 'consultation', { client: syncThrow })).resolves.toEqual(AI_USAGE_NOT_COUNTED);
    await expect(consumeAiUsage(USER_ID, 'consultation', { client: asyncReject })).resolves.toEqual(AI_USAGE_NOT_COUNTED);
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });

  it('service role の設定が無く getSupabaseAdmin が例外を投げても、例外を出さない', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    await expect(consumeAiUsage(USER_ID, 'menu_generation')).resolves.toEqual(AI_USAGE_NOT_COUNTED);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('env is missing');
  });

  it('応答が遅いときは、待ち続けずに許可する (AI の応答を遅らせない)', async () => {
    const never = () => new Promise<RpcResult>(() => {});
    const { client } = clientReturning(never);
    const TIMEOUT_FOR_TEST_MS = 30;

    const startedAt = Date.now();
    expect(await consumeAiUsage(USER_ID, 'photo_analysis', { client, timeoutMs: TIMEOUT_FOR_TEST_MS })).toEqual(AI_USAGE_NOT_COUNTED);

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('consume_ai_usage timed out');
  });

  it('タイマーを残さない (正常に返った場合も、タイムアウトの待ちを残さない)', async () => {
    vi.useFakeTimers();
    const { client } = clientReturning({ data: allowedRow(1), error: null });

    await consumeAiUsage(USER_ID, 'consultation', { client });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('refundAiUsage: 数えた 1 回を戻す (#1149)', () => {
  const counted: AiUsageAllowed = { allowed: true, metered: true, usageDate: TODAY_JST, limit: LIMIT, used: 4 };

  it('数えた結果なら、refund_ai_usage を数えた日で呼ぶ (日をまたいでも、数えた日の回数を戻す)', async () => {
    const { rpc, client } = clientReturning({ data: true, error: null });

    await refundAiUsage(USER_ID, 'menu_generation', counted, { client });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('refund_ai_usage', { p_user_id: USER_ID, p_feature: 'menu_generation', p_usage_date: TODAY_JST });
  });

  it('数えていない結果 (上限に数えない機能・判定に失敗した・印があった) では、何も呼ばない', async () => {
    const { rpc, client } = clientReturning({ data: true, error: null });

    await refundAiUsage(USER_ID, 'menu_generation', AI_USAGE_NOT_COUNTED, { client });
    await refundAiUsage(USER_ID, 'nutrition_advice_auto', { ...counted, metered: false }, { client });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('失敗しても例外を投げず、ログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: '42501', message: 'denied' } });

    await expect(refundAiUsage(USER_ID, 'menu_generation', counted, { client })).resolves.toBeUndefined();
    expect(mocks.loggerError.mock.calls[0][0]).toContain('数え戻しに失敗');
    expect(mocks.loggerError.mock.calls[0][2]).toEqual({ feature: 'menu_generation', usageDate: TODAY_JST });
  });
});

describe('aiDailyLimitResponse: 上限に達したときの応答 (#1149)', () => {
  it('429 と固定の文・コード・上限の回数・次の JST 0 時までの秒数 (本文と Retry-After)', async () => {
    // JST 2026-10-11 23:59:30 (= UTC 14:59:30) → 次の JST 0 時まで 30 秒
    const now = Date.UTC(2026, 9, 11, 14, 59, 30);
    const res = aiDailyLimitResponse({ allowed: false, limit: LIMIT, used: LIMIT, usageDate: TODAY_JST }, now);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({
      error: '今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。',
      code: AI_DAILY_LIMIT_CODE,
      limit: LIMIT,
      retryAfter: 30,
    });
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
