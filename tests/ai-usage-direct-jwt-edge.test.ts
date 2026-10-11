// @vitest-environment node
//
// Edge Function の本体を読み込むので node 環境で動かす (jsdom では Edge Runtime の型宣言の import を空のモジュールに差し替えられない)
/**
 * #1177 の宿題 / #1149 (T40): generate-menu-v4 / generate-menu-v5 / regenerate-shopping-list-v2 を、ユーザー自身の JWT で
 * 直接呼んだとき (Next.js を経由しない経路) の、同意の判定 → 上限の判定と記録 → 生成の開始 の順番を、実際のハンドラを動かして確かめる。
 *
 * この 3 本は、service role の経路 (Next.js の API ルート・cron・続きの工程) と合流してから同意を判定し、
 * そのあとの `if (directJwtUserId)` の中で数える (consumeEdgeAiUsage)。構文木の検査 (tests/ai-consent-enforcement-edge.test.ts) は
 * 「止める if が送る呼び出しより前にある」までしか見ないので、ここでは呼ばれた順番で見る。
 *
 *   1. 同意済み・上限の内: 同意の判定 (external_data_consents を読む) → consumeEdgeAiUsage (JWT の利用者・一覧の機能名) →
 *      生成の開始 (EdgeRuntime.waitUntil に渡す。ここから AI へ送る) の順。AI 事業者への fetch も、数えたあと
 *   2. 同意済み・上限に達している: 生成を始めずに 429 AI_DAILY_LIMIT。リクエストの行を失敗にし、画面がそのまま出す人向けの文を書く
 *   3. 未同意: 403。数えない・生成を始めない
 *   4. service role の経路 (Next.js が数え済み): 数えない (二重に数えない)。生成は始める
 *
 * 差し替えるのは外との境目だけ: Supabase のクライアント・認証・ログ・数える関数 (consumeEdgeAiUsage。DB を呼ぶ境目)・
 * EdgeRuntime.waitUntil・fetch。同意の判定 (_shared/ai-consent-guard.ts) と止めたときの応答は本物。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_TABLE,
  AI_CONSENT_VERSION,
} from '../supabase/functions/_shared/ai-consent';
import { aiDailyLimitMessage, type AiUsageResult } from '../supabase/functions/_shared/ai-daily-limit';
import { ENFORCED_EDGE } from './helpers/ai-consent-enforced-paths';
import { AI_USAGE_ALLOWED, AI_USAGE_DENIED } from './helpers/ai-usage-mock';

// Edge Runtime の型宣言だけの import (node_modules に無い)。中身は無いので空のモジュールにする
vi.mock('@supabase/functions-js/edge-runtime.d.ts', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const USER_TOKEN = 'user-jwt-token';
const SERVICE_ROLE_KEY = 'service-role-key';

const e = vi.hoisted(() => {
  const e = {
  consentGranted: true,
  /** 同意の表を読んだ印 (同意の判定の順番を見る) */
  consentRead: vi.fn((_table: string) => undefined),
  /** 数える関数 (DB を呼ぶ境目) */
  consume: vi.fn(),
  /** 生成の開始 (EdgeRuntime.waitUntil。ここから AI へ送る)。渡された処理は、テストの終わりに終わるまで待つ */
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    e.background.push(Promise.resolve(promise).catch(() => undefined));
  }),
  /** 生成の処理 (前のテストの処理が、次のテストの記録に混ざらないように、テストごとに終わるまで待つ) */
  background: [] as Array<Promise<unknown>>,
  /** AI 事業者への fetch */
  aiFetch: vi.fn((_url: string) => undefined),
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return e;
});

/** Supabase のクエリの作り物。同意の表は同意の状況、リクエストの表は本人の行を返す。update の値を記録する */
function fakeQuery(table: string): unknown {
  const listResult = () => {
    if (table !== AI_CONSENT_TABLE) return { data: [], error: null };
    e.consentRead(table);
    return e.consentGranted
      ? { data: AI_CONSENT_PROVIDERS.map((provider) => ({ provider, consented: true, policy_version: AI_CONSENT_VERSION })), error: null }
      : { data: [], error: null };
  };
  const ownRow = table === 'weekly_menu_requests' || table === 'shopping_list_requests' ? { id: REQUEST_ID, user_id: USER, current_step: 1 } : null;
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (err: unknown) => unknown) => Promise.resolve(listResult()).then(res, rej);
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: ownRow, error: null });
        if (prop === 'update') {
          return (values: Record<string, unknown>) => {
            e.updates.push({ table, values });
            return builder;
          };
        }
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
vi.mock('../supabase/functions/_shared/auth.ts', () => ({
  requireAuth: vi.fn(async (req: Request) =>
    req.headers.get('Authorization') === `Bearer ${USER_TOKEN}`
      ? { userId: USER }
      : new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  ),
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

/** AI 事業者の宛先 (global fetch で数える) */
const AI_URL_PATTERN = /api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|api\.perplexity\.ai|api\.aimlapi\.com/;

interface DirectCase {
  name: 'generate-menu-v4' | 'generate-menu-v5' | 'regenerate-shopping-list-v2';
  load: () => Promise<unknown>;
  body: Record<string, unknown>;
  /** 止めたときにリクエストの行へ書く表と、失敗の欄 */
  table: string;
  stored: (values: Record<string, unknown>) => unknown;
}

const CASES: DirectCase[] = [
  {
    name: 'generate-menu-v4',
    load: () => import('../supabase/functions/generate-menu-v4/index.ts'),
    body: { requestId: REQUEST_ID, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    table: 'weekly_menu_requests',
    stored: (values) => values.error_message,
  },
  {
    name: 'generate-menu-v5',
    load: () => import('../supabase/functions/generate-menu-v5/index.ts'),
    body: { requestId: REQUEST_ID, targetSlots: [{ date: '2026-10-10', mealType: 'dinner' }] },
    table: 'weekly_menu_requests',
    stored: (values) => values.error_message,
  },
  {
    name: 'regenerate-shopping-list-v2',
    load: () => import('../supabase/functions/regenerate-shopping-list-v2/index.ts'),
    body: { requestId: REQUEST_ID, startDate: '2026-10-10', endDate: '2026-10-11' },
    table: 'shopping_list_requests',
    stored: (values) => (values.result as { error?: unknown } | undefined)?.error,
  },
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
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (AI_URL_PATTERN.test(url)) e.aiFetch(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(async () => {
  await Promise.allSettled(e.background.splice(0));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  e.consentGranted = true;
  e.updates = [];
  for (const fn of [e.consentRead, e.consume, e.waitUntil, e.aiFetch]) fn.mockClear();
  e.consume.mockResolvedValue(AI_USAGE_ALLOWED satisfies AiUsageResult);
});

const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

describe.each(CASES)('$name: ユーザーの JWT で直接呼んだとき', (c) => {
  const feature = () => {
    const usage = ENFORCED_EDGE[c.name].usage;
    return 'record' in usage ? usage.record[0] : null;
  };

  it('同意済み・上限の内: 同意の判定 → 数える (JWT の利用者・一覧の機能名) → 生成の開始 の順。AI へ送るのも数えたあと', async () => {
    const res = await handlers[c.name](request(c.name, c.body, USER_TOKEN));

    expect([200, 202]).toContain(res.status);
    expect(e.consume).toHaveBeenCalledTimes(1);
    const [req, userId, consumed] = e.consume.mock.calls[0];
    expect(req).toBeInstanceOf(Request);
    expect(userId).toBe(USER);
    expect(consumed).toBe(feature());
    // 順番 (呼ばれた順)
    expect(e.consentRead, '同意の判定をしていない').toHaveBeenCalled();
    expect(e.waitUntil, '生成を始めていない (順番の確かめが空振りになる)').toHaveBeenCalledTimes(1);
    expect(order(e.consentRead)).toBeLessThan(order(e.consume));
    expect(order(e.consume)).toBeLessThan(order(e.waitUntil));
    for (const sent of e.aiFetch.mock.invocationCallOrder) expect(sent).toBeGreaterThan(order(e.consume));
  });

  it('同意済み・上限に達している: 生成を始めずに 429 AI_DAILY_LIMIT。リクエストの行を失敗にし、人向けの文を書く', async () => {
    e.consume.mockResolvedValue(AI_USAGE_DENIED);

    const res = await handlers[c.name](request(c.name, c.body, USER_TOKEN));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'AI_DAILY_LIMIT', limit: AI_USAGE_DENIED.limit });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(e.waitUntil).not.toHaveBeenCalled();
    expect(e.aiFetch).not.toHaveBeenCalled();
    const failed = e.updates.filter((u) => u.table === c.table && u.values.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(c.stored(failed[0].values)).toBe(aiDailyLimitMessage(AI_USAGE_DENIED.limit));
    // 画面がそのまま出す欄に、英字のコードを書かない
    expect(JSON.stringify(failed[0].values)).not.toContain('AI_DAILY_LIMIT');
  });

  it('未同意: 403。数えず、生成も始めない (同意の判定 → 数える の順)', async () => {
    e.consentGranted = false;

    const res = await handlers[c.name](request(c.name, c.body, USER_TOKEN));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: AI_CONSENT_REQUIRED_CODE });
    expect(e.consume).not.toHaveBeenCalled();
    expect(e.waitUntil).not.toHaveBeenCalled();
  });

  it('service role の経路 (Next.js の API ルートが数え済み): 数えない (二重に数えない)。生成は始める', async () => {
    const res = await handlers[c.name](request(c.name, { ...c.body, userId: USER }, SERVICE_ROLE_KEY));

    expect([200, 202]).toContain(res.status);
    expect(e.consume).not.toHaveBeenCalled();
    expect(e.waitUntil).toHaveBeenCalledTimes(1);
  });
});
