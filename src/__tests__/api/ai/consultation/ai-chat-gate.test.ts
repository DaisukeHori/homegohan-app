// @vitest-environment node
/**
 * src/__tests__/api/ai/consultation/ai-chat-gate.test.ts
 *
 * #1148 AI 相談の緊急停止スイッチ (feature_flags の ai_chat_enabled)。
 *
 * OFF のとき、AI に送る・AI が提案した操作を実行する 5 つの API は、503 とやさしい文面を返す。
 *   POST /api/ai/consultation/sessions                         新しい相談の開始
 *   POST /api/ai/consultation/sessions/[sessionId]/messages    メッセージ送信
 *   POST /api/ai/consultation/sessions/[sessionId]/summarize   要約の生成
 *   POST /api/ai/consultation/sessions/[sessionId]/close       相談の終了 (要約を含む)
 *   POST /api/ai/consultation/actions/[actionId]/execute       提案された操作の実行
 * OFF のときは、DB にも AI にも触れず、レート制限の枠も使わない。ON のときは今までどおり進む。
 * 過去の相談の閲覧 (GET)・提案の却下 (DELETE) は、AI を呼ばないので止めない。
 * 認証が先 (未ログインは、フラグが OFF でも 401)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  isFeatureEnabled: vi.fn(),
  checkRateLimit: vi.fn(),
  getFastLLMClient: vi.fn(),
  runConsultationAction: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: h.getUser },
    from: (table: string) => h.from(table),
  })),
}));

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string) => h.isFeatureEnabled(key, userId),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => h.checkRateLimit(...args),
  rateLimitExceededResponse: vi.fn(() => new Response(JSON.stringify({ code: 'RATE_LIMITED' }), { status: 429 })),
}));

vi.mock('@/lib/ai/fast-llm', () => ({
  getFastLLMClient: (...args: unknown[]) => h.getFastLLMClient(...args),
  getFastLLMModel: () => 'test-model',
}));

vi.mock('@/lib/ai/consultation-action-executor', () => ({
  runConsultationAction: (...args: unknown[]) => h.runConsultationAction(...args),
}));

import { AI_CHAT_DISABLED_MESSAGE } from '@/lib/ai/ai-chat-unavailable';

const USER = { id: 'user-1' };
const SENTINEL = 'db-was-reached';

type Handler = (request: Request, context: any) => Promise<Response>;

interface GatedRoute {
  name: string;
  load: () => Promise<Handler>;
  url: string;
  context: unknown;
  /** チャット/生成のレート制限 (generation) を使う API か */
  rateLimited: boolean;
}

const GATED: GatedRoute[] = [
  {
    name: 'POST /api/ai/consultation/sessions (新しい相談の開始)',
    load: async () => (await import('@/app/api/ai/consultation/sessions/route')).POST as Handler,
    url: 'http://localhost/api/ai/consultation/sessions',
    context: {},
    rateLimited: false,
  },
  {
    name: 'POST .../sessions/[sessionId]/messages (メッセージ送信)',
    load: async () =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST as Handler,
    url: 'http://localhost/api/ai/consultation/sessions/s1/messages',
    context: { params: { sessionId: 's1' } },
    rateLimited: true,
  },
  {
    name: 'POST .../sessions/[sessionId]/summarize (要約の生成)',
    load: async () =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/summarize/route')).POST as Handler,
    url: 'http://localhost/api/ai/consultation/sessions/s1/summarize',
    context: { params: { sessionId: 's1' } },
    rateLimited: true,
  },
  {
    name: 'POST .../sessions/[sessionId]/close (相談の終了)',
    load: async () => (await import('@/app/api/ai/consultation/sessions/[sessionId]/close/route')).POST as Handler,
    url: 'http://localhost/api/ai/consultation/sessions/s1/close',
    context: { params: { sessionId: 's1' } },
    rateLimited: true,
  },
  {
    name: 'POST .../actions/[actionId]/execute (提案された操作の実行)',
    load: async () => (await import('@/app/api/ai/consultation/actions/[actionId]/execute/route')).POST as Handler,
    url: 'http://localhost/api/ai/consultation/actions/a1/execute',
    context: { params: { actionId: 'a1' } },
    rateLimited: true,
  },
];

function post(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'こんにちは', title: 'AI相談' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  h.checkRateLimit.mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 });
  h.getFastLLMClient.mockReturnValue({});
  // DB に届いたら、目印の例外を投げる (各 route の try/catch が 500 にする)
  h.from.mockImplementation(() => {
    throw new Error(SENTINEL);
  });
});

describe.each(GATED)('$name', (route) => {
  it('ai_chat_enabled が OFF なら 503 とやさしい文面。DB にも AI にも触れず、レート制限の枠も使わない', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    const handler = await route.load();

    const res = await handler(post(route.url), route.context);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      error: AI_CHAT_DISABLED_MESSAGE,
      code: 'AI_CHAT_DISABLED',
      retryAfter: 60,
    });
    expect(h.isFeatureEnabled).toHaveBeenCalledWith('ai_chat_enabled', USER.id);
    expect(h.from).not.toHaveBeenCalled();
    expect(h.getFastLLMClient).not.toHaveBeenCalled();
    expect(h.runConsultationAction).not.toHaveBeenCalled();
    expect(h.checkRateLimit).not.toHaveBeenCalled();
  });

  it('ON なら今までどおり進む (緊急停止スイッチは、止めたときだけ効く)', async () => {
    h.isFeatureEnabled.mockResolvedValue(true);
    const handler = await route.load();

    const res = await handler(post(route.url), route.context);

    // 目印の例外 (= DB に届いた)。route によって 500 を返すものと、代わりの応答に倒すものがある。ここで見るのは「止めていない」こと
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(401);
    expect(h.from).toHaveBeenCalled();
    expect(h.from.mock.results[0]?.type).toBe('throw');
    expect(String((h.from.mock.results[0]?.value as Error | undefined)?.message ?? '')).toBe(SENTINEL);
    if (route.rateLimited) {
      expect(h.checkRateLimit).toHaveBeenCalledWith(USER.id, 'generation');
    }
  });

  it('未ログインは、フラグが OFF でも 401 (ログインの有無を先に確かめる。フラグも読まない)', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const handler = await route.load();

    const res = await handler(post(route.url), route.context);

    expect(res.status).toBe(401);
    expect(h.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('OFF のときは、レート制限に達していても 429 ではなく 503 (停止中の案内を優先する)', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    h.checkRateLimit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60_000 });
    const handler = await route.load();

    const res = await handler(post(route.url), route.context);
    expect(res.status).toBe(503);
  });
});

describe('止めないもの (AI を呼ばない API)', () => {
  /** どのメソッドを呼んでも自分自身を返し、await すると指定の結果になる */
  function chain(result: unknown): any {
    const proxy: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return () => proxy;
      },
      apply: () => proxy,
    });
    return proxy;
  }

  it('GET /api/ai/consultation/sessions (過去の相談の一覧) は、OFF でも読める', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    h.from.mockImplementation(() => chain({ data: [], error: null }));
    const { GET } = await import('@/app/api/ai/consultation/sessions/route');

    const res = await GET(new Request('http://localhost/api/ai/consultation/sessions?status=all'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
    expect(h.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('DELETE /api/ai/consultation/actions/[actionId]/execute (提案の却下) は、OFF でも使える', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    h.from.mockImplementation(() => chain({ data: null, error: { message: 'not found' } }));
    const { DELETE } = await import('@/app/api/ai/consultation/actions/[actionId]/execute/route');

    const res = await DELETE(new Request('http://localhost/api/ai/consultation/actions/a1/execute', { method: 'DELETE' }), {
      params: { actionId: 'a1' },
    });

    expect(res.status).toBe(404); // フラグではなく、対象が無いことで返っている
    expect(h.isFeatureEnabled).not.toHaveBeenCalled();
  });
});
