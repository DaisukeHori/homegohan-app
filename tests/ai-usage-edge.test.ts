/**
 * #1177 (T26) Edge Functions の AI 利用回数の記録 (supabase/functions/_shared/ai-usage.ts) の単体テスト
 *
 * Edge Function は、ユーザー自身の JWT で直接呼ばれたとき (Next.js を経由しないとき) だけ記録する。
 *   - service role の経路では呼ばない (呼び出し側の contract は tests/ai-usage-contract.test.ts)
 *   - Next.js が記録済みの呼び出し (署名つきの印 x-hg-ai-usage-recorded) は、記録しない
 *   - 失敗しても (DB エラー・応答が遅い)、ログに残して戻る (止めない)
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
import { recordEdgeAiUsage, type AiUsageRpcClient } from '../supabase/functions/_shared/ai-usage.ts';
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

const OK: RpcResult = { data: null, error: null };

describe('recordEdgeAiUsage: ユーザーの JWT で直接呼ばれたときに記録する', () => {
  it('record_ai_usage を、ユーザー ID と機能名で 1 回呼ぶ。戻り値は無い', async () => {
    const { rpc, client } = clientReturning(OK);

    await expect(recordEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('record_ai_usage', { p_user_id: USER_ID, p_feature: 'photo_analysis' });
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('既定のクライアントは service role key で作る (セッションは持たない)。SERVICE_ROLE_JWT があれば優先する', async () => {
    const { rpc } = clientReturning(OK);
    mocks.createClient.mockReturnValue({ rpc });

    await recordEdgeAiUsage(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    env.SERVICE_ROLE_JWT = JWT_KEY;
    await recordEdgeAiUsage(requestWith(), USER_ID, 'consultation');
    expect(mocks.createClient).toHaveBeenLastCalledWith('https://example.supabase.co', JWT_KEY, expect.anything());
  });

  it('上限と比べて止める部品 (429 の応答) は公開しない (止める処理は #1149 / T40 が足す)', () => {
    expect(Object.keys(edgeUsage).sort()).toEqual(['AI_FEATURES', 'AI_USAGE_RECORDED_HEADER', 'recordEdgeAiUsage'].sort());
  });
});

describe('recordEdgeAiUsage: Next.js が記録済みの呼び出しは記録しない', () => {
  it('署名つきの印 (有効・同じユーザー) があれば、記録しない (DB を呼ばない)', async () => {
    const { rpc, client } = clientReturning(OK);
    const marker = await signAiUsageRecorded(SERVICE_KEY, USER_ID);

    await recordEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('Next.js が付ける印 (aiUsageRecordedHeaders) をそのまま受け付ける (署名の作り方と検証が合っている)', async () => {
    vi.stubEnv('SERVICE_ROLE_JWT', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
    const { rpc, client } = clientReturning(OK);

    const headers = await aiUsageRecordedHeaders(USER_ID);
    expect(Object.keys(headers)).toEqual([AI_USAGE_RECORDED_HEADER]);
    await recordEdgeAiUsage(requestWith(headers), USER_ID, 'photo_analysis', { client });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらの鍵で署名された印も受け付ける', async () => {
    env.SERVICE_ROLE_JWT = JWT_KEY;
    const { rpc, client } = clientReturning(OK);

    for (const key of [JWT_KEY, SERVICE_KEY]) {
      const marker = await signAiUsageRecorded(key, USER_ID);
      await recordEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });
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
      await recordEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: value }), USER_ID, 'photo_analysis', { client });
      expect(rpc, value).toHaveBeenCalledTimes(1);
    }
  });

  it('service role の鍵が Edge 側に無ければ、印は検証できないので記録する', async () => {
    env = { SUPABASE_URL: 'https://example.supabase.co' };
    const { rpc, client } = clientReturning(OK);
    const marker = await signAiUsageRecorded(SERVICE_KEY, USER_ID);

    await recordEdgeAiUsage(requestWith({ [AI_USAGE_RECORDED_HEADER]: marker }), USER_ID, 'photo_analysis', { client });

    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('recordEdgeAiUsage: 失敗しても止めない', () => {
  it('DB のエラーでも、例外を投げず、ユーザー ID と機能つきでログに残す', async () => {
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

    await expect(recordEdgeAiUsage(requestWith(), USER_ID, 'consultation', { client })).resolves.toBeUndefined();

    expect(mocks.withUser).toHaveBeenCalledWith(USER_ID);
    const [message, error, metadata] = mocks.loggerError.mock.calls[0];
    expect(message).toContain('記録に失敗');
    expect((error as Error).message).toContain('PGRST202');
    expect(metadata).toEqual({ feature: 'consultation' });
  });

  it('ログの保存自体が失敗しても (ロガーが例外を投げても)、例外を出さない', async () => {
    mocks.withUser.mockImplementation(() => {
      throw new Error('logger is broken');
    });
    const { client } = clientReturning({ data: null, error: { code: 'PGRST202', message: 'boom' } });

    await expect(recordEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client })).resolves.toBeUndefined();
  });

  it('rpc の例外・クライアントを作れない (環境変数が無い) 場合も、例外を出さない', async () => {
    const syncThrow = { rpc: vi.fn(() => { throw new Error('boom'); }) } as unknown as AiUsageRpcClient;
    await expect(recordEdgeAiUsage(requestWith(), USER_ID, 'consultation', { client: syncThrow })).resolves.toBeUndefined();

    mocks.createClient.mockImplementation(() => {
      throw new Error('supabaseUrl is required.');
    });
    env = {};
    await expect(recordEdgeAiUsage(requestWith(), USER_ID, 'consultation')).resolves.toBeUndefined();

    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });

  it('応答が遅いときは、待ち続けずに先へ進む', async () => {
    const { client } = clientReturning(() => new Promise<RpcResult>(() => {}));
    const TIMEOUT_FOR_TEST_MS = 30;

    const startedAt = Date.now();
    await recordEdgeAiUsage(requestWith(), USER_ID, 'photo_analysis', { client, timeoutMs: TIMEOUT_FOR_TEST_MS });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect((mocks.loggerError.mock.calls[0][1] as Error).message).toContain('timed out');
  });
});
