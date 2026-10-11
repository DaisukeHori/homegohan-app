/**
 * #1177 (T26) / #1149 (T40) Edge Functions の AI 利用回数の上限の判定と記録 (supabase/functions/_shared/ai-usage.ts) の単体テスト
 *
 * Edge Function は、ユーザー自身の JWT で直接呼ばれたとき (Next.js を経由しないとき) だけ数える (consumeEdgeAiUsage)。
 *   - service role の経路では呼ばない (呼び出し側の contract は tests/ai-usage-contract.test.ts)
 *   - Next.js が数え済みの呼び出し (署名つきの印 x-hg-ai-usage-recorded) は、数えずに許可する
 *   - 上限に達していれば { allowed: false }。aiDailyLimitEdgeResponse は 429 (CORS などのヘッダーを足す)
 *   - 失敗しても (DB エラー・応答が遅い)、ログに残して許可する (止めない)
 *   - refundEdgeAiUsage は数えた 1 回を戻す (数えていなければ何もしない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  withUser: vi.fn(),
  createClient: vi.fn(),
}));

// _shared/db-logger.ts は URL import (esm.sh) を含み Vitest で読めないので、差し替える
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({
    withUser: (userId: string) => {
      mocks.withUser(userId);
      return { error: mocks.loggerError };
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mocks.createClient(...args),
}));

// aiUsageRecordedHeaders (Next.js 側) を読み込むために必要な、Next.js 側の依存を差し替える
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ withUser: () => ({ error: vi.fn() }) }),
}));

import { AI_USAGE_RECORDED_HEADER, signAiUsageRecorded } from '../supabase/functions/_shared/ai-usage-core';
import * as edgeUsage from '../supabase/functions/_shared/ai-usage.ts';
import {
  aiDailyLimitEdgeResponse,
  consumeEdgeAiUsage,
  refundEdgeAiUsage,
  type AiUsageRpcClient,
} from '../supabase/functions/_shared/ai-usage.ts';
import { AI_USAGE_NOT_COUNTED, aiDailyLimitMessage } from '../supabase/functions/_shared/ai-daily-limit';
import { aiUsageRecordedHeaders } from '../src/lib/plan/entitlements';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_USER_ID = '99999999-2222-3333-4444-555555555555';
const SERVICE_KEY = 'service-role-key-for-test';
const JWT_KEY = 'service-role-jwt-for-test';

let env: Record<string, string | undefined> = {};

function requestWith(headers: Record<string, string> = {}): Request {
  return new Request('https://example.supabase.co/functions/v1/analyze-meal-photo', { method: 'POST', headers });
}

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };

function clientReturning(result: RpcResult | (() => PromiseLike<RpcResult>)) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    typeof result === 'function' ? result() : Promise.resolve(result),
  );
  return { rpc, client: { rpc } as AiUsageRpcClient };
}

beforeEach(() => {
  env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
  vi.stubGlobal('Deno', { env: { get: (key: string) => env[key] } });
  mocks.loggerError.mockReset();
  mocks.withUser.mockReset();
  mocks.createClient.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ALLOWED_ROW = { allowed: true, metered: true, plan: 'free', limit: 10, used: 1, usage_date: '2026-10-11' };
const OK: RpcResult = { data: ALLOWED_ROW, error: null };
const COUNTED = { allowed: true, metered: true, usageDate: '2026-10-11', limit: 10, used: 1 };

describe('consumeEdgeAiUsage: ユーザーの JWT で直接呼ばれたときに記録する', () => {
  it('consume_ai_usage を、ユーザー ID と機能名で 1 回呼び、許可の結果を返す', async () => {
    const { rpc, client } = clientReturning(OK);

    await expect(consumeEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client })).resolves.toEqual(COUNTED);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_usage', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('(#1149) 上限に達していれば { allowed: false } を返す。aiDailyLimitEdgeResponse は 429 で、渡したヘッダー (CORS) を残す', async () => {
    const { client } = clientReturning({ data: { ...ALLOWED_ROW, allowed: false, used: 10 }, error: null });

    const result = await consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation', { client });
    expect(result).toEqual({ allowed: false, limit: 10, used: 10, usageDate: '2026-10-11' });

    if (result.allowed) throw new Error('unreachable');
    const now = Date.UTC(2026, 9, 11, 14, 0, 0); // JST 23:00
    const res = aiDailyLimitEdgeResponse(result, { 'Access-Control-Allow-Origin': 'https://homegohan.app' }, now);
    expect(res.status).toBe(429);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://homegohan.app');
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: aiDailyLimitMessage(10), code: 'AI_DAILY_LIMIT', limit: 10, retryAfter: 3600 });
  });

  it('(#1149) refundEdgeAiUsage: 数えた日で refund_ai_usage を呼ぶ。数えていない結果では呼ばない。失敗しても例外を出さない', async () => {
    const { rpc, client } = clientReturning({ data: true, error: null });
    await refundEdgeAiUsage(USER_ID, 'shopping_list', COUNTED, { client });
    expect(rpc).toHaveBeenCalledWith('refund_ai_usage', { p_user_id: USER_ID, p_feature: 'shopping_list', p_usage_date: '2026-10-11' });

    rpc.mockClear();
    await refundEdgeAiUsage(USER_ID, 'shopping_list', AI_USAGE_NOT_COUNTED, { client });
    expect(rpc).not.toHaveBeenCalled();

    const failing = clientReturning({ data: null, error: { code: '42501', message: 'denied' } });
    await expect(refundEdgeAiUsage(USER_ID, 'shopping_list', COUNTED, { client: failing.client })).resolves.toBeUndefined();
    expect(mocks.loggerError.mock.calls[0][0]).toContain('数え戻しに失敗');
  });

  it('既定のクライアントは service role key で作る (セッションは持たない)。SERVICE_ROLE_JWT があれば優先する', async () => {
    const { rpc } = clientReturning(OK);
    mocks.createClient.mockReturnValue({ rpc });

    await consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    env.SERVICE_ROLE_JWT = JWT_KEY;
    await consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', JWT_KEY, expect.anything());
  });

  it('公開するのは、判定と記録・数え戻し・429 の応答と、機能の一覧・印のヘッダー名・コード (記録だけの関数は無い)', () => {
    expect(Object.keys(edgeUsage).sort()).toEqual(
      ['AI_DAILY_LIMIT_CODE', 'AI_FEATURES', 'AI_USAGE_RECORDED_HEADER', 'aiDailyLimitEdgeResponse', 'consumeEdgeAiUsage', 'refundEdgeAiUsage'].sort(),
    );
  });
});

describe('consumeEdgeAiUsage: Next.js が記録済みの呼び出しは記録しない', () => {
  it('署名つきの印 (有効・同じユーザー) があれば、数えずに許可する (DB を呼ばない)', async () => {
    const { rpc, client } = clientReturning(OK);
    const marker = await signAiUsageRecorded(SERVICE_KEY, USER_ID);

    await expect(
      consumeEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client }),
    ).resolves.toEqual(AI_USAGE_NOT_COUNTED);

    expect(rpc).not.toHaveBeenCalled();
  });

  it('Next.js が付ける印 (aiUsageRecordedHeaders) をそのまま受け付ける (署名の作り方と検証が合っている)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
    const { rpc, client } = clientReturning(OK);

    const headers = await aiUsageRecordedHeaders(USER_ID);
    expect(Object.keys(headers)).toEqual([AI_USAGE_RECORDED_HEADER]);
    await consumeEdgeAiUsage(requestWith(headers), USER_ID, 'photo_analysis', { client });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらの鍵で署名された印も受け付ける', async () => {
    env.SERVICE_ROLE_JWT = JWT_KEY;
    const { rpc, client } = clientReturning(OK);

    for (const key of [JWT_KEY, SERVICE_KEY]) {
      const marker = await signAiUsageRecorded(key, USER_ID);
      await consumeEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('偽の印は記録する: 別のユーザーの印・別の鍵の印・古い印・でたらめな値・クライアントが自分で付けた値', async () => {
    const now = Date.now();
    const MINUTE_MS = 60 * 1000;
    const forged = [
      await signAiUsageRecorded(SERVICE_KEY, OTHER_USER_ID, now), // 別のユーザー用
      await signAiUsageRecorded('attacker-guess', USER_ID, now), // 鍵を知らない者の署名
      await signAiUsageRecorded(SERVICE_KEY, USER_ID, now - 6 * MINUTE_MS), // 5 分より古い (使い回し)
      await signAiUsageRecorded(SERVICE_KEY, USER_ID, now + 5 * MINUTE_MS), // 未来すぎる
      'v1.1.' + '0'.repeat(64),
      'true',
      '1',
    ];

    for (const value of forged) {
      const { rpc, client } = clientReturning(OK);
      await consumeEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: value }), USER_ID, 'photo_analysis', { client });
      expect(rpc, value).toHaveBeenCalledTimes(1);
    }
  });

  it('service role の鍵が Edge 側に無ければ、印は検証できないので記録する', async () => {
    env = { SUPABASE_URL: 'https://example.supabase.co' };
    const { rpc, client } = clientReturning(OK);
    const marker = await signAiUsageRecorded(SERVICE_KEY, USER_ID);

    await consumeEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('consumeEdgeAiUsage: 失敗しても止めない', () => {
  it('DB のエラーでも、例外を投げず、ユーザー ID と機能つきでログに残して、数えずに許可する', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    await expect(consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation', { client })).resolves.toEqual(AI_USAGE_NOT_COUNTED);

    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('判定と記録に失敗');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'consultation' });
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さない', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(consumeEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client })).resolves.toEqual(AI_USAGE_NOT_COUNTED);
  });

  it('rpc の例外・クライアントを作れない (環境変数が無い) 場合も、例外を出さない', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as AiUsageRpcClient;
    await expect(consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation', { client: syncThrow })).resolves.toEqual(AI_USAGE_NOT_COUNTED);

    mocks.createClient.mockImplementation(() => {
      throw new Error('supabaseUrl is required.');
    });
    env = {};
    await expect(consumeEdgeAiUsage(requestWith(), USER_ID, 'consultation')).resolves.toEqual(AI_USAGE_NOT_COUNTED);

    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });

  it('応答が遅いときは、待ち続けずに許可する', async () => {
    const { client } = clientReturning(() => new Promise<RpcResult>(() => {}));
    const TIMEOUT_FOR_TEST_MS = 30;

    const startedAt = Date.now();
    expect(await consumeEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client, timeoutMs: TIMEOUT_FOR_TEST_MS })).toEqual(
      AI_USAGE_NOT_COUNTED,
    );

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('consume_ai_usage timed out');
  });

  it('戻り値の形が違うときも、ログに残して許可する (止める根拠にしない)', async () => {
    const { client } = clientReturning({ data: { allowed: false }, error: null });

    expect(await consumeEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client })).toEqual(AI_USAGE_NOT_COUNTED);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('unexpected value');
  });
});
