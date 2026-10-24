// @vitest-environment node
/**
 * #1917 の続き (仕分け triage-1025a の P12〜P16 と、その同じ型): route の入力の検査と読み込みの失敗の残りの回帰テスト
 *
 * 以前の欠陥:
 *   P12 POST /api/recipes が name の無い本文 ({}・[]) を確かめずに insert し、recipes.name の NOT NULL 違反で 500 になっていた
 *       (同じ型: PUT /api/recipes/[id] の name: null・'')
 *   P13 PATCH /api/performance/plans が他人の・存在しない planId で .single() の 0 行の失敗 (PGRST116) を 500 にし、
 *       UUID でない planId も 22P02 で 500 にしていた
 *   P14 買い物リストの POST の shoppingListId・一括 DELETE の itemIds を、形を確かめずに uuid の列へ渡して 500 にしていた
 *       (同じ型: GET の shoppingListId・POST の他人のリスト・献立の並べ替えの dayId・献立の生成の状態の requestId・
 *       組織の部署の PUT / DELETE の id・組織の招待の DELETE の id)
 *   P15 GET /api/ai/nutrition/feedback が DB の読み込みの失敗を 200 の { status: 'not_found' } にしていた
 *       (同じ型: POST のキャッシュの読み込みの失敗を「キャッシュなし」にして生成へ進んでいた)
 *   P16 運営の請求書の詳細が personal_subscriptions の読み込みの失敗を捨て、利用者の欄を空にしていた
 *       (同じ型: 運営のチケットの詳細のメッセージ・プランの価格の履歴・売上ダッシュボード・突合・売上の集計・
 *       フラグの削除の使用中の確認・組織の作成のオーナーの所属の確認・家族の共有の設定・健診と血液検査の経年レビュー・
 *       献立の一覧の買い物リスト・家族の招待の一覧の family_id)
 *   本文の形: `typeof body !== 'object'` だけの検査は配列を通し、JSON の null を確かめない route は例外で 500 になっていた
 *       (配列は tests/route-invalid-input-1917.test.ts の JSON_CASES と tests/api-invalid-json-scan.test.ts の見張りが受け持つ)
 *
 * 直したあとの不変条件:
 *   - 必須の項目が無い・形の違う本文は DB に渡さず 400
 *   - UUID の形でない id は DB に渡さず、行が無い id と同じ応答 (404・not_found・成功)。本文の項目として受けて書く id (買い物リストの
 *     追加先・一括削除の品目) は 400
 *   - 読み込みの DB の失敗は 500 (無い・空・既定の値にしない)。行が無いときだけ、無いときの応答
 *
 * Supabase には接続しない (createClient をモック)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE } from '@/lib/api/error-responses';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';
import { RECIPE_NAME_REQUIRED_MESSAGE } from '@/lib/recipes/recipe-body';
import { MEAL_NOT_FOUND_MESSAGE } from '@/lib/api/user-api-error-messages';
import { AI_MENU_REQUEST_NOT_FOUND_MESSAGE, aiInvalidDateMessage } from '@/lib/ai/ai-api-messages';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER_ID = '50000000-0000-4000-8000-000000000001';
const ROW_ID = '50000000-0000-4000-8000-0000000000aa';
const OTHER_ROW_ID = '50000000-0000-4000-8000-0000000000bb';
const ORG_ID = '50000000-0000-4000-8000-0000000000cc';
const NOT_UUID = 'not-a-uuid';
/** 形は YYYY-MM-DD だが実在しない日付 */
const NOT_A_DATE = '2026-02-30';
const VALID_DATE = '2026-10-24';

type QueryResult = { data: unknown; error: unknown; count?: number | null };
type Op = { method: string; args: unknown[] };

const h = vi.hoisted(() => ({
  /** from(table) の呼び出しごとの記録 (呼んだテーブルと、そのあとに繋いだメソッド) */
  calls: [] as Array<{ table: string; ops: Array<{ method: string; args: unknown[] }> }>,
  /** rpc(name) の呼び出しの記録 */
  rpcCalls: [] as string[],
  /** テーブルごとの結果の列。from() を呼ぶたびに先頭から 1 つずつ使う (最後の 1 つは使い続ける)。無いテーブルは DEFAULT_ROW */
  results: {} as Record<string, Array<{ data: unknown; error: unknown; count?: number | null }>>,
}));

const DEFAULT_ROW = { id: ROW_ID, user_id: USER_ID };

function setResults(table: string, ...results: QueryResult[]): void {
  h.results[table] = results;
}

function takeResult(table: string): QueryResult {
  const queue = h.results[table];
  if (!queue || queue.length === 0) return { data: DEFAULT_ROW, error: null };
  return queue.length > 1 ? (queue.shift() as QueryResult) : queue[0];
}

/** PostgREST のクエリの組み立てのまね。どのメソッドも自分を返し、await・single・maybeSingle で結果を返す */
function queryBuilder(table: string, ops: Op[]): PromiseLike<QueryResult> {
  const result = takeResult(table);
  const settle = () => Promise.resolve(result);
  const builder: PromiseLike<QueryResult> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
            settle().then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          ops.push({ method: String(prop), args });
          if (prop === 'single' || prop === 'maybeSingle') return settle();
          return builder;
        };
      },
    },
  ) as PromiseLike<QueryResult>;
  return builder;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: 'user@example.com' } }, error: null }) },
  from: (table: string) => {
    const ops: Op[] = [];
    h.calls.push({ table, ops });
    return queryBuilder(table, ops);
  },
  rpc: (name: string) => {
    h.rpcCalls.push(name);
    return queryBuilder(`rpc:${name}`, []);
  },
};

const mocks = vi.hoisted(() => ({
  recordAdminAudit: vi.fn(async () => undefined),
  consumeAiUsage: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => client,
  getSupabaseAdmin: () => client,
}));
vi.mock('@/lib/ai/ai-queue-writer', () => ({ getAiQueueWriter: () => client }));
vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});
vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: vi.fn(async () => ({ id: USER_ID, roles: ['support', 'admin', 'super_admin', 'finance'] })),
  requireOrgAdmin: vi.fn(async () => ({ user: { id: USER_ID }, profile: { id: USER_ID, organization_id: ORG_ID, org_role: 'admin' } })),
}));
vi.mock('@/lib/admin/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/audit')>()),
  recordAdminAudit: mocks.recordAdminAudit,
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 10, remaining: 9, reset: 0, windowSec: 60 })),
}));
vi.mock('@/lib/plan/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/plan/entitlements')>()),
  consumeAiUsage: mocks.consumeAiUsage,
}));
vi.mock('@/lib/ai/consent-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consent-guard')>()),
  requireAiConsent: vi.fn(async () => null),
}));
vi.mock('@/lib/membership/invite-throttle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/membership/invite-throttle')>()),
  checkTransferProposeLimit: vi.fn(async () => null),
}));

const DB_FAILURE = { code: '08006', message: 'connection reset by peer', details: null, hint: null };
const FLAT_INTERNAL = { error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE };
const NESTED_INTERNAL = { error: { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE } };
const FLAT_NOT_FOUND = { error: API_NOT_FOUND_MESSAGE };
const FLAT_INVALID_JSON = { error: API_INVALID_JSON_MESSAGE };
const NO_ROW: QueryResult = { data: null, error: null };
const FAILED: QueryResult = { data: null, error: DB_FAILURE };

function request(path: string, method: string, body?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' } }),
  });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

/** from() で呼んだテーブル (呼んだ順) */
const tables = () => h.calls.map((c) => c.table);
/** そのテーブルの呼び出しで使ったメソッドの名前 */
const methodsOf = (table: string) => h.calls.filter((c) => c.table === table).flatMap((c) => c.ops.map((op) => op.method));

beforeEach(() => {
  h.calls.length = 0;
  h.rpcCalls.length = 0;
  h.results = {};
  mocks.recordAdminAudit.mockClear();
  mocks.consumeAiUsage.mockClear();
});

// ---- P12: レシピの名前 ---------------------------------------------------------

describe('P12 POST /api/recipes: 名前 (name) の無い本文は DB に渡さず 400', () => {
  const post = async (body: string) => (await import('@/app/api/recipes/route')).POST(request('/api/recipes', 'POST', body));

  it.each([
    ['空のオブジェクト', '{}'],
    ['name が null', '{"name":null}'],
    ['name が空', '{"name":""}'],
    ['name が空白だけ', '{"name":"   "}'],
    ['name が数', '{"name":1}'],
  ])('%s は 400 (名前を入力してください)。insert しない', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: RECIPE_NAME_REQUIRED_MESSAGE });
    expect(tables()).toEqual([]);
  });

  it('配列の本文は 400 (本文が不正)。insert しない', async () => {
    const res = await post('[{"name":"カレー"}]');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(tables()).toEqual([]);
  });

  it('名前があれば今までどおり insert し、名前はそのまま保存する', async () => {
    setResults('recipes', { data: { id: ROW_ID, name: ' カレー ', created_at: '2026-10-24T00:00:00Z' }, error: null });
    const res = await post('{"name":" カレー "}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, recipe: { id: ROW_ID, name: ' カレー ', createdAt: '2026-10-24T00:00:00Z' } });
    const insert = h.calls.find((c) => c.table === 'recipes')?.ops.find((op) => op.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ user_id: USER_ID, name: ' カレー ' });
  });
});

describe('P12 の同じ型: PUT /api/recipes/[id] の name', () => {
  const put = async (body: string) =>
    (await import('@/app/api/recipes/[id]/route')).PUT(request(`/api/recipes/${ROW_ID}`, 'PUT', body), ctx({ id: ROW_ID }));

  it.each([
    ['null', '{"name":null}'],
    ['空', '{"name":""}'],
    ['数', '{"name":1}'],
  ])('name を %s にする本文は 400。所有者の確認より前に断り、DB に触れない', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: RECIPE_NAME_REQUIRED_MESSAGE });
    expect(tables()).toEqual([]);
  });

  it('name を送らなければ今までどおり更新へ進む', async () => {
    setResults('recipes', { data: { user_id: USER_ID }, error: null }, { data: { id: ROW_ID }, error: null });
    const res = await put('{"description":"辛口"}');
    expect(res.status).toBe(200);
    const update = h.calls.flatMap((c) => c.ops).find((op) => op.method === 'update');
    expect(update?.args[0]).toEqual({ description: '辛口' });
  });
});

// ---- P13: 計画の更新 ---------------------------------------------------------

describe('P13 PATCH /api/performance/plans', () => {
  const patch = async (body: string) =>
    (await import('@/app/api/performance/plans/route')).PATCH(request('/api/performance/plans', 'PATCH', body));

  it('UUID の形でない planId は DB に渡さず 404', async () => {
    const res = await patch(JSON.stringify({ planId: NOT_UUID, status: 'archived' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(tables()).toEqual([]);
  });

  it('更新した行が無い (他人の計画・消えた計画) ときは 404 (500 にしない)。0 行を失敗にしない maybeSingle で読む', async () => {
    setResults('performance_plans', NO_ROW);
    const res = await patch(JSON.stringify({ planId: ROW_ID, status: 'archived' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(methodsOf('performance_plans')).toContain('maybeSingle');
    expect(methodsOf('performance_plans')).not.toContain('single');
  });

  it('DB の失敗は今までどおり 500', async () => {
    setResults('performance_plans', FAILED);
    const res = await patch(JSON.stringify({ planId: ROW_ID, status: 'archived' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it('本人の計画なら今までどおり 200', async () => {
    setResults('performance_plans', { data: { id: ROW_ID, user_id: USER_ID, status: 'archived' }, error: null });
    const res = await patch(JSON.stringify({ planId: ROW_ID, status: 'archived' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.plan.id).toBe(ROW_ID);
  });
});

// ---- P14: 買い物リストの id ----------------------------------------------------

describe('P14 買い物リスト (/api/shopping-list)', () => {
  const load = () => import('@/app/api/shopping-list/route');

  it('POST: UUID の形でない shoppingListId は DB に渡さず 400', async () => {
    const { POST } = await load();
    const res = await POST(request('/api/shopping-list', 'POST', JSON.stringify({ shoppingListId: NOT_UUID, itemName: '牛乳' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '買い物リスト (shoppingListId) の形式が正しくありません' });
    expect(tables()).toEqual([]);
  });

  it('POST: 他人のリスト・消えたリスト (本人のリストに無い) は 404。品目を insert しない', async () => {
    const { POST } = await load();
    setResults('shopping_lists', NO_ROW);
    const res = await POST(request('/api/shopping-list', 'POST', JSON.stringify({ shoppingListId: ROW_ID, itemName: '牛乳' })));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(tables()).toEqual(['shopping_lists']);
    const listFilters = h.calls[0].ops.filter((op) => op.method === 'eq').map((op) => op.args);
    expect(listFilters).toEqual([['id', ROW_ID], ['user_id', USER_ID]]);
  });

  it('POST: リストを確かめられない (DB の失敗) ときは 500。品目を insert しない', async () => {
    const { POST } = await load();
    setResults('shopping_lists', FAILED);
    const res = await POST(request('/api/shopping-list', 'POST', JSON.stringify({ shoppingListId: ROW_ID, itemName: '牛乳' })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
    expect(tables()).toEqual(['shopping_lists']);
  });

  it('POST: 本人のリストなら今までどおり品目を追加する', async () => {
    const { POST } = await load();
    setResults('shopping_lists', { data: { id: ROW_ID }, error: null });
    setResults('shopping_list_items', { data: { id: OTHER_ROW_ID, shopping_list_id: ROW_ID, item_name: '牛乳' }, error: null });
    const res = await POST(request('/api/shopping-list', 'POST', JSON.stringify({ shoppingListId: ROW_ID, itemName: '牛乳' })));
    expect(res.status).toBe(200);
    expect(tables()).toEqual(['shopping_lists', 'shopping_list_items']);
    expect(methodsOf('shopping_list_items')).toContain('insert');
  });

  it.each([
    ['UUID の形でない値', [ROW_ID, NOT_UUID]],
    ['文字列でない値', [ROW_ID, 1]],
  ])('DELETE: itemIds に %s があれば DB に渡さず 400', async (_label, itemIds) => {
    const { DELETE } = await load();
    const res = await DELETE(request('/api/shopping-list', 'DELETE', JSON.stringify({ itemIds })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '対象の品目 (itemIds) の形式が正しくありません' });
    expect(tables()).toEqual([]);
  });

  it('DELETE: すべて UUID なら今までどおり消す', async () => {
    const { DELETE } = await load();
    setResults('shopping_list_items', NO_ROW);
    const res = await DELETE(request('/api/shopping-list', 'DELETE', JSON.stringify({ itemIds: [ROW_ID, OTHER_ROW_ID] })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deletedCount: 2 });
    const inCall = h.calls[0].ops.find((op) => op.method === 'in');
    expect(inCall?.args).toEqual(['id', [ROW_ID, OTHER_ROW_ID]]);
  });

  it('GET: UUID の形でない shoppingListId は DB に渡さず 404', async () => {
    const { GET } = await load();
    const res = await GET(request(`/api/shopping-list?shoppingListId=${NOT_UUID}`, 'GET'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(FLAT_NOT_FOUND);
    expect(tables()).toEqual([]);
  });

  it('GET: 他人のリスト・消えたリストは 404 (0 行を失敗にして 500 にしない)。DB の失敗は 500', async () => {
    const { GET } = await load();
    setResults('shopping_lists', NO_ROW);
    const missing = await GET(request(`/api/shopping-list?shoppingListId=${ROW_ID}`, 'GET'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(FLAT_NOT_FOUND);
    expect(methodsOf('shopping_lists')).toContain('maybeSingle');

    setResults('shopping_lists', FAILED);
    const failed = await GET(request(`/api/shopping-list?shoppingListId=${ROW_ID}`, 'GET'));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual(FLAT_INTERNAL);
  });
});

describe('P14 の同じ型: 本文・クエリの id を uuid の列へ渡す route', () => {
  it('POST /api/meal-plans/meals/reorder: UUID の形でない dayId は DB に渡さず 404 (その日の食事が無いときと同じ)', async () => {
    const { POST } = await import('@/app/api/meal-plans/meals/reorder/route');
    const res = await POST(request('/api/meal-plans/meals/reorder', 'POST', JSON.stringify({ mealId: ROW_ID, direction: 'up', dayId: NOT_UUID })));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: MEAL_NOT_FOUND_MESSAGE });
    expect(tables()).toEqual([]);
  });

  it('GET /api/ai/menu/weekly/status: UUID の形でない requestId は DB に渡さず、行が無いときと同じ not_found', async () => {
    const { GET } = await import('@/app/api/ai/menu/weekly/status/route');
    const res = await GET(request(`/api/ai/menu/weekly/status?requestId=${NOT_UUID}`, 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_found', requestId: NOT_UUID });
    expect(tables()).toEqual([]);
  });

  it('POST /api/ai/menu/weekly/status: UUID の形でない requestId は DB に渡さず 404 (受付が無いときと同じ)', async () => {
    const { POST } = await import('@/app/api/ai/menu/weekly/status/route');
    const res = await POST(request('/api/ai/menu/weekly/status', 'POST', JSON.stringify({ requestId: NOT_UUID })));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: AI_MENU_REQUEST_NOT_FOUND_MESSAGE });
    expect(tables()).toEqual([]);
  });

  it('PUT / DELETE /api/org/departments: UUID の形でない id は DB に渡さず 404 (部署が無いときと同じ)', async () => {
    const { PUT, DELETE } = await import('@/app/api/org/departments/route');
    const notFound = { error: { code: 'NOT_FOUND', message: '部署が見つかりません' } };
    const put = await PUT(request('/api/org/departments', 'PUT', JSON.stringify({ id: NOT_UUID, name: '営業部' })));
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual(notFound);
    const del = await DELETE(request(`/api/org/departments?id=${NOT_UUID}`, 'DELETE'));
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual(notFound);
    expect(tables()).toEqual([]);
  });

  it('DELETE /api/org/invites: UUID の形でない id は DB に渡さず、消す行が無いときと同じ成功', async () => {
    const { DELETE } = await import('@/app/api/org/invites/route');
    const res = await DELETE(request(`/api/org/invites?id=${NOT_UUID}`, 'DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(tables()).toEqual([]);
  });
});

// ---- 本文の形 (JSON の null) ---------------------------------------------------

describe('JSON の null の本文を確かめずに読んでいた route は 400', () => {
  const nestedInvalid = (code: string) => ({ error: { code, message: 'リクエストボディが不正です' } });

  it.each(['null', '[]', '1'])('POST /api/family/members/[member_id]/remove: 本文 %s は 400 INVALID_REQUEST', async (body) => {
    const { POST } = await import('@/app/api/family/members/[member_id]/remove/route');
    const res = await POST(request(`/api/family/members/${ROW_ID}/remove`, 'POST', body), ctx({ member_id: ROW_ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(nestedInvalid(MembershipErrorCode.INVALID_REQUEST));
    expect(tables()).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });

  it.each(['null', '[]', '1'])('POST /api/family/representative-transfer/propose: 本文 %s は 400 INVALID_REQUEST', async (body) => {
    const { POST } = await import('@/app/api/family/representative-transfer/propose/route');
    const res = await POST(request('/api/family/representative-transfer/propose', 'POST', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(nestedInvalid('INVALID_REQUEST'));
    expect(h.rpcCalls).toEqual([]);
  });

  it.each(['null', '[]', '1'])('POST /api/ai/menu/weekly/status: 本文 %s は 400', async (body) => {
    const { POST } = await import('@/app/api/ai/menu/weekly/status/route');
    const res = await POST(request('/api/ai/menu/weekly/status', 'POST', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(tables()).toEqual([]);
  });

  it.each(['null', '[]', '1'])('PATCH /api/notification-preferences: 本文 %s は 400', async (body) => {
    const { PATCH } = await import('@/app/api/notification-preferences/route');
    const res = await PATCH(request('/api/notification-preferences', 'PATCH', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(tables()).toEqual([]);
  });

  it.each(['null', '[]', '1'])('PUT /api/profile: 本文 %s は 400', async (body) => {
    const { PUT } = await import('@/app/api/profile/route');
    const res = await PUT(request('/api/profile', 'PUT', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(FLAT_INVALID_JSON);
    expect(tables()).toEqual([]);
  });
});

// ---- P15: 栄養の振り返り -------------------------------------------------------

describe('P15 GET /api/ai/nutrition/feedback', () => {
  const get = async (query: string) =>
    (await import('@/app/api/ai/nutrition/feedback/route')).GET(request(`/api/ai/nutrition/feedback?${query}`, 'GET'));

  it.each([
    ['UUID の形でない cacheId', `cacheId=${NOT_UUID}`],
    ['実在しない日付', `date=${NOT_A_DATE}`],
  ])('%s は DB に渡さず、行が無いときと同じ not_found', async (_label, query) => {
    const res = await get(query);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_found' });
    expect(tables()).toEqual([]);
  });

  it('読み込みの DB の失敗は 500 (200 の not_found にしない)', async () => {
    setResults('nutrition_feedback_cache', FAILED);
    const res = await get(`cacheId=${ROW_ID}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it('行が無いときだけ not_found (0 行を失敗にしない maybeSingle で読む)', async () => {
    setResults('nutrition_feedback_cache', NO_ROW);
    const res = await get(`date=${VALID_DATE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_found' });
    expect(methodsOf('nutrition_feedback_cache')).toContain('maybeSingle');
    expect(methodsOf('nutrition_feedback_cache')).not.toContain('single');
  });

  it('行があれば今までどおり状態を返す', async () => {
    setResults('nutrition_feedback_cache', { data: { id: ROW_ID, status: 'generating', feedback: '', nutrition_hash: 'h' }, error: null });
    const res = await get(`cacheId=${ROW_ID}`);
    expect(await res.json()).toEqual({ feedback: null, praiseComment: null, advice: null, nutritionTip: null, status: 'generating', cacheId: ROW_ID });
  });
});

describe('P15 の同じ型: POST /api/ai/nutrition/feedback のキャッシュの読み込み', () => {
  const post = async (body: Record<string, unknown>) =>
    (await import('@/app/api/ai/nutrition/feedback/route')).POST(request('/api/ai/nutrition/feedback', 'POST', JSON.stringify(body)));

  it('キャッシュを読めない (DB の失敗) ときは 500。キャッシュなしとして AI の回数を数えない', async () => {
    setResults('nutrition_feedback_cache', FAILED);
    const res = await post({ date: VALID_DATE, nutrition: { caloriesKcal: 1800 } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
    expect(mocks.consumeAiUsage).not.toHaveBeenCalled();
    expect(tables()).toEqual(['nutrition_feedback_cache']);
  });

  it('実在しない日付は DB に渡さず 400', async () => {
    const res = await post({ date: NOT_A_DATE, nutrition: { caloriesKcal: 1800 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: aiInvalidDateMessage('日付') });
    expect(tables()).toEqual([]);
  });
});

// ---- P16: 運営の請求書の詳細と、読み込みの失敗を捨てていた同じ型 -------------------------

describe('P16 GET /api/admin/finance/invoices/[id]', () => {
  const EVENT = {
    id: 'evt_1',
    event_type: 'invoice.paid',
    processing_status: 'processed',
    received_at: '2026-10-24T00:00:00Z',
    payload: { data: { object: { id: 'in_1', subscription: 'sub_1', customer: 'cus_1' } } },
  };
  const get = async () =>
    (await import('@/app/api/admin/finance/invoices/[id]/route')).GET(
      request('/api/admin/finance/invoices/evt_1', 'GET'),
      ctx({ id: 'evt_1' }),
    );

  it('personal_subscriptions を読めない (DB の失敗) ときは 500 (利用者の欄を空にしない)。監査ログは残さない', async () => {
    setResults('stripe_webhook_events', { data: EVENT, error: null });
    setResults('personal_subscriptions', FAILED);
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('紐づく契約の行が無いときだけ user_id は null (0 行を失敗にしない maybeSingle で読む)', async () => {
    setResults('stripe_webhook_events', { data: EVENT, error: null });
    setResults('personal_subscriptions', NO_ROW);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).data.user_id).toBeNull();
    expect(methodsOf('personal_subscriptions')).toContain('maybeSingle');
  });

  it('紐づく契約があれば user_id を返す', async () => {
    setResults('stripe_webhook_events', { data: EVENT, error: null });
    setResults('personal_subscriptions', { data: { user_id: USER_ID, plan_key: 'premium' }, error: null });
    const res = await get();
    expect((await res.json()).data.user_id).toBe(USER_ID);
  });
});

describe('P16 の同じ型: 運営の詳細・集計', () => {
  it('GET /api/admin/support/tickets/[id]: メッセージを読めないときは 500 (メッセージ 0 件にしない)。監査ログは残さない', async () => {
    const { GET } = await import('@/app/api/admin/support/tickets/[id]/route');
    setResults('support_tickets', { data: { id: ROW_ID, user_id: USER_ID }, error: null });
    setResults('support_ticket_messages', FAILED);
    const res = await GET(request(`/api/admin/support/tickets/${ROW_ID}`, 'GET'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
    expect(mocks.recordAdminAudit).not.toHaveBeenCalled();
  });

  it('GET /api/super-admin/plans/[id]: 価格の履歴を読めないときは 500 (空の履歴にしない)', async () => {
    const { GET } = await import('@/app/api/super-admin/plans/[id]/route');
    setResults('subscription_plans', { data: { id: ROW_ID, plan_key: 'premium' }, error: null });
    setResults('plan_price_history', FAILED);
    const res = await GET(request(`/api/super-admin/plans/${ROW_ID}`, 'GET'), ctx({ id: ROW_ID }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
  });

  describe('GET /api/admin/finance/dashboard', () => {
    const get = async () => (await import('@/app/api/admin/finance/dashboard/route')).GET();

    it.each([
      ['今月のスナップショット', () => setResults('revenue_snapshots', FAILED)],
      ['先月のスナップショット', () => setResults('revenue_snapshots', NO_ROW, FAILED)],
      ['契約の直接の集計', () => { setResults('revenue_snapshots', NO_ROW); setResults('personal_subscriptions', FAILED); }],
      ['MAU', () => { setResults('revenue_snapshots', { data: { total_mrr_jpy: 1000 }, error: null }); setResults('daily_active_users', FAILED); }],
    ])('%s を読めないときは 500 (0 にしない)', async (_label, arrange) => {
      arrange();
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(NESTED_INTERNAL);
    });

    it('スナップショット・MAU の行が無いときは今までどおり 0 (0 行を失敗にしない maybeSingle で読む)', async () => {
      setResults('revenue_snapshots', NO_ROW);
      setResults('personal_subscriptions', { data: [], error: null });
      setResults('daily_active_users', NO_ROW);
      const res = await get();
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.current_mrr_jpy).toBe(0);
      expect(data.mau).toBe(0);
      expect(methodsOf('revenue_snapshots')).not.toContain('single');
      expect(methodsOf('daily_active_users')).not.toContain('single');
    });
  });

  it('GET /api/admin/finance/reconciliation: DB の契約を読めないときは 500 (0 件にしない)', async () => {
    const { GET } = await import('@/app/api/admin/finance/reconciliation/route');
    setResults('admin_audit_logs', { data: [], error: null, count: 0 });
    setResults('personal_subscriptions', FAILED);
    const res = await GET(request('/api/admin/finance/reconciliation', 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
  });

  it('GET /api/admin/finance/revenue: 集計のスナップショットを読めないときは 500 (平均を 0 にしない)', async () => {
    const { GET } = await import('@/app/api/admin/finance/revenue/route');
    setResults('revenue_snapshots', { data: [], error: null, count: 0 }, FAILED);
    const res = await GET(request('/api/admin/finance/revenue', 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
  });

  it('DELETE /api/super-admin/flags/[key]: 使用中かを確かめられないときは 500。フラグを消さない', async () => {
    const { DELETE } = await import('@/app/api/super-admin/flags/[key]/route');
    setResults('feature_packages', FAILED);
    const res = await DELETE(request('/api/super-admin/flags/beta_feature', 'DELETE'), ctx({ key: 'beta_feature' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
    expect(tables()).toEqual(['feature_packages']);
  });

  it('POST /api/admin/organizations: オーナーの所属を確かめられないときは 500。組織を作らない', async () => {
    const { POST } = await import('@/app/api/admin/organizations/route');
    setResults('user_profiles', FAILED);
    const res = await POST(request('/api/admin/organizations', 'POST', JSON.stringify({ name: '株式会社テスト', owner_id: OTHER_ROW_ID })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
    expect(tables()).toEqual(['user_profiles']);
  });
});

describe('P16 の同じ型: 利用者の画面の読み込み・書き込みの前の読み込み', () => {
  it('PATCH /api/family/members/me/share: 今の設定を読めないときは 500。既定の値で上書きしない (RPC を呼ばない)', async () => {
    const { PATCH } = await import('@/app/api/family/members/me/share/route');
    setResults('family_members', FAILED);
    const res = await PATCH(request('/api/family/members/me/share', 'PATCH', JSON.stringify({ share_meals: false })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(NESTED_INTERNAL);
    expect(h.rpcCalls).toEqual([]);
  });

  it('PATCH /api/family/members/me/share: 今の設定があれば送らなかった項目はその値のまま', async () => {
    const { PATCH } = await import('@/app/api/family/members/me/share/route');
    setResults('family_members', { data: { share_meals: true, share_health: true, share_menu: false }, error: null });
    setResults('rpc:update_my_share_settings', { data: { ok: true }, error: null });
    const res = await PATCH(request('/api/family/members/me/share', 'PATCH', JSON.stringify({ share_meals: false })));
    expect(res.status).toBe(200);
    expect(h.rpcCalls).toEqual(['update_my_share_settings']);
  });

  it.each([
    ['GET /api/health/checkups', 'health_checkups', 'health_checkup_longitudinal_reviews', () => import('@/app/api/health/checkups/route')],
    ['GET /api/health/blood-tests', 'blood_test_results', 'blood_test_longitudinal_reviews', () => import('@/app/api/health/blood-tests/route')],
  ] as const)('%s: 経年レビューを読めないときは 500 (無いように見せない)', async (path, listTable, reviewTable, load) => {
    const { GET } = await load();
    setResults(listTable, { data: [], error: null });
    setResults(reviewTable, FAILED);
    const res = await GET(request(path.replace('GET ', ''), 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it('GET /api/meal-plans: 買い物リストを読めないときは 500 (無いように見せない)', async () => {
    const { GET } = await import('@/app/api/meal-plans/route');
    setResults('user_daily_meals', { data: [], error: null });
    setResults('shopping_lists', FAILED);
    const res = await GET(request('/api/meal-plans', 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(FLAT_INTERNAL);
  });

  it('GET /api/family/invites: 自分の family_id を読めないときは 500 (招待 0 件にしない)', async () => {
    const { GET } = await import('@/app/api/family/invites/route');
    setResults('user_profiles', FAILED);
    const res = await GET(request('/api/family/invites', 'GET'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: MembershipErrorCode.RPC_FAILED, message: '招待一覧の取得に失敗しました' } });
    expect(tables()).toEqual(['user_profiles']);
  });

  it('GET /api/family/invites: 家族に入っていない (行が無い) ときは今までどおり空の一覧', async () => {
    const { GET } = await import('@/app/api/family/invites/route');
    setResults('user_profiles', NO_ROW);
    const res = await GET(request('/api/family/invites', 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { invites: [] } });
  });
});
