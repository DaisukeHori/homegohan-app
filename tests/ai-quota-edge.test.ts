/**
 * #1177 (T26) Edge Functions の AI 利用回数の記録 (supabase/functions/_shared/quota.ts) の単体テスト
 *
 * Edge Function は、ユーザー自身の JWT で直接呼ばれたとき (Next.js を経由しないとき) だけ数える。
 *   - service role の経路では呼ばない (呼び出し側の contract は tests/ai-quota-contract.test.ts)
 *   - Next.js が数え済みの呼び出し (署名つきの印 x-hg-ai-quota-counted) は、数えない
 *   - 失敗しても (DB エラー・応答が遅い・想定外の形)、記録して許可する (止めない)
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

// aiQuotaCountedHeaders (Next.js 側) を読み込むために必要な、Next.js 側の依存を差し替える
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ withUser: () => ({ error: vi.fn() }) }),
}));

import { AI_QUOTA_COUNTED_HEADER, signAiQuotaCounted } from '../supabase/functions/_shared/ai-quota-core';
import {
  aiQuotaExceededResponse,
  consumeEdgeAiQuota,
  type QuotaRpcClient,
} from '../supabase/functions/_shared/quota.ts';
import { aiQuotaCountedHeaders } from '../src/lib/plan/entitlements';

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
  return { rpc, client: { rpc } as QuotaRpcClient };
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

describe('consumeEdgeAiQuota: ユーザーの JWT で直接呼ばれたときに数える', () => {
  it('consume_ai_quota を、ユーザー ID と機能名で呼ぶ。無制限なら allowed=true・remaining=null', async () => {
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null, plan_key: 'free' }, error: null });

    const result = await consumeEdgeAiQuota(requestWith(), USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('consume_ai_quota', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(result).toEqual({ allowed: true, remaining: null, planKey: 'free' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('既定のクライアントは service role key で作る (セッションは持たない)。SERVICE_ROLE_JWT があれば優先する', async () => {
    const { rpc } = clientReturning({ data: { allowed: true, remaining: null }, error: null });
    mocks.createClient.mockReturnValue({ rpc });

    await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    env.SERVICE_ROLE_JWT = JWT_KEY;
    await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', JWT_KEY, expect.anything());
  });

  it('上限を超えたときは allowed=false を返す (いまは通らない)', async () => {
    const { client } = clientReturning({
      data: { allowed: false, remaining: 0, plan_key: 'free', limit_kind: 'daily', limit: 3, reset_at: '2026-10-08T15:00:00Z' },
      error: null,
    });

    expect(await consumeEdgeAiQuota(requestWith(), USER_ID, 'menu_generation', { client })).toMatchObject({
      allowed: false,
      limitKind: 'daily',
      limit: 3,
    });
  });
});

describe('consumeEdgeAiQuota: Next.js が数え済みの呼び出しは数えない', () => {
  it('署名つきの印 (有効・同じユーザー) があれば、数えず (DB を呼ばず) 許可する', async () => {
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });
    const marker = await signAiQuotaCounted(SERVICE_KEY, USER_ID);

    const result = await consumeEdgeAiQuota(requestWith({ [AI_QUOTA_COUNTED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });

    expect(result).toEqual({ allowed: true, remaining: null, skipped: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Next.js が付ける印 (aiQuotaCountedHeaders) をそのまま受け付ける (署名の作り方と検証が合っている)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });

    const headers = await aiQuotaCountedHeaders(USER_ID);
    const result = await consumeEdgeAiQuota(requestWith(headers), USER_ID, 'photo_analysis', { client });

    expect(result.skipped).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらの鍵で署名された印も受け付ける', async () => {
    env.SERVICE_ROLE_JWT = JWT_KEY;
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });

    for (const key of [JWT_KEY, SERVICE_KEY]) {
      const marker = await signAiQuotaCounted(key, USER_ID);
      const result = await consumeEdgeAiQuota(requestWith({ [AI_QUOTA_COUNTED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });
      expect(result.skipped, key).toBe(true);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('偽の印は数える: 別のユーザーの印・別の鍵の印・古い印・でたらめな値・クライアントが自分で付けた値', async () => {
    const now = Date.now();
    const forged = [
      await signAiQuotaCounted(SERVICE_KEY, OTHER_USER_ID, now), // 別のユーザー用
      await signAiQuotaCounted('attacker-guess', USER_ID, now), // 鍵を知らない者の署名
      await signAiQuotaCounted(SERVICE_KEY, USER_ID, now - 6 * 60 * 1000), // 5 分より古い (使い回し)
      await signAiQuotaCounted(SERVICE_KEY, USER_ID, now + 5 * 60 * 1000), // 未来すぎる
      'v1.1.' + '0'.repeat(64),
      'true',
      '1',
    ];

    for (const value of forged) {
      const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });
      const result = await consumeEdgeAiQuota(requestWith({ [AI_QUOTA_COUNTED_HEADER]: value }), USER_ID, 'photo_analysis', { client });
      expect(result.skipped, value).toBeUndefined();
      expect(rpc, value).toHaveBeenCalledTimes(1);
    }
  });

  it('service role の鍵が Edge 側に無ければ、印は検証できないので数える', async () => {
    env = { SUPABASE_URL: 'https://example.supabase.co' };
    const { rpc, client } = clientReturning({ data: { allowed: true, remaining: null }, error: null });
    const marker = await signAiQuotaCounted(SERVICE_KEY, USER_ID);

    await consumeEdgeAiQuota(requestWith({ [AI_QUOTA_COUNTED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('consumeEdgeAiQuota: 失敗しても止めない (fail-open)', () => {
  it('DB のエラーでも、例外を投げず許可して、ユーザー ID と機能つきでログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    const result = await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation', { client });

    expect(result).toEqual({ allowed: true, remaining: null });
    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('許可');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'consultation' });
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さずに許可する', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(consumeEdgeAiQuota(requestWith(), USER_ID, 'photo_analysis', { client })).resolves.toEqual({
      allowed: true,
      remaining: null,
    });
  });

  it('rpc の例外・想定外の応答・クライアントを作れない (環境変数が無い) 場合も許可する', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as QuotaRpcClient;
    expect(await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation', { client: syncThrow })).toEqual({ allowed: true, remaining: null });

    const garbage = clientReturning({ data: { allowed: 'maybe' }, error: null }).client;
    expect(await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation', { client: garbage })).toEqual({ allowed: true, remaining: null });

    mocks.createClient.mockImplementation(() => {
      throw new Error('supabaseUrl is required.');
    });
    env = {};
    expect(await consumeEdgeAiQuota(requestWith(), USER_ID, 'consultation')).toEqual({ allowed: true, remaining: null });

    expect(mocks.loggerError).toHaveBeenCalledTimes(3);
  });

  it('応答が遅いときは、待ち続けずに許可して先へ進む', async () => {
    const { client } = clientReturning(() => new Promise<RpcResult>(() => {}));

    const startedAt = Date.now();
    const result = await consumeEdgeAiQuota(requestWith(), USER_ID, 'photo_analysis', { client, timeoutMs: 30 });

    expect(result).toEqual({ allowed: true, remaining: null });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('timed out');
  });
});

describe('aiQuotaExceededResponse (Edge): 上限を超えたときの 429', () => {
  it('429・JSON の本文 (code=AI_DAILY_LIMIT)・CORS ヘッダー・Retry-After', async () => {
    const response = aiQuotaExceededResponse(
      { allowed: false, remaining: 0, limitKind: 'daily', limit: 5, resetAt: new Date(Date.now() + 90_000).toISOString() },
      { 'Access-Control-Allow-Origin': 'https://homegohan.app' },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://homegohan.app');
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ code: 'AI_DAILY_LIMIT', limit: 5 });
  });

  it('月次は AI_MONTHLY_LIMIT。戻る時刻が無ければ Retry-After は付けない', async () => {
    const response = aiQuotaExceededResponse({ allowed: false, remaining: 0, limitKind: 'monthly' });

    expect(response.headers.get('Retry-After')).toBeNull();
    expect((await response.json()).code).toBe('AI_MONTHLY_LIMIT');
  });
});
