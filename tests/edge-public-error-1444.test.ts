// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * #1444 (CodeQL js/stack-trace-exposure) の回帰テスト。
 *
 * generate-menu-v4 / generate-menu-v5 は利用者の JWT で直接呼べる。catch した例外の文を本文にそのまま返すと、
 * DB・上流の AI の API・内部の処理の文が呼び出した人に見える。本文に出すのは入力の誤りの文 (PublicRequestError) と
 * 固定の文 (MissingEnvError) だけにし、それ以外は固定の文 (INTERNAL_ERROR_PUBLIC_MESSAGE) にする。
 *
 *   1. 部品 (supabase/functions/_shared/public-error.ts): どの例外のときに、どの文を返すか
 *   2. 実際のハンドラ: 内部の例外の文を本文に出さない (状態コードは以前のまま)・入力の誤りの文は返す
 *
 * 差し替えるのは外との境目だけ (tests/ai-usage-direct-jwt-edge.test.ts と同じ): Supabase のクライアント・認証・ログ・
 * 数える関数 (consumeEdgeAiUsage。ここで内部の例外を投げさせる)・EdgeRuntime.waitUntil・fetch。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONSENT_PROVIDERS, AI_CONSENT_TABLE, AI_CONSENT_VERSION } from '../supabase/functions/_shared/ai-consent';
import { MissingEnvError, MISSING_ENV_ERROR_MESSAGE } from '../supabase/functions/_shared/missing-env';
import {
  INTERNAL_ERROR_PUBLIC_MESSAGE,
  PublicRequestError,
  publicErrorMessage,
} from '../supabase/functions/_shared/public-error';
import { DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS } from './helpers/heavy-unit-test-timeout';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const USER_TOKEN = 'user-jwt-token';
const SERVICE_ROLE_KEY = 'service-role-key';
/** 数える関数が投げる例外の文 (内部の情報の代わり。本文に出たら漏れている) */
const INTERNAL_DETAIL = 'relation "ai_usage_daily" does not exist (db host 10.0.0.12) #1444';

const e = vi.hoisted(() => ({
  consume: vi.fn(),
  waitUntil: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Supabase のクエリの作り物。同意の表は同意済み、リクエストの表は本人の行を返す */
function fakeQuery(table: string): unknown {
  const listResult = () =>
    table === AI_CONSENT_TABLE
      ? { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null }
      : { data: [], error: null };
  const ownRow = table === 'weekly_menu_requests' ? { id: REQUEST_ID, user_id: USER, current_step: 1 } : null;
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(listResult()).then(res, rej);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: ownRow, error: null });
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: () => ({
    auth: {
      getUser: async (token?: string) =>
        token === USER_TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: 'invalid token' } },
    },
    from: (table: string) => fakeQuery(table),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('../supabase/functions/_shared/db-logger.ts', () => ({
  createLogger: () => ({ ...e.logger, withUser: () => e.logger }),
  generateRequestId: () => 'req_test',
}));
vi.mock('../supabase/functions/_shared/ai-usage.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/functions/_shared/ai-usage.ts')>()),
  consumeEdgeAiUsage: e.consume,
}));

type Handler = (req: Request) => Promise<Response>;
const handlers: Record<string, Handler> = {};

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: 'anon-key',
  XAI_API_KEY: 'test-xai-key',
  OPENAI_API_KEY: 'test-openai-key',
};

interface HandlerCase {
  name: 'generate-menu-v4' | 'generate-menu-v5';
  load: () => Promise<unknown>;
  /** 内部の例外のときの状態コード (以前と同じ。呼び出し元の再試行の判定を変えない) */
  internalStatus: number;
}

const CASES: HandlerCase[] = [
  { name: 'generate-menu-v4', load: () => import('../supabase/functions/generate-menu-v4/index.ts'), internalStatus: 400 },
  { name: 'generate-menu-v5', load: () => import('../supabase/functions/generate-menu-v5/index.ts'), internalStatus: 500 },
];

const request = (name: string, body: Record<string, unknown>, token: string) =>
  new Request(`http://localhost/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  for (const c of CASES) {
    vi.stubGlobal('Deno', {
      serve: (fn: Handler) => {
        handlers[c.name] = fn;
      },
      env: { get: (key: string) => ENV[key] },
    });
    await c.load();
  }
  vi.stubGlobal('Deno', { serve: () => undefined, env: { get: (key: string) => ENV[key] } });
  vi.stubGlobal('EdgeRuntime', { waitUntil: e.waitUntil });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
  // 大きい Edge Function を 2 本 import するので、フックの時間切れだけを、同じ 2 本を読む tests/ai-usage-direct-jwt-edge.test.ts
  // (一覧 HEAVY_UNIT_TEST_FILES にある) のフックと同じにする。テストの時間切れは既定のまま (どれも import のあとの処理だけ)
}, DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  e.consume.mockReset();
  e.waitUntil.mockClear();
  e.logger.error.mockClear();
});

describe('publicErrorMessage (supabase/functions/_shared/public-error.ts)', () => {
  it('入力の誤り (PublicRequestError) と、固定の文の MissingEnvError は、その文を返す', () => {
    expect(publicErrorMessage(new PublicRequestError('request_id is required'))).toBe('request_id is required');
    expect(publicErrorMessage(new MissingEnvError(['SUPABASE_URL']))).toBe(MISSING_ENV_ERROR_MESSAGE);
  });

  it.each([
    ['ふつうの Error', new Error(INTERNAL_DETAIL)],
    ['Error の子のクラス', new TypeError(INTERNAL_DETAIL)],
    ['文字列', INTERNAL_DETAIL],
    ['message を持つただのオブジェクト (supabase-js のエラーなど)', { message: INTERNAL_DETAIL, code: '42P01' }],
    ['名前だけ PublicRequestError に似せた Error', Object.assign(new Error(INTERNAL_DETAIL), { name: 'PublicRequestError' })],
    ['null', null],
  ])('%s は固定の文にする', (_label, error) => {
    expect(publicErrorMessage(error)).toBe(INTERNAL_ERROR_PUBLIC_MESSAGE);
  });
});

describe.each(CASES)('$name (実際のハンドラ): 内部の例外の文を本文に出さない', (c) => {
  it('内部の例外: 以前と同じ状態コードで、固定の文だけを返す (例外の文は返さない・ログには残す)', async () => {
    e.consume.mockRejectedValue(new Error(INTERNAL_DETAIL));

    const res = await handlers[c.name](request(c.name, { requestId: REQUEST_ID, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] }, USER_TOKEN));

    // 数える関数まで届いている (ここで投げた例外が catch に届いた。前で止まると確かめが空振りになる)
    expect(e.consume).toHaveBeenCalledTimes(1);
    expect(e.waitUntil).not.toHaveBeenCalled();
    expect(res.status).toBe(c.internalStatus);
    const text = await res.text();
    expect(text).not.toContain(INTERNAL_DETAIL);
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_PUBLIC_MESSAGE });
    const logged = [...vi.mocked(console.error).mock.calls, ...e.logger.error.mock.calls].flat();
    expect(logged.some((arg) => arg instanceof Error && arg.message === INTERNAL_DETAIL)).toBe(true);
  });

  it('入力の誤り (request_id が無い): その文を返す', async () => {
    const res = await handlers[c.name](request(c.name, { targetSlots: [] }, USER_TOKEN));

    expect(res.status).toBe(c.internalStatus);
    expect(await res.json()).toEqual({ error: 'request_id is required' });
    expect(e.consume).not.toHaveBeenCalled();
  });
});
