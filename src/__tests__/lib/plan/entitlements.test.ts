/**
 * #1177 (T26) / #1149 (T40) src/lib/plan/entitlements.ts の単体テスト
 *
 * - consumeAiUsage: DB の consume_ai_usage を 1 回呼んで、上限の判定と記録を受け取る (判定と記録は DB が原子的に行う)。
 *   上限に達していれば { allowed: false, limit, used }。失敗したら (DB エラー・応答が遅い・戻り値の形が違う・service role の設定漏れ)、
 *   例外を投げず、ログに残して許可する (止めない)
 * - refundAiUsage: 数えた 1 回を戻す (上限に数えない機能も戻す。DB が記録していない結果では何もしない)
 * - issueAiUsageGrant / redeemAiUsageGrant: 写真の判別が数えたあとの「数え済みの印」を作る・使う (1 回だけ。#1149)
 * - aiDailyLimitResponse: 429 AI_DAILY_LIMIT の応答 (固定の文・retryAfter・Retry-After)
 * - aiUsageRecordedHeaders: Next.js が Edge Function を呼ぶときに付ける、記録済みの印 (署名)
 * - getEffectivePlan: いま効いているプラン
 */
import fs from 'node:fs';
import path from 'node:path';
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
  AI_USAGE_COVERED_BY_GRANT,
  consumeAiUsage,
  getEffectivePlan,
  issueAiUsageGrant,
  redeemAiUsageGrant,
  refundAiUsage,
  type AiUsageAllowed,
  type PlanRpcClient,
} from '@/lib/plan/entitlements';
import {
  AI_ULTIMATE_MODE_DAILY_LIMIT_ENV,
  aiFeatureDailyCap,
  signAiUsageGrant,
  verifyAiUsageGrant,
  verifyAiUsageRecorded,
} from '../../../../supabase/functions/_shared/ai-usage-core';
import { ENV_VARS } from '@/lib/env';
import { isUltimateModeRequested } from '@/lib/ai/ultimate-mode';
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
        'AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT',
        'AI_ULTIMATE_MODE_DAILY_LIMIT_ENV',
        'AI_ULTIMATE_MODE_FEATURE',
        'AI_UNMETERED_DAILY_CAP_DEFAULTS',
        'AI_UNMETERED_FEATURES',
        'AI_USAGE_COVERED_BY_GRANT',
        'AI_USAGE_GRANT_MAX_AGE_SEC',
        'AI_USAGE_RECORDED_HEADER',
        'AI_USAGE_TIMEOUT_MS',
        'aiDailyLimitResponse',
        'aiDailyLimitSkippedField',
        'aiUsageRecordedHeaders',
        'consumeAiUsage',
        'getEffectivePlan',
        'issueAiUsageGrant',
        'redeemAiUsageGrant',
        'refundAiUsage',
      ].sort(),
    );
  });
});

describe('consumeAiUsage: 究極モード (#1142) は機能ごとの 1 日の上限と 1 日の上限を DB の 1 回の呼び出しで判定する', () => {
  /** DB の consume_ai_usage_capped の戻り値 (究極モードの上限に達している。記録していない) */
  const cappedDeniedRow = {
    allowed: false,
    metered: true,
    plan: null,
    limit: 1,
    used: 1,
    usage_date: TODAY_JST,
    capped_feature: 'menu_generation_ultimate',
  };

  it('menu_generation_ultimate は consume_ai_usage_capped を、既定の上限 1 回で呼ぶ (consume_ai_usage は呼ばない)', async () => {
    const { rpc, client } = clientReturning({ data: allowedRow(3), error: null });

    expect(await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client })).toEqual({
      allowed: true,
      metered: true,
      usageDate: TODAY_JST,
      limit: LIMIT,
      used: 3,
    });
    expect(rpc.mock.calls).toEqual([
      ['consume_ai_usage_capped', { p_user_id: USER_ID, p_feature: 'menu_generation_ultimate', p_feature_daily_cap: 1 }],
    ]);
  });

  it('究極モードの上限に達していたら、cappedFeature 付きの止めを返す。429 の本文は究極モードの文 (状態とコードは 1 日の上限と同じ)', async () => {
    const { client } = clientReturning({ data: cappedDeniedRow, error: null });
    const denied = await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client });
    expect(denied).toEqual({ allowed: false, limit: 1, used: 1, usageDate: TODAY_JST, cappedFeature: 'menu_generation_ultimate' });
    if (denied.allowed) throw new Error('止めのはず');

    const NOW_MS = Date.parse('2026-10-11T14:00:00Z'); // JST 23:00 (次の 0 時まで 1 時間)
    const res = aiDailyLimitResponse(denied, NOW_MS);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(await res.json()).toEqual({
      error: '今日の究極モードの利用回数の上限 (1 回) に達しました。明日 0 時から使えます。',
      code: 'AI_DAILY_LIMIT',
      limit: 1,
      cappedFeature: 'menu_generation_ultimate',
      retryAfter: 3600,
    });
  });

  it('究極モードの上限に達していなくても、1 日の上限で止めたとき (capped_feature が無い) は 1 日の上限の止め', async () => {
    const { client } = clientReturning({ data: deniedRow, error: null });
    expect(await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client })).toEqual({
      allowed: false,
      limit: LIMIT,
      used: LIMIT,
      usageDate: TODAY_JST,
    });
  });

  it.each([
    ['3', 3],
    ['0', 0],
    [' 2 ', 2],
  ])('環境変数 AI_ULTIMATE_MODE_DAILY_LIMIT=%j なら、その値 (%i) を渡す', async (raw, expected) => {
    vi.stubEnv('AI_ULTIMATE_MODE_DAILY_LIMIT', raw);
    const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
    await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client });
    expect(rpc.mock.calls[0][1]).toEqual({ p_user_id: USER_ID, p_feature: 'menu_generation_ultimate', p_feature_daily_cap: expected });
  });

  it.each(['', 'abc', '-1', '1.5', '1e3'])('環境変数の値が使えない (%j) ときは既定の 1 回 (無制限にしない)', async (raw) => {
    vi.stubEnv('AI_ULTIMATE_MODE_DAILY_LIMIT', raw);
    const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
    await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_feature_daily_cap: 1 });
  });

  it('aiFeatureDailyCap が尋ねる上書きの環境変数は、すべて consumeAiUsage が読んで DB に渡し、一覧 (readOnlyBy) と .env.example にある', async () => {
    // 機能ごとに、上限を決めるときに尋ねる環境変数の名前を集める
    const askedByFeature = AI_FEATURES.map((feature) => {
      const names: string[] = [];
      aiFeatureDailyCap(feature, (name) => {
        names.push(name);
        return undefined;
      });
      return { feature, names };
    }).filter(({ names }) => names.length > 0);
    // 空振りしていないこと: 究極モードは上書きの変数を尋ねる
    expect(askedByFeature.flatMap(({ names }) => names)).toContain(AI_ULTIMATE_MODE_DAILY_LIMIT_ENV);

    /** 既定 (1 回) と違う、上書きが効いたと分かる値 */
    const OVERRIDDEN_CAP = 7;
    const envExample = fs.readFileSync(path.resolve(__dirname, '../../../../.env.example'), 'utf-8');
    for (const { feature, names } of askedByFeature) {
      for (const name of names) {
        vi.stubEnv(name, String(OVERRIDDEN_CAP));
        const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
        await consumeAiUsage(USER_ID, feature, { client });
        // 読む側 (entitlements.ts の readFeatureDailyCapEnv) が名前を知らないと、既定の 1 回に黙って倒れる
        expect(rpc.mock.calls[0][1], `${feature}: ${name}`).toMatchObject({ p_feature_daily_cap: OVERRIDDEN_CAP });
        vi.unstubAllEnvs();

        // npm run check:env が案内でき、値を読む場所が consumeAiUsage の 1 か所に決まっている (tests/env-source-scan.test.ts が読む場所を確かめる)
        expect(ENV_VARS.find((entry) => entry.name === name)?.readOnlyBy, name).toBe('src/lib/plan/entitlements.ts');
        expect(envExample, name).toMatch(new RegExp(`^#?\\s*${name}=`, 'm'));
      }
    }
  });

  it('通常の献立生成 (menu_generation) は、環境変数があっても consume_ai_usage (機能ごとの上限なし)', async () => {
    vi.stubEnv('AI_ULTIMATE_MODE_DAILY_LIMIT', '0');
    const { rpc, client } = clientReturning({ data: allowedRow(1), error: null });
    await consumeAiUsage(USER_ID, 'menu_generation', { client });
    expect(rpc.mock.calls).toEqual([['consume_ai_usage', { p_user_id: USER_ID, p_feature: 'menu_generation' }]]);
  });

  it('DB の関数が無い (migration の未適用) ときは、ログに残して数えずに許可する (止めない)', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function consume_ai_usage_capped' } });
    expect(await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client })).toEqual(AI_USAGE_NOT_COUNTED);
    expect(mocks.loggerError.mock.calls[0][2]).toEqual({ feature: 'menu_generation_ultimate' });
  });

  it('isUltimateModeRequested: 真偽値の true だけが究極モード', () => {
    expect(isUltimateModeRequested(true)).toBe(true);
    for (const value of [false, 'true', 1, null, undefined, {}]) expect(isUltimateModeRequested(value), String(value)).toBe(false);
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

  it('DB が記録していない結果 (判定に失敗した・Edge Function で印があった・数え済みの印で数えなかった) では、何も呼ばない', async () => {
    const { rpc, client } = clientReturning({ data: true, error: null });

    await refundAiUsage(USER_ID, 'menu_generation', AI_USAGE_NOT_COUNTED, { client });
    await refundAiUsage(USER_ID, 'photo_analysis', AI_USAGE_COVERED_BY_GRANT, { client });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('(#1149) 上限に数えない機能も、記録した日で戻す (記録は安全弁の回数に入るので、送らなかった分は戻す)', async () => {
    const { rpc, client } = clientReturning({ data: true, error: null });

    await refundAiUsage(USER_ID, 'nutrition_advice_auto', { allowed: true, metered: false, usageDate: TODAY_JST, limit: null, used: null }, { client });

    expect(rpc).toHaveBeenCalledWith('refund_ai_usage', { p_user_id: USER_ID, p_feature: 'nutrition_advice_auto', p_usage_date: TODAY_JST });
  });

  it('失敗しても例外を投げず、ログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: '42501', message: 'denied' } });

    await expect(refundAiUsage(USER_ID, 'menu_generation', counted, { client })).resolves.toBeUndefined();
    expect(mocks.loggerError.mock.calls[0][0]).toContain('数え戻しに失敗');
    expect(mocks.loggerError.mock.calls[0][2]).toEqual({ feature: 'menu_generation', usageDate: TODAY_JST });
  });
});

describe('billing/03 §8.8: そのプランでは使えない機能 (plan_locked)', () => {
  it('consumeAiUsage passes through plan_locked denials unchanged (403 is decided by aiDailyLimitPayload)', async () => {
    const lockedRow = { allowed: false, metered: true, plan: 'free', limit: 0, used: 0, usage_date: TODAY_JST, capped_feature: 'image_generation', plan_locked: true };
    const { rpc, client } = clientReturning({ data: lockedRow, error: null });
    const result = await consumeAiUsage(USER_ID, 'image_generation', { client });
    expect(result).toEqual({ allowed: false, limit: 0, used: 0, usageDate: TODAY_JST, cappedFeature: 'image_generation', planLocked: true });
    // 判定は consume_ai_usage の 1 回だけ (究極モード以外)
    expect(rpc.mock.calls.map((call) => call[0])).toEqual(['consume_ai_usage']);
    // 応答の 403 は aiDailyLimitPayload が決める
    if (result.allowed) throw new Error('expected a denial');
    const res = aiDailyLimitResponse(result);
    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toEqual({
      error: '料理画像の作成は、有料プランでお使いいただけます。',
      code: 'AI_FEATURE_NOT_IN_PLAN',
      feature: 'image_generation',
    });
    // 究極モードの使えない機能も consume_ai_usage_capped の結果をそのまま返す
    const { client: cappedClient } = clientReturning({ data: { ...lockedRow, capped_feature: 'menu_generation_ultimate' }, error: null });
    expect(await consumeAiUsage(USER_ID, 'menu_generation_ultimate', { client: cappedClient })).toEqual({
      allowed: false, limit: 0, used: 0, usageDate: TODAY_JST, cappedFeature: 'menu_generation_ultimate', planLocked: true,
    });
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

describe('(#1149) 数え済みの印: issueAiUsageGrant / redeemAiUsageGrant (写真の判別 → 解析を 1 回に数える)', () => {
  const KEY = 'service-role-key-for-test';
  const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
  const counted: AiUsageAllowed = { allowed: true, metered: true, usageDate: TODAY_JST, limit: LIMIT, used: 1 };

  beforeEach(() => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', KEY);
  });

  it('上限に数えて許可したときだけ印を作る。印はサーバーの鍵で署名され、このユーザー・この機能でだけ通る。呼ぶたびに別の ID', async () => {
    const grant = await issueAiUsageGrant(USER_ID, 'photo_analysis', counted, NOW);
    expect(grant).toEqual(expect.any(String));
    const verified = await verifyAiUsageGrant(grant, 'photo_analysis', USER_ID, [KEY], NOW);
    expect(verified?.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifyAiUsageGrant(grant, 'photo_analysis', '99999999-2222-3333-4444-555555555555', [KEY], NOW)).toBeNull();

    const another = await issueAiUsageGrant(USER_ID, 'photo_analysis', counted, NOW);
    expect((await verifyAiUsageGrant(another, 'photo_analysis', USER_ID, [KEY], NOW))?.grantId).not.toBe(verified?.grantId);
  });

  it('数えていない結果 (止めた・判定に失敗した・上限に数えない機能)・ユーザーが空・鍵が無いときは、印を作らない (null)', async () => {
    expect(await issueAiUsageGrant(USER_ID, 'photo_analysis', { allowed: false, limit: LIMIT, used: LIMIT, usageDate: TODAY_JST }, NOW)).toBeNull();
    expect(await issueAiUsageGrant(USER_ID, 'photo_analysis', AI_USAGE_NOT_COUNTED, NOW)).toBeNull();
    expect(await issueAiUsageGrant(USER_ID, 'photo_analysis', { ...counted, metered: false }, NOW)).toBeNull();
    expect(await issueAiUsageGrant('', 'photo_analysis', counted, NOW)).toBeNull();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(await issueAiUsageGrant(USER_ID, 'photo_analysis', counted, NOW)).toBeNull();
  });

  it('本物の印は、DB の claim_ai_usage_grant で印の ID を使用済みにできたときだけ true (数えない)', async () => {
    const grantId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const grant = await signAiUsageGrant(KEY, 'photo_analysis', USER_ID, grantId, NOW);
    const { rpc, client } = clientReturning({ data: true, error: null });

    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', grant, { client, nowMs: NOW })).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('claim_ai_usage_grant', { p_user_id: USER_ID, p_grant_id: grantId });
  });

  it('使用済みの印 (DB が false) は false (数える)', async () => {
    const grant = await signAiUsageGrant(KEY, 'photo_analysis', USER_ID, '0f8fad5b-d9cb-469f-a165-70867728950e', NOW);
    const { client } = clientReturning({ data: false, error: null });

    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', grant, { client, nowMs: NOW })).toBe(false);
  });

  it('印が無い・偽物・期限切れ・他人の印・別の機能の印は、DB を呼ばずに false (数える)', async () => {
    const grant = await signAiUsageGrant(KEY, 'photo_analysis', USER_ID, '0f8fad5b-d9cb-469f-a165-70867728950e', NOW);
    const forged = await signAiUsageGrant('key-the-client-made-up', 'photo_analysis', USER_ID, '0f8fad5b-d9cb-469f-a165-70867728950e', NOW);
    const { rpc, client } = clientReturning({ data: true, error: null });

    for (const value of [undefined, null, '', 'garbage', 123, forged]) {
      expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', value, { client, nowMs: NOW }), String(value)).toBe(false);
    }
    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', grant, { client, nowMs: NOW + 3_600_000 })).toBe(false);
    expect(await redeemAiUsageGrant('99999999-2222-3333-4444-555555555555', 'photo_analysis', grant, { client, nowMs: NOW })).toBe(false);
    expect(await redeemAiUsageGrant(USER_ID, 'consultation', grant, { client, nowMs: NOW })).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('DB のエラー・応答の形の違いは、例外を投げずに false (数える側に倒す)。エラーはログに残す', async () => {
    const grant = await signAiUsageGrant(KEY, 'photo_analysis', USER_ID, '0f8fad5b-d9cb-469f-a165-70867728950e', NOW);

    const failing = clientReturning({ data: null, error: { code: '42883', message: 'function claim_ai_usage_grant does not exist' } });
    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', grant, { client: failing.client, nowMs: NOW })).toBe(false);
    expect(mocks.loggerError.mock.calls[0][0]).toContain('数え済みの印を使えません');

    const odd = clientReturning({ data: 'true', error: null });
    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', grant, { client: odd.client, nowMs: NOW })).toBe(false);
  });

  it('SERVICE_ROLE_JWT で作った印も、SUPABASE_SERVICE_ROLE_KEY で作った印も受け付ける (どちらの鍵で署名したサーバーの印も通す)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', 'jwt-form-of-the-key');
    const fromJwt = await issueAiUsageGrant(USER_ID, 'photo_analysis', counted, NOW);
    const fromKey = await signAiUsageGrant(KEY, 'photo_analysis', USER_ID, '0f8fad5b-d9cb-469f-a165-70867728950e', NOW);
    const { client } = clientReturning({ data: true, error: null });

    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', fromJwt, { client, nowMs: NOW })).toBe(true);
    expect(await redeemAiUsageGrant(USER_ID, 'photo_analysis', fromKey, { client, nowMs: NOW })).toBe(true);
  });

  it('数え済みの印で数えなかった結果は、許可・数えていない (usageDate が null で、数え戻しの対象にならない)', () => {
    expect(AI_USAGE_COVERED_BY_GRANT).toEqual({ allowed: true, metered: false, usageDate: null, limit: null, used: null });
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
