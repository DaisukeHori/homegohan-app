// @vitest-environment node
/**
 * #1917 の続き (整合 1024c): レシピ・コメント・買い物リストほかの route の入力の誤りを 500 にしない回帰テスト
 *
 * 以前の欠陥:
 *   - UUID の形でない id を uuid の列に渡し、PostgREST の 22P02 の失敗が「DB の失敗は 500」に入っていた
 *     (GET /api/recipes/[id]・GET / POST /api/recipes/[id]/comments・DELETE /api/shopping-list/[id]、
 *     同じ型の DELETE /api/pantry/[id]・DELETE /api/meal-plans/meals/[id]・GET /api/admin/support/tickets/[id]/messages)
 *   - 同じ型で、helper (src/lib) の中で uuid の列に渡す route (GET・POST・PUT /api/admin/moderation/[type]/[id]・
 *     POST /api/admin/moderation/[type]/[id]/restore・POST /api/super-admin/coupons/[id]/apply は tests/coupons-apply-route.test.ts) と、
 *     いいねの route (GET・POST・DELETE /api/recipes/[id]/like。recipe_likes.recipe_id は uuid の列で、画面はレシピの名前を送ることがある)
 *   - コメント・いいねの POST で、レシピが無い (外部キー違反 23503) と 500 になっていた
 *   - `const body = await request.json()` を route 全体の try の中で読み、壊れた JSON の例外が catch の internalError に流れて
 *     500 になっていた (下の JSON_CASES の 39 の handler。POST /api/ai/hint は catch が固定のヒントを返す決まり (#1327) なので変えていない)
 *
 * 直したあとの不変条件 (docs/design/cross/04-api-conventions.md §5.2):
 *   - UUID の形でない id は DB に渡さず 404 (PUT / DELETE /api/recipes/[id] は今までどおり 403・GET /api/recipes/[id]/like は いいねの行が無いときと同じ 200 { liked: false })。
 *     UUID の形で行が無い id への応答は route ごとに今までどおり (コメントの GET は 200 の空の一覧、買い物リストと pantry の DELETE は 200 { success: true })
 *   - レシピの外部キー違反は 404。ほかの外部キー違反・DB の失敗は今までどおり 500
 *   - JSON として読めない本文・オブジェクトでない本文 (null・配列) は 400 `{ error: 'リクエストボディが不正です' }`
 *     (nested の route は `{ error: { code: 'INVALID_JSON', message } }`)
 *
 * Supabase には接続しない (createClient をモック)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';
import {
  API_FORBIDDEN_MESSAGE,
  API_INVALID_JSON_CODE,
  API_INVALID_JSON_MESSAGE,
  API_NOT_FOUND_MESSAGE,
} from '@/lib/api/error-responses';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { MEAL_NOT_FOUND_MESSAGE } from '@/lib/api/user-api-error-messages';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER_ID = '40000000-0000-4000-8000-000000000001';
const ROW_ID = '40000000-0000-4000-8000-0000000000aa';
const MESSAGE_ID = '40000000-0000-4000-8000-0000000000bb';
const NOT_UUID = 'not-a-uuid';

type QueryResult = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  /** from(table) の呼び出しの記録 (DB に触れたか) */
  fromCalls: [] as string[],
  /** rpc(name) の呼び出しの記録 */
  rpcCalls: [] as string[],
  /** テーブルごとの結果 (無いテーブルは DEFAULT_ROW の 1 行) */
  results: {} as Record<string, { data: unknown; error: unknown }>,
}));

/** 結果を決めていないテーブルが返す行 (本人の行。所有者の確認・セッションの確認を通る) */
const DEFAULT_ROW = { id: ROW_ID, user_id: USER_ID, is_important: false, importance_reason: null };

/** 名前・いいねを引くテーブル (src/lib/recipes/viewer-lookups.ts) は空の一覧 */
const LIST_TABLES = new Set(['user_profiles', 'recipe_likes']);

function resultOf(table: string): QueryResult {
  const fixed = h.results[table];
  if (fixed) return fixed;
  return LIST_TABLES.has(table) ? { data: [], error: null } : { data: DEFAULT_ROW, error: null };
}

/** PostgREST のクエリの組み立てのまね。どのメソッドも自分を返し、await・single・maybeSingle で結果を返す */
function queryBuilder(table: string): PromiseLike<QueryResult> {
  const settle = () => Promise.resolve(resultOf(table));
  const builder: PromiseLike<QueryResult> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
            settle().then(onFulfilled, onRejected);
        }
        if (prop === 'single' || prop === 'maybeSingle') return settle;
        return () => builder;
      },
    },
  ) as PromiseLike<QueryResult>;
  return builder;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
  from: (table: string) => {
    h.fromCalls.push(table);
    return queryBuilder(table);
  },
  rpc: (name: string) => {
    h.rpcCalls.push(name);
    return queryBuilder(`rpc:${name}`);
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => client,
  getSupabaseAdmin: () => client,
}));

vi.mock('@/lib/ai/ai-queue-writer', () => ({
  getAiQueueWriter: () => client,
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: vi.fn(async () => ({ id: USER_ID, roles: ['support', 'admin', 'super_admin'] })),
}));

// AI の route の前段 (同意・回数の上限・緊急停止・環境変数) は通す。本文の読み込みまで進めるため
vi.mock('@/lib/ai/consent-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consent-guard')>()),
  requireAiConsent: vi.fn(async () => null),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: 0, windowSec: 60 })),
}));
vi.mock('@/lib/ai/ai-chat-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/ai-chat-gate')>()),
  aiChatDisabledResponse: vi.fn(async () => null),
}));
vi.mock('@/lib/env-required', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env-required')>()),
  getSupabaseServiceConfig: vi.fn(() => ({ url: 'http://localhost:54321', serviceRoleKey: 'test-service-role-key' })),
}));
vi.mock('@/lib/ai/fast-llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/fast-llm')>()),
  getFastLLMClient: vi.fn(() => ({})),
  getFastLLMModel: vi.fn(() => 'test-model'),
}));

/** 壊れた JSON の本文 */
const BROKEN_JSON = '{"name": "カレー"';
/** JSON としては読めるが、オブジェクトでない本文 */
const NON_OBJECT_JSON = 'null';
/** JSON としては読めるが、配列の本文 (typeof は 'object' なので、typeof だけの検査は通してしまう。#1917 の続き) */
const ARRAY_JSON = '[{"name":"カレー"}]';

const FLAT_INVALID_JSON = { error: API_INVALID_JSON_MESSAGE };
const NESTED_INVALID_JSON = { error: { code: API_INVALID_JSON_CODE, message: API_INVALID_JSON_MESSAGE } };
const FLAT_INTERNAL = { error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE };
const FLAT_NOT_FOUND = { error: API_NOT_FOUND_MESSAGE };

const DB_FAILURE = { code: '57014', message: 'canceling statement due to statement timeout' };

function request(path: string, method: string, body?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' } }),
  });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  h.fromCalls.length = 0;
  h.rpcCalls.length = 0;
  h.results = {};
});

// ---- UUID でない id ---------------------------------------------------------

describe('GET /api/recipes/[id]', () => {
  it('UUID の形でない id は 404 (行が無い id と同じ)。DB に触れない (閲覧数の RPC も呼ばない)', async () => {
    const { GET } = await import('@/app/api/recipes/[id]/route');
    const res = await GET(request(`/api/recipes/${NOT_UUID}`, 'GET'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });

  it('UUID の id で DB が失敗したときは今までどおり 500', async () => {
    h.results.recipes = { data: null, error: DB_FAILURE };
    const { GET } = await import('@/app/api/recipes/[id]/route');
    const res = await GET(request(`/api/recipes/${ROW_ID}`, 'GET'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });
});

describe('PUT /api/recipes/[id]', () => {
  it('UUID の形でない id は今までどおり 403 (行が無い id と同じ)。DB に触れない', async () => {
    const { PUT } = await import('@/app/api/recipes/[id]/route');
    const res = await PUT(request(`/api/recipes/${NOT_UUID}`, 'PUT', '{"name":"カレー"}'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: API_FORBIDDEN_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  it('JSON として読めない本文は 400。所有者の確認より前に断り、DB に触れない', async () => {
    const { PUT } = await import('@/app/api/recipes/[id]/route');
    const res = await PUT(request(`/api/recipes/${ROW_ID}`, 'PUT', BROKEN_JSON), ctx({ id: ROW_ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(h.fromCalls).toEqual([]);
  });
});

describe('GET /api/recipes/[id]/comments', () => {
  it('UUID の形でない id は 404。DB に触れない', async () => {
    const { GET } = await import('@/app/api/recipes/[id]/comments/route');
    const res = await GET(request(`/api/recipes/${NOT_UUID}/comments`, 'GET'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('UUID の id で DB が失敗したときは今までどおり 500', async () => {
    h.results.recipe_comments = { data: null, error: DB_FAILURE };
    const { GET } = await import('@/app/api/recipes/[id]/comments/route');
    const res = await GET(request(`/api/recipes/${ROW_ID}/comments`, 'GET'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });
});

describe('POST /api/recipes/[id]/comments', () => {
  const post = async (id: string, body: string) => {
    const { POST } = await import('@/app/api/recipes/[id]/comments/route');
    return POST(request(`/api/recipes/${id}/comments`, 'POST', body), ctx({ id }));
  };

  it('UUID の形でない id は 404 (レシピが無いときと同じ)。DB に触れない', async () => {
    const res = await post(NOT_UUID, '{"content":"おいしい"}');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('JSON として読めない本文は 400。DB に触れない', async () => {
    const res = await post(ROW_ID, BROKEN_JSON);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(h.fromCalls).toEqual([]);
  });

  it('レシピが無い (recipe_id の外部キー違反 23503) ときは 404。500 にしない', async () => {
    h.results.recipe_comments = {
      data: null,
      error: {
        code: '23503',
        message: 'insert or update on table "recipe_comments" violates foreign key constraint "recipe_comments_recipe_id_fkey"',
      },
    };
    const res = await post(ROW_ID, '{"content":"おいしい"}');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
  });

  it('レシピ以外の外部キー違反 (user_id) は 404 にせず 500', async () => {
    h.results.recipe_comments = {
      data: null,
      error: {
        code: '23503',
        message: 'insert or update on table "recipe_comments" violates foreign key constraint "recipe_comments_user_id_fkey"',
      },
    };
    const res = await post(ROW_ID, '{"content":"おいしい"}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it('DB の失敗は今までどおり 500', async () => {
    h.results.recipe_comments = { data: null, error: DB_FAILURE };
    const res = await post(ROW_ID, '{"content":"おいしい"}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });
});

describe('DELETE /api/shopping-list/[id]', () => {
  it('UUID の形でない id は 404 (PATCH と同じ)。DB に触れない', async () => {
    const { DELETE } = await import('@/app/api/shopping-list/[id]/route');
    const res = await DELETE(request(`/api/shopping-list/${NOT_UUID}`, 'DELETE'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('UUID の id で DB が失敗したときは今までどおり 500。成功は今までどおり 200', async () => {
    const { DELETE } = await import('@/app/api/shopping-list/[id]/route');
    h.results.shopping_list_items = { data: null, error: DB_FAILURE };
    const failed = await DELETE(request(`/api/shopping-list/${ROW_ID}`, 'DELETE'), ctx({ id: ROW_ID }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual(FLAT_INTERNAL);

    h.results.shopping_list_items = { data: null, error: null };
    const ok = await DELETE(request(`/api/shopping-list/${ROW_ID}`, 'DELETE'), ctx({ id: ROW_ID }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true });
  });
});

describe('同じ型: DELETE /api/pantry/[id]・DELETE /api/meal-plans/meals/[id]・GET /api/admin/support/tickets/[id]/messages', () => {
  it('DELETE /api/pantry/[id] は UUID の形でない id を 404 (PATCH と同じ)。DB に触れない', async () => {
    const { DELETE } = await import('@/app/api/pantry/[id]/route');
    const res = await DELETE(request(`/api/pantry/${NOT_UUID}`, 'DELETE'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('DELETE /api/meal-plans/meals/[id] は UUID の形でない id を 404 (PATCH と同じ文)。DB に触れない', async () => {
    const { DELETE } = await import('@/app/api/meal-plans/meals/[id]/route');
    const res = await DELETE(request(`/api/meal-plans/meals/${NOT_UUID}`, 'DELETE'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MEAL_NOT_FOUND_MESSAGE });
    expect(h.fromCalls).toEqual([]);
  });

  it('GET /api/admin/support/tickets/[id]/messages は UUID の形でない id を 404 (POST と同じ)。DB に触れない', async () => {
    const { GET } = await import('@/app/api/admin/support/tickets/[id]/messages/route');
    const res = await GET(request(`/api/admin/support/tickets/${NOT_UUID}/messages`, 'GET'), ctx({ id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'チケットが見つかりません' } });
    expect(h.fromCalls).toEqual([]);
  });
});

describe('いいね: GET・POST・DELETE /api/recipes/[id]/like (recipe_likes.recipe_id は uuid の列)', () => {
  const load = () => import('@/app/api/recipes/[id]/like/route');
  const likeRequest = (id: string, method: string) => request(`/api/recipes/${encodeURIComponent(id)}/like`, method);
  /** 献立・お気に入りの画面が送るレシピの名前 (UUID の形でない id) */
  const RECIPE_NAME = '照り焼きチキン';

  it('GET は UUID の形でない id (レシピの名前) に、いいねの行が無いときと同じ 200 { liked: false }。DB に触れない', async () => {
    const { GET } = await load();
    for (const id of [NOT_UUID, RECIPE_NAME]) {
      const res = await GET(likeRequest(id, 'GET'), ctx({ id }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ liked: false });
    }
    expect(h.fromCalls).toEqual([]);
  });

  it('GET は UUID の id なら今までどおり行の有無を返す', async () => {
    const { GET } = await load();
    h.results.recipe_likes = { data: { user_id: USER_ID }, error: null };
    const liked = await GET(likeRequest(ROW_ID, 'GET'), ctx({ id: ROW_ID }));
    expect(await liked.json()).toEqual({ liked: true });
    h.results.recipe_likes = { data: null, error: null };
    const notLiked = await GET(likeRequest(ROW_ID, 'GET'), ctx({ id: ROW_ID }));
    expect(await notLiked.json()).toEqual({ liked: false });
    expect(h.fromCalls).toEqual(['recipe_likes', 'recipe_likes']);
  });

  it.each(['POST', 'DELETE'] as const)('%s は UUID の形でない id (レシピの名前) を 404 (レシピが無いときと同じ)。DB に触れない', async (method) => {
    const route = await load();
    for (const id of [NOT_UUID, RECIPE_NAME]) {
      const res = await route[method](likeRequest(id, method), ctx({ id }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    }
    expect(h.fromCalls).toEqual([]);
  });

  it('POST はレシピが無い (recipe_id の外部キー違反 23503) ときは 404。500 にしない', async () => {
    const { POST } = await load();
    h.results.recipe_likes = {
      data: null,
      error: {
        code: '23503',
        message: 'insert or update on table "recipe_likes" violates foreign key constraint "recipe_likes_recipe_id_fkey"',
      },
    };
    const res = await POST(likeRequest(ROW_ID, 'POST'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
  });

  it('POST のレシピ以外の外部キー違反 (user_id) は 404 にせず 500', async () => {
    const { POST } = await load();
    h.results.recipe_likes = {
      data: null,
      error: {
        code: '23503',
        message: 'insert or update on table "recipe_likes" violates foreign key constraint "recipe_likes_user_id_fkey"',
      },
    };
    const res = await POST(likeRequest(ROW_ID, 'POST'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it.each(['POST', 'DELETE'] as const)('%s は UUID の id で DB が失敗したときは今までどおり 500', async (method) => {
    const route = await load();
    h.results.recipe_likes = { data: null, error: DB_FAILURE };
    const res = await route[method](likeRequest(ROW_ID, method), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it.each([
    ['POST', true],
    ['DELETE', false],
  ] as const)('%s は UUID の id なら成功の応答は今までどおり', async (method, liked) => {
    const route = await load();
    h.results.recipe_likes = { data: null, error: null };
    const res = await route[method](likeRequest(ROW_ID, method), ctx({ id: ROW_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, liked, likeCount: 0 });
  });
});

describe('運営の通報: GET・POST・PUT /api/admin/moderation/[type]/[id]・POST .../restore (通報の id は uuid の列)', () => {
  const MODERATION_NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'モデレーションアイテムが見つかりません' } };
  const MODERATION_INTERNAL = { error: { code: 'INTERNAL_ERROR', message: '内部エラーが発生しました' } };
  const path = (type: string, id: string) => `/api/admin/moderation/${type}/${id}`;

  it.each(['food', 'recipe'])('GET (%s) は UUID の形でない id を 404 (通報が無いときと同じ)。DB に触れない', async (type) => {
    const { GET } = await import('@/app/api/admin/moderation/[type]/[id]/route');
    const res = await GET(request(path(type, NOT_UUID), 'GET'), ctx({ type, id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(MODERATION_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it.each(['POST', 'PUT'] as const)('%s は UUID の形でない id を 404 (通報が無いときと同じ)。DB に触れない', async (method) => {
    const route = await import('@/app/api/admin/moderation/[type]/[id]/route');
    const res = await route[method](request(path('food', NOT_UUID), method, '{"action":"approve"}'), ctx({ type: 'food', id: NOT_UUID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(MODERATION_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('restore の POST は UUID の形でない id を 404 (通報が無いときと同じ)。DB に触れない', async () => {
    const { POST } = await import('@/app/api/admin/moderation/[type]/[id]/restore/route');
    const res = await POST(
      request(`${path('recipe', NOT_UUID)}/restore`, 'POST', '{"restore_note":"誤って隠したため戻す"}'),
      ctx({ type: 'recipe', id: NOT_UUID }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(MODERATION_NOT_FOUND);
    expect(h.fromCalls).toEqual([]);
  });

  it('UUID の id で通報の読み込みが失敗したときは今までどおり 500 (GET・POST・restore)', async () => {
    h.results.moderation_flags = { data: null, error: DB_FAILURE };
    const moderation = await import('@/app/api/admin/moderation/[type]/[id]/route');
    const restore = await import('@/app/api/admin/moderation/[type]/[id]/restore/route');
    const params = ctx({ type: 'food', id: ROW_ID });
    const responses = [
      await moderation.GET(request(path('food', ROW_ID), 'GET'), params),
      await moderation.POST(request(path('food', ROW_ID), 'POST', '{"action":"approve"}'), params),
      await restore.POST(request(`${path('food', ROW_ID)}/restore`, 'POST', '{"restore_note":"誤って隠したため戻す"}'), params),
    ];
    for (const res of responses) {
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(MODERATION_INTERNAL);
    }
    expect(h.fromCalls).toEqual(['moderation_flags', 'moderation_flags', 'moderation_flags']);
  });
});

// ---- JSON として読めない本文 ------------------------------------------------------

type JsonCase = { name: string; nested?: boolean; call: (body: string) => Promise<Response> };

const idCtx = ctx({ id: ROW_ID });

const JSON_CASES: JsonCase[] = [
  { name: 'POST /api/ai/analyze-fridge', call: async (b) => (await import('@/app/api/ai/analyze-fridge/route')).POST(request('/api/ai/analyze-fridge', 'POST', b)) },
  { name: 'POST /api/ai/analyze-health-checkup', call: async (b) => (await import('@/app/api/ai/analyze-health-checkup/route')).POST(request('/api/ai/analyze-health-checkup', 'POST', b)) },
  { name: 'POST /api/ai/analyze-meal-photo', call: async (b) => (await import('@/app/api/ai/analyze-meal-photo/route')).POST(request('/api/ai/analyze-meal-photo', 'POST', b)) },
  { name: 'POST /api/ai/analyze-weight-scale', call: async (b) => (await import('@/app/api/ai/analyze-weight-scale/route')).POST(request('/api/ai/analyze-weight-scale', 'POST', b)) },
  { name: 'POST /api/ai/classify-photo', call: async (b) => (await import('@/app/api/ai/classify-photo/route')).POST(request('/api/ai/classify-photo', 'POST', b)) },
  {
    name: 'POST /api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important',
    call: async (b) =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important/route')).POST(
        request(`/api/ai/consultation/sessions/${ROW_ID}/messages/${MESSAGE_ID}/important`, 'POST', b),
        ctx({ sessionId: ROW_ID, messageId: MESSAGE_ID }),
      ),
  },
  {
    name: 'POST /api/ai/consultation/sessions/[sessionId]/messages',
    call: async (b) =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).POST(
        request(`/api/ai/consultation/sessions/${ROW_ID}/messages`, 'POST', b),
        ctx({ sessionId: ROW_ID }),
      ),
  },
  { name: 'POST /api/ai/consultation/sessions', call: async (b) => (await import('@/app/api/ai/consultation/sessions/route')).POST(request('/api/ai/consultation/sessions', 'POST', b)) },
  { name: 'POST /api/ai/image/generate', call: async (b) => (await import('@/app/api/ai/image/generate/route')).POST(request('/api/ai/image/generate', 'POST', b)) },
  { name: 'POST /api/ai/menu/day/regenerate', call: async (b) => (await import('@/app/api/ai/menu/day/regenerate/route')).POST(request('/api/ai/menu/day/regenerate', 'POST', b)) },
  { name: 'POST /api/ai/menu/meal/generate', call: async (b) => (await import('@/app/api/ai/menu/meal/generate/route')).POST(request('/api/ai/menu/meal/generate', 'POST', b)) },
  { name: 'POST /api/ai/menu/meal/regenerate', call: async (b) => (await import('@/app/api/ai/menu/meal/regenerate/route')).POST(request('/api/ai/menu/meal/regenerate', 'POST', b)) },
  { name: 'POST /api/ai/nutrition-analysis', call: async (b) => (await import('@/app/api/ai/nutrition-analysis/route')).POST(request('/api/ai/nutrition-analysis', 'POST', b)) },
  { name: 'POST /api/ai/nutrition/feedback', call: async (b) => (await import('@/app/api/ai/nutrition/feedback/route')).POST(request('/api/ai/nutrition/feedback', 'POST', b)) },
  { name: 'POST /api/ai/nutrition', call: async (b) => (await import('@/app/api/ai/nutrition/route')).POST(request('/api/ai/nutrition', 'POST', b)) },
  { name: 'POST /api/contact', call: async (b) => (await import('@/app/api/contact/route')).POST(request('/api/contact', 'POST', b)) },
  { name: 'POST /api/log', call: async (b) => (await import('@/app/api/log/route')).POST(request('/api/log', 'POST', b)) },
  { name: 'POST /api/meal-plans/add-from-photo', call: async (b) => (await import('@/app/api/meal-plans/add-from-photo/route')).POST(request('/api/meal-plans/add-from-photo', 'POST', b)) },
  { name: 'PATCH /api/meal-plans/meals/[id]', call: async (b) => (await import('@/app/api/meal-plans/meals/[id]/route')).PATCH(request(`/api/meal-plans/meals/${ROW_ID}`, 'PATCH', b), idCtx) },
  { name: 'POST /api/meal-plans/meals/reorder', call: async (b) => (await import('@/app/api/meal-plans/meals/reorder/route')).POST(request('/api/meal-plans/meals/reorder', 'POST', b)) },
  { name: 'POST /api/meal-plans/meals', call: async (b) => (await import('@/app/api/meal-plans/meals/route')).POST(request('/api/meal-plans/meals', 'POST', b)) },
  { name: 'PATCH /api/meals/[id]', call: async (b) => (await import('@/app/api/meals/[id]/route')).PATCH(request(`/api/meals/${ROW_ID}`, 'PATCH', b), idCtx) },
  { name: 'POST /api/meals', call: async (b) => (await import('@/app/api/meals/route')).POST(request('/api/meals', 'POST', b)) },
  { name: 'POST /api/menu-plans/add', nested: true, call: async (b) => (await import('@/app/api/menu-plans/add/route')).POST(request('/api/menu-plans/add', 'POST', b)) },
  { name: 'PUT /api/nutrition/targets', call: async (b) => (await import('@/app/api/nutrition/targets/route')).PUT(request('/api/nutrition/targets', 'PUT', b)) },
  { name: 'PATCH /api/pantry/[id]', call: async (b) => (await import('@/app/api/pantry/[id]/route')).PATCH(request(`/api/pantry/${ROW_ID}`, 'PATCH', b), idCtx) },
  { name: 'POST /api/pantry/from-photo', call: async (b) => (await import('@/app/api/pantry/from-photo/route')).POST(request('/api/pantry/from-photo', 'POST', b)) },
  { name: 'POST /api/pantry', call: async (b) => (await import('@/app/api/pantry/route')).POST(request('/api/pantry', 'POST', b)) },
  { name: 'POST /api/performance/checkins', call: async (b) => (await import('@/app/api/performance/checkins/route')).POST(request('/api/performance/checkins', 'POST', b)) },
  { name: 'POST /api/performance/plans', call: async (b) => (await import('@/app/api/performance/plans/route')).POST(request('/api/performance/plans', 'POST', b)) },
  { name: 'PATCH /api/performance/plans', call: async (b) => (await import('@/app/api/performance/plans/route')).PATCH(request('/api/performance/plans', 'PATCH', b)) },
  { name: 'POST /api/profile', call: async (b) => (await import('@/app/api/profile/route')).POST(request('/api/profile', 'POST', b)) },
  { name: 'POST /api/recipes/[id]/comments', call: async (b) => (await import('@/app/api/recipes/[id]/comments/route')).POST(request(`/api/recipes/${ROW_ID}/comments`, 'POST', b), idCtx) },
  { name: 'PUT /api/recipes/[id]', call: async (b) => (await import('@/app/api/recipes/[id]/route')).PUT(request(`/api/recipes/${ROW_ID}`, 'PUT', b), idCtx) },
  { name: 'POST /api/recipes', call: async (b) => (await import('@/app/api/recipes/route')).POST(request('/api/recipes', 'POST', b)) },
  { name: 'PATCH /api/shopping-list/[id]', call: async (b) => (await import('@/app/api/shopping-list/[id]/route')).PATCH(request(`/api/shopping-list/${ROW_ID}`, 'PATCH', b), idCtx) },
  { name: 'POST /api/shopping-list/regenerate', call: async (b) => (await import('@/app/api/shopping-list/regenerate/route')).POST(request('/api/shopping-list/regenerate', 'POST', b)) },
  { name: 'POST /api/shopping-list', call: async (b) => (await import('@/app/api/shopping-list/route')).POST(request('/api/shopping-list', 'POST', b)) },
  { name: 'DELETE /api/shopping-list', call: async (b) => (await import('@/app/api/shopping-list/route')).DELETE(request('/api/shopping-list', 'DELETE', b)) },
];

describe.each(JSON_CASES)('$name', ({ call, nested }) => {
  it.each([
    ['壊れた JSON', BROKEN_JSON],
    ['オブジェクトでない JSON (null)', NON_OBJECT_JSON],
    ['配列の JSON', ARRAY_JSON],
  ])('%s の本文は 400 (500 にしない)', async (_label, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(nested ? NESTED_INVALID_JSON : FLAT_INVALID_JSON);
  });
});
