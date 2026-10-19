// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * #1910 AI 相談で knowledge-gpt のストリーミングが毎回失敗していた (本番の Edge Function のログで、Next.js (user agent: node)
 * からの knowledge-gpt の呼び出しがすべて 401。関数は起動しているが「Knowledge-GPT received request」の行が出ない = 認証で止まっている)。
 *
 * 原因: knowledge-gpt は service role の判定に SUPABASE_SERVICE_ROLE_KEY との一致だけを見ていた。他の Edge Function
 * (_shared/auth.ts・generate-menu-v5 など) は SERVICE_ROLE_JWT と SUPABASE_SERVICE_ROLE_KEY のどちらとの一致も許す。
 * Next.js が送る鍵 (Vercel の SUPABASE_SERVICE_ROLE_KEY) が Edge 側の SERVICE_ROLE_JWT と同じ値だと、knowledge-gpt だけが
 * 利用者の JWT として getUser に回し、401 Unauthorized を返していた (同じ鍵で呼ぶ generate-menu-v5 は 202)。
 *
 * ここでは実際のハンドラを動かして、次を確かめる:
 *   1. SERVICE_ROLE_JWT と一致する鍵: service role の経路 (getUser に回さない・数えない・スイッチと同意を見ない)。ストリーミングで本文が流れる
 *   2. SUPABASE_SERVICE_ROLE_KEY と一致する鍵: これまでどおり service role の経路
 *   3. どちらとも一致しない鍵 (SERVICE_ROLE_JWT が未設定のとき、その値を送る): 利用者の JWT として検証し、通らなければ 401 (広げすぎていない)
 *   4. 利用者の JWT: これまでどおり getUser で検証し、数える
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_TABLE, AI_CONSENT_VERSION } from '../supabase/functions/_shared/ai-consent';
import type { AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import { AI_USAGE_ALLOWED } from './helpers/ai-usage-mock';
import { resolveHeavyUnitTimeouts } from './helpers/heavy-unit-test-timeout';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

/**
 * Edge Function の本体を動的に読み込むフック (beforeAll) の時間切れ。tests/ai-chat-flag-edge.test.ts と同じ値
 * (負荷の高い機械で、Edge Function の動的 import がフックの既定の 10 秒を超えたことがある。#1488。環境変数で上書き可)
 */
const EDGE_IMPORT_HOOK_TIMEOUT_MS = resolveHeavyUnitTimeouts(process.env).hookTimeout;

const USER = '11111111-1111-4111-8111-111111111111';
/** Edge 側の SERVICE_ROLE_JWT (Next.js が送る鍵と同じ値の想定) */
const LEGACY_SERVICE_ROLE_JWT = 'legacy-service-role-jwt';
/** Edge 側の SUPABASE_SERVICE_ROLE_KEY (Supabase が関数に入れる値) */
const PLATFORM_SERVICE_ROLE_KEY = 'platform-service-role-key';
/** 利用者の JWT (getUser で検証が通る) */
const USER_TOKEN = 'user-jwt-token';
/** AI が返す本文の断片 (ストリームに流れたことを見る) */
const STREAM_CHUNK = '野菜を足しましょう';

const e = vi.hoisted(() => ({
  /** getUser に渡った Authorization ヘッダー (利用者の JWT として検証しに行った印) */
  getUserCalls: [] as string[],
  /** 読んだ表 */
  tables: [] as string[],
  fastLLMCreate: vi.fn(),
  consumeEdgeAiUsage: vi.fn(async (_req: Request, _userId: string, _feature: string): Promise<AiUsageResult> => ({
    allowed: true,
    metered: true,
    usageDate: '2026-10-11',
    limit: 10,
    used: 1,
  })),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type ReadResult = { data: unknown; error: unknown };

function grantedConsent(): ReadResult {
  return { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null };
}

function fakeQuery(table: string): unknown {
  e.tables.push(table);
  const result = (): ReadResult => (table === AI_CONSENT_TABLE ? grantedConsent() : { data: [], error: null });
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
        return () => builder;
      },
    },
  );
  return builder;
}

type ClientOptions = { global?: { headers?: Record<string, string> } };

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: (_url: string, _key: string, options?: ClientOptions) => ({
    auth: {
      // 本物と同じく、利用者の JWT のときだけ利用者が返る (service role の鍵には利用者が無いので失敗する)
      getUser: async () => {
        const authorization = options?.global?.headers?.Authorization ?? '';
        e.getUserCalls.push(authorization);
        return authorization === `Bearer ${USER_TOKEN}`
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } };
      },
    },
    from: (table: string) => fakeQuery(table),
    rpc: async () => ({ data: [], error: null }),
  }),
}));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({ ...e.logger, withUser: () => e.logger }),
  generateRequestId: () => 'req_test',
}));
vi.mock('../supabase/functions/_shared/fast-llm.ts', () => ({
  createFastLLMClient: () => ({ chat: { completions: { create: e.fastLLMCreate } } }),
  getFastLLMModel: () => 'test-model',
  getFastLLMApiKey: () => 'test-key',
  getFastLLMBaseUrl: () => 'https://api.x.ai/v1',
  getFastLLMChatCompletionsUrl: () => 'https://api.x.ai/v1/chat/completions',
  getFastLLMFetchHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('../supabase/functions/_shared/llm-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/llm-usage.ts')>()),
  withOpenAIUsageContext: async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  generateExecutionId: () => 'exec_test',
}));
vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: e.consumeEdgeAiUsage,
}));

type Handler = (req: Request) => Promise<Response>;
let handler: Handler | null = null;
// 既定で許可する自社のオリジン (supabase/functions/_shared/cors.ts の DEFAULT_ALLOWED_ORIGINS)
const ORIGIN = 'https://homegohan-app.vercel.app';

/** Edge の環境変数。テストごとに SERVICE_ROLE_JWT の有無を切り替える (ハンドラは呼ばれるたびに読む) */
const ENV: Record<string, string | undefined> = {};
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: PLATFORM_SERVICE_ROLE_KEY,
  SERVICE_ROLE_JWT: LEGACY_SERVICE_ROLE_JWT,
  SUPABASE_ANON_KEY: 'anon-key',
  XAI_API_KEY: 'test-xai-key',
  DATASET_EMBEDDING_API_KEY: 'test-embedding-key',
};

/** Next.js の AI 相談の API (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts) と同じ形のストリーミングの呼び出し */
function streamingRequest(token: string): Request {
  return new Request('http://localhost/functions/v1/knowledge-gpt', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'こんにちは' }], mode: 'chat', stream: true }),
  });
}

async function* fakeStream(): AsyncGenerator<unknown, void, unknown> {
  yield { choices: [{ delta: { content: STREAM_CHUNK } }] };
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  vi.stubGlobal('Deno', {
    serve: (fn: Handler) => {
      handler = fn;
    },
    env: { get: (key: string) => ENV[key] },
  });
  await import('../supabase/functions/knowledge-gpt/index.ts');
}, EDGE_IMPORT_HOOK_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  for (const key of Object.keys(ENV)) delete ENV[key];
  Object.assign(ENV, BASE_ENV);
  e.getUserCalls = [];
  e.tables = [];
  e.fastLLMCreate.mockReset();
  e.fastLLMCreate.mockImplementation(async () => fakeStream());
  e.consumeEdgeAiUsage.mockClear();
  e.consumeEdgeAiUsage.mockResolvedValue(AI_USAGE_ALLOWED);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('knowledge-gpt (実際のハンドラ): service role の鍵の判定 (#1910)', () => {
  it('SERVICE_ROLE_JWT と一致する鍵 (Next.js の AI 相談の API が送る鍵): 401 にせず、ストリーミングで本文を流す', async () => {
    const res = await (handler as Handler)(streamingRequest(LEGACY_SERVICE_ROLE_JWT));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain(JSON.stringify(STREAM_CHUNK));
    expect(text).toContain('data: [DONE]');
    expect(e.fastLLMCreate).toHaveBeenCalledTimes(1);
    // service role の経路: 利用者の JWT として検証しない・数えない (Next.js が数え済み)・スイッチと同意は呼び出し元が見たあと
    expect(e.getUserCalls).toEqual([]);
    expect(e.consumeEdgeAiUsage).not.toHaveBeenCalled();
    expect(e.tables).not.toContain('feature_flags');
    expect(e.tables).not.toContain(AI_CONSENT_TABLE);
  });

  it('SUPABASE_SERVICE_ROLE_KEY と一致する鍵: これまでどおり service role の経路', async () => {
    const res = await (handler as Handler)(streamingRequest(PLATFORM_SERVICE_ROLE_KEY));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(JSON.stringify(STREAM_CHUNK));
    expect(e.getUserCalls).toEqual([]);
    expect(e.consumeEdgeAiUsage).not.toHaveBeenCalled();
  });

  it('SERVICE_ROLE_JWT が未設定なら、その値を送っても service role にしない (利用者の JWT として検証し、通らなければ 401)', async () => {
    delete ENV.SERVICE_ROLE_JWT;

    const res = await (handler as Handler)(streamingRequest(LEGACY_SERVICE_ROLE_JWT));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: { message: 'Unauthorized', type: 'invalid_request_error' } });
    expect(e.getUserCalls).toEqual([`Bearer ${LEGACY_SERVICE_ROLE_JWT}`]);
    expect(e.fastLLMCreate).not.toHaveBeenCalled();
  });

  it('どちらの鍵とも一致しない値は service role にしない (401。AI へ送らない)', async () => {
    const res = await (handler as Handler)(streamingRequest('not-a-service-role-key'));

    expect(res.status).toBe(401);
    expect(e.getUserCalls).toEqual(['Bearer not-a-service-role-key']);
    expect(e.fastLLMCreate).not.toHaveBeenCalled();
    expect(e.consumeEdgeAiUsage).not.toHaveBeenCalled();
  });

  it('利用者の JWT: これまでどおり getUser で検証し、利用回数を数えてから AI へ送る', async () => {
    const res = await (handler as Handler)(streamingRequest(USER_TOKEN));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(JSON.stringify(STREAM_CHUNK));
    expect(e.getUserCalls).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(e.consumeEdgeAiUsage).toHaveBeenCalledTimes(1);
    expect(e.consumeEdgeAiUsage.mock.calls[0]?.[1]).toBe(USER);
  });
});
