/**
 * #1917 1 行を読んで「無ければ 404」にする route の、読み込みの DB の失敗と、行が無いときと、UUID の形でない id の route テスト
 *
 * 以前は次のようになっていた:
 *  - 多くの route が `.single()` で読み、`if (error || !row) return 404` (または error を見ずに `if (!row) return 404`) と書いていた。
 *    DB の一時的な失敗でも「見つかりません」になり、実在する行が消えたように見えた (運営の詳細・更新、利用者の食事・献立・AI 相談ほか)
 *  - GET /api/health/goals/[id] は `.single()` の error をそのまま 500 にしたので、他人の目標・消された目標でも 500 になった
 *
 * 直したあとの不変条件 (route ごとに確かめる):
 *  - 読み込みの DB の失敗は 500 (404 にしない)。DB の生の文面は本文に出さない
 *  - 行が無いときだけ 404 (レシピの更新・削除は以前から 403 のまま)
 *  - uuid の列を引く id が UUID の形でなければ、DB に渡さずに 404 (渡すと 22P02 の失敗になり、500 に入ってしまうため)
 *
 * PostgREST の呼び出しは、ここで作る小さな偽物が受ける。どのメソッドを繋いでも同じものを返し、maybeSingle / single / await で
 * テーブルごとの結果を返す。failTable に決めたテーブルの読み込みは DB の失敗、missingTable に決めたテーブルは行が無い。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// route を丸ごと読み込むので、負荷の高い機械で既定の時間切れを超えうる (#1605 の同じ型)。テストとフックを定義する前に置く
applyHeavyUnitTestTimeout();

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const ROW_ID = '10000000-0000-4000-8000-0000000000aa';
const ORG_ID = '10000000-0000-4000-8000-0000000000bb';
/** UUID の形でない id */
const NOT_UUID = 'not-a-uuid';
/** DB の生のエラー文 (本文に出てはいけない) */
const RAW_DB_MESSAGE = 'connection reset by peer';
const DB_FAILURE = { code: '08006', message: RAW_DB_MESSAGE, details: null, hint: null };
const TODAY = '2026-10-24';

const state = {
  /** 読み込みを DB の失敗にするテーブル */
  failTable: null as string | null,
  /** 行が無いテーブル */
  missingTable: null as string | null,
  /** from() に渡されたテーブル (呼んだ順) */
  fromTables: [] as string[],
};

/** テーブルごとの既定の 1 行 (route が先に読むほかの行は、ここで読めるようにする) */
function rowOf(table: string): Record<string, unknown> {
  return {
    id: ROW_ID,
    user_id: USER_ID,
    roles: ['user'],
    status: table === 'ai_action_logs' ? 'pending' : 'draft',
    code: 'WELCOME',
    plan_key: 'pro',
    plan_type: 'personal',
    monthly_price_jpy: 980,
    valid_from: '2026-10-01T00:00:00Z',
    uses_count: 0,
    goal_type: 'weight',
    start_value: 70,
    target_value: 60,
    current_value: 65,
    progress_percentage: 50,
    milestones: [],
    day_date: TODAY,
    quantity_variants: [{ display: '1個' }],
    is_important: false,
    action_type: 'update_meal',
    action_params: {},
    variants: [],
    payload: {},
    user_daily_meals: { user_id: USER_ID },
    ai_consultation_sessions: { user_id: USER_ID },
  };
}

function resultOf(table: string, many: boolean) {
  state.fromTables.push(table);
  if (state.failTable === table) return { data: null, error: DB_FAILURE, count: null, status: 503 };
  if (state.missingTable === table) return { data: many ? [] : null, error: null, count: 0, status: 200 };
  return { data: many ? [rowOf(table)] : rowOf(table), error: null, count: 1, status: 200 };
}

function makeQuery(table: string): unknown {
  const settle = (many: boolean) => Promise.resolve(resultOf(table, many));
  const builder: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle(true).then(resolve, reject);
        }
        if (prop === 'maybeSingle') return () => settle(false);
        if (prop === 'single') {
          // single は行が無いと PGRST116 の失敗 (PostgREST と同じ)
          return () =>
            settle(false).then((r) =>
              r.data === null && !r.error ? { data: null, error: { code: 'PGRST116', message: 'no rows' } } : r,
            );
        }
        return () => builder;
      },
    },
  );
  return builder;
}

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } }, error: null }) },
    from: (table: string) => makeQuery(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeClient(),
  getSupabaseAdmin: () => fakeClient(),
}));

vi.mock('@/lib/ai/ai-queue-writer', () => ({
  getAiQueueWriter: () => fakeClient(),
}));

vi.mock('@/lib/auth/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/helpers')>()),
  requireRole: vi.fn(async () => ({ id: OTHER_USER_ID, roles: ['super_admin', 'admin', 'support', 'sales', 'finance'] })),
  requireOrgAdmin: vi.fn(async () => ({ profile: { id: USER_ID, organization_id: ORG_ID, org_role: 'owner' } })),
}));

vi.mock('@/lib/admin/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/audit')>()),
  recordAdminAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({ success: true, limit: 5, remaining: 4, reset: 0 })),
}));

vi.mock('@/lib/ai/consent-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/consent-guard')>()),
  requireAiConsent: vi.fn(async () => null),
}));

vi.mock('@/lib/ai/ai-chat-gate', () => ({
  aiChatDisabledResponse: vi.fn(async () => null),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
    generateRequestId: vi.fn(() => 'req_test'),
  };
});

vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-for-test');

function json(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

interface ReadCase {
  name: string;
  /** 失敗させる・行を無くすテーブル */
  table: string;
  /** id を受けて route を呼ぶ */
  call: (id: string) => Promise<Response>;
  /** 行が無いときのステータス (既定は 404) */
  missingStatus?: number;
  /** UUID の形でない id を DB に渡さずに断るか (id を取らない route・文字列の id の route は false) */
  checksUuid?: boolean;
}

const BASE = 'http://localhost';

const CASES: ReadCase[] = [
  // ── 運営 (admin / super-admin) ─────────────────────────────────────────────
  {
    name: 'GET /api/admin/support/tickets/[id]',
    table: 'support_tickets',
    call: async (id) => (await import('@/app/api/admin/support/tickets/[id]/route')).GET(new NextRequest(`${BASE}/api/admin/support/tickets/${id}`), ctx({ id })),
  },
  {
    name: 'PATCH /api/admin/support/tickets/[id]',
    table: 'support_tickets',
    call: async (id) => (await import('@/app/api/admin/support/tickets/[id]/route')).PATCH(json(`${BASE}/api/admin/support/tickets/${id}`, 'PATCH', { status: 'open' }), ctx({ id })),
  },
  {
    name: 'POST /api/admin/support/tickets/[id]/assign',
    table: 'support_tickets',
    call: async (id) =>
      (await import('@/app/api/admin/support/tickets/[id]/assign/route')).POST(json(`${BASE}/api/admin/support/tickets/${id}/assign`, 'POST', { assignee_id: OTHER_USER_ID }), ctx({ id })),
  },
  {
    name: 'POST /api/admin/support/tickets/[id]/messages',
    table: 'support_tickets',
    call: async (id) =>
      (await import('@/app/api/admin/support/tickets/[id]/messages/route')).POST(json(`${BASE}/api/admin/support/tickets/${id}/messages`, 'POST', { body: 'メモ', is_internal: true }), ctx({ id })),
  },
  {
    name: 'GET /api/admin/users/[id]',
    table: 'user_profiles',
    call: async (id) => (await import('@/app/api/admin/users/[id]/route')).GET(new Request(`${BASE}/api/admin/users/${id}`), ctx({ id })),
  },
  {
    name: 'PATCH /api/admin/users/[id]/role',
    table: 'user_profiles',
    call: async (id) => (await import('@/app/api/admin/users/[id]/role/route')).PATCH(json(`${BASE}/api/admin/users/${id}/role`, 'PATCH', { roles: ['user'] }), ctx({ id })),
  },
  {
    name: 'POST /api/admin/users/[id]/freeze',
    table: 'user_profiles',
    call: async (id) =>
      (await import('@/app/api/admin/users/[id]/freeze/route')).POST(
        json(`${BASE}/api/admin/users/${id}/freeze`, 'POST', { ban_type: 'temporary', duration_days: 7, reason_category: 'spam', reason_detail: '迷惑な投稿' }),
        ctx({ id }),
      ),
  },
  {
    name: 'DELETE /api/admin/users/[id]/freeze',
    table: 'user_profiles',
    call: async (id) => (await import('@/app/api/admin/users/[id]/freeze/route')).DELETE(json(`${BASE}/api/admin/users/${id}/freeze`, 'DELETE', { reason: '解除' }), ctx({ id })),
  },
  {
    name: 'GET /api/admin/finance/invoices/[id] (Stripe のイベント ID は文字列)',
    table: 'stripe_webhook_events',
    checksUuid: false,
    call: async (id) => (await import('@/app/api/admin/finance/invoices/[id]/route')).GET(new NextRequest(`${BASE}/api/admin/finance/invoices/${id}`), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/feature-packages/[id]',
    table: 'feature_packages',
    call: async (id) => (await import('@/app/api/super-admin/feature-packages/[id]/route')).GET(new NextRequest(`${BASE}/api/super-admin/feature-packages/${id}`), ctx({ id })),
  },
  {
    name: 'DELETE /api/super-admin/feature-packages/[id]',
    table: 'feature_packages',
    call: async (id) => (await import('@/app/api/super-admin/feature-packages/[id]/route')).DELETE(new NextRequest(`${BASE}/api/super-admin/feature-packages/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/plans/[id]',
    table: 'subscription_plans',
    call: async (id) => (await import('@/app/api/super-admin/plans/[id]/route')).GET(new NextRequest(`${BASE}/api/super-admin/plans/${id}`), ctx({ id })),
  },
  {
    name: 'PATCH /api/super-admin/plans/[id]',
    table: 'subscription_plans',
    call: async (id) => (await import('@/app/api/super-admin/plans/[id]/route')).PATCH(json(`${BASE}/api/super-admin/plans/${id}`, 'PATCH', { display_name: 'プロ' }), ctx({ id })),
  },
  {
    name: 'DELETE /api/super-admin/plans/[id]',
    table: 'subscription_plans',
    call: async (id) => (await import('@/app/api/super-admin/plans/[id]/route')).DELETE(new NextRequest(`${BASE}/api/super-admin/plans/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/plans/[id]/price-impact',
    table: 'subscription_plans',
    call: async (id) =>
      (await import('@/app/api/super-admin/plans/[id]/price-impact/route')).GET(new NextRequest(`${BASE}/api/super-admin/plans/${id}/price-impact?new_monthly_price_jpy=1200`), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/experiments/[id]',
    table: 'experiments',
    call: async (id) => (await import('@/app/api/super-admin/experiments/[id]/route')).GET(new NextRequest(`${BASE}/api/super-admin/experiments/${id}`), ctx({ id })),
  },
  {
    name: 'PATCH /api/super-admin/experiments/[id]',
    table: 'experiments',
    call: async (id) => (await import('@/app/api/super-admin/experiments/[id]/route')).PATCH(json(`${BASE}/api/super-admin/experiments/${id}`, 'PATCH', { name: '新しい名前' }), ctx({ id })),
  },
  {
    name: 'DELETE /api/super-admin/experiments/[id]',
    table: 'experiments',
    call: async (id) => (await import('@/app/api/super-admin/experiments/[id]/route')).DELETE(new NextRequest(`${BASE}/api/super-admin/experiments/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/experiments/[id]/results',
    table: 'experiments',
    call: async (id) => (await import('@/app/api/super-admin/experiments/[id]/results/route')).GET(new NextRequest(`${BASE}/api/super-admin/experiments/${id}/results`), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/coupons/[id]',
    table: 'coupons',
    call: async (id) => (await import('@/app/api/super-admin/coupons/[id]/route')).GET(new NextRequest(`${BASE}/api/super-admin/coupons/${id}`), ctx({ id })),
  },
  {
    name: 'PATCH /api/super-admin/coupons/[id]',
    table: 'coupons',
    call: async (id) => (await import('@/app/api/super-admin/coupons/[id]/route')).PATCH(json(`${BASE}/api/super-admin/coupons/${id}`, 'PATCH', { display_name: '新しい名前' }), ctx({ id })),
  },
  {
    name: 'DELETE /api/super-admin/coupons/[id]',
    table: 'coupons',
    call: async (id) => (await import('@/app/api/super-admin/coupons/[id]/route')).DELETE(new NextRequest(`${BASE}/api/super-admin/coupons/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'GET /api/super-admin/coupons/[id]/redemptions',
    table: 'coupons',
    call: async (id) => (await import('@/app/api/super-admin/coupons/[id]/redemptions/route')).GET(new NextRequest(`${BASE}/api/super-admin/coupons/${id}/redemptions`), ctx({ id })),
  },
  {
    name: 'GET /api/org/settings (自分の組織)',
    table: 'organizations',
    checksUuid: false,
    call: async () => (await import('@/app/api/org/settings/route')).GET(),
  },
  // ── 利用者 ─────────────────────────────────────────────────────────────────
  {
    name: 'GET /api/health/goals/[id]',
    table: 'health_goals',
    call: async (id) => (await import('@/app/api/health/goals/[id]/route')).GET(new NextRequest(`${BASE}/api/health/goals/${id}`), ctx({ id })),
    // UUID の形でない id は以前から 400 (#1478)。ここでは DB の失敗と行が無いときだけを見る
    checksUuid: false,
  },
  {
    name: 'PUT /api/health/goals/[id]',
    table: 'health_goals',
    call: async (id) => (await import('@/app/api/health/goals/[id]/route')).PUT(json(`${BASE}/api/health/goals/${id}`, 'PUT', { current_value: 64 }), ctx({ id })),
    checksUuid: false,
  },
  {
    name: 'GET /api/meals/[id]',
    table: 'planned_meals',
    call: async (id) => (await import('@/app/api/meals/[id]/route')).GET(new Request(`${BASE}/api/meals/${id}`), ctx({ id })),
  },
  {
    name: 'DELETE /api/meals/[id]',
    table: 'planned_meals',
    call: async (id) => (await import('@/app/api/meals/[id]/route')).DELETE(new Request(`${BASE}/api/meals/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'PATCH /api/meal-plans/meals/[id]',
    table: 'planned_meals',
    call: async (id) => (await import('@/app/api/meal-plans/meals/[id]/route')).PATCH(json(`${BASE}/api/meal-plans/meals/${id}`, 'PATCH', { isCompleted: true }), ctx({ id })),
  },
  {
    name: 'GET /api/shopping-list/regenerate/status',
    table: 'shopping_list_requests',
    call: async (id) => (await import('@/app/api/shopping-list/regenerate/status/route')).GET(new Request(`${BASE}/api/shopping-list/regenerate/status?requestId=${id}`)),
  },
  {
    name: 'PATCH /api/shopping-list/[id]',
    table: 'shopping_list_items',
    call: async (id) => (await import('@/app/api/shopping-list/[id]/route')).PATCH(json(`${BASE}/api/shopping-list/${id}`, 'PATCH', { selectedVariantIndex: 0 }), ctx({ id })),
  },
  {
    name: 'PATCH /api/pantry/[id]',
    table: 'pantry_items',
    call: async (id) => (await import('@/app/api/pantry/[id]/route')).PATCH(json(`${BASE}/api/pantry/${id}`, 'PATCH', { name: '卵' }), ctx({ id })),
  },
  {
    name: 'PUT /api/recipes/[id] (行が無い・他人のレシピは以前から 403)',
    table: 'recipes',
    missingStatus: 403,
    call: async (id) => (await import('@/app/api/recipes/[id]/route')).PUT(json(`${BASE}/api/recipes/${id}`, 'PUT', { name: 'カレー' }), ctx({ id })),
  },
  {
    name: 'DELETE /api/recipes/[id] (行が無い・他人のレシピは以前から 403)',
    table: 'recipes',
    missingStatus: 403,
    call: async (id) => (await import('@/app/api/recipes/[id]/route')).DELETE(new Request(`${BASE}/api/recipes/${id}`, { method: 'DELETE' }), ctx({ id })),
  },
  {
    name: 'POST /api/handson-tour/complete (自分のプロフィール)',
    table: 'user_profiles',
    checksUuid: false,
    call: async () => (await import('@/app/api/handson-tour/complete/route')).POST(),
  },
  {
    name: 'POST /api/handson-tour/skip (自分のプロフィール)',
    table: 'user_profiles',
    checksUuid: false,
    call: async () => (await import('@/app/api/handson-tour/skip/route')).POST(json(`${BASE}/api/handson-tour/skip`, 'POST', { step: 1, reason: 'user_action' })),
  },
  {
    name: 'POST /api/nutrition-targets/calculate (自分のプロフィール)',
    table: 'user_profiles',
    checksUuid: false,
    call: async () => (await import('@/app/api/nutrition-targets/calculate/route')).POST(),
  },
  {
    name: 'GET /api/performance/analyze (自分のプロフィール)',
    table: 'user_profiles',
    checksUuid: false,
    call: async () => (await import('@/app/api/performance/analyze/route')).GET(new NextRequest(`${BASE}/api/performance/analyze?date=${TODAY}`)),
  },
  {
    name: 'GET /api/performance/analyze (栄養の目標)',
    table: 'nutrition_targets',
    checksUuid: false,
    call: async () => (await import('@/app/api/performance/analyze/route')).GET(new NextRequest(`${BASE}/api/performance/analyze?date=${TODAY}`)),
  },
  {
    name: 'GET /api/ai/consultation/sessions/[sessionId]/messages',
    table: 'ai_consultation_sessions',
    call: async (id) =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/route')).GET(new Request(`${BASE}/api/ai/consultation/sessions/${id}/messages`), ctx({ sessionId: id })),
  },
  {
    name: 'POST /api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important (メッセージ)',
    table: 'ai_consultation_messages',
    call: async (id) =>
      (await import('@/app/api/ai/consultation/sessions/[sessionId]/messages/[messageId]/important/route')).POST(
        json(`${BASE}/api/ai/consultation/sessions/${ROW_ID}/messages/${id}/important`, 'POST', { isImportant: true }),
        ctx({ sessionId: ROW_ID, messageId: id }),
      ),
  },
  {
    name: 'DELETE /api/ai/consultation/actions/[actionId]/execute (アクションの却下)',
    table: 'ai_action_logs',
    call: async (id) =>
      (await import('@/app/api/ai/consultation/actions/[actionId]/execute/route')).DELETE(
        new Request(`${BASE}/api/ai/consultation/actions/${id}/execute`, { method: 'DELETE' }),
        ctx({ actionId: id }),
      ),
  },
  {
    name: 'POST /api/ai/nutrition (献立の所有の確認)',
    table: 'planned_meals',
    call: async (id) => (await import('@/app/api/ai/nutrition/route')).POST(json(`${BASE}/api/ai/nutrition`, 'POST', { plannedMealId: id })),
  },
  {
    name: 'POST /api/ai/menu/day/regenerate (1 日の献立)',
    table: 'user_daily_meals',
    call: async (id) => (await import('@/app/api/ai/menu/day/regenerate/route')).POST(json(`${BASE}/api/ai/menu/day/regenerate`, 'POST', { dailyMealId: id })),
  },
  {
    name: 'POST /api/ai/nutrition-analysis (その日の献立)',
    table: 'user_daily_meals',
    checksUuid: false,
    call: async () =>
      (await import('@/app/api/ai/nutrition-analysis/route')).POST(
        json(`${BASE}/api/ai/nutrition-analysis`, 'POST', { targetDate: TODAY, targetMealType: 'dinner', prompt: '野菜を増やして' }),
      ),
  },
  {
    name: 'POST /api/ai/nutrition-analysis (対象の食事)',
    table: 'planned_meals',
    checksUuid: false,
    call: async () =>
      (await import('@/app/api/ai/nutrition-analysis/route')).POST(
        json(`${BASE}/api/ai/nutrition-analysis`, 'POST', { targetDate: TODAY, targetMealType: 'dinner', prompt: '野菜を増やして' }),
      ),
  },
];

beforeEach(() => {
  state.failTable = null;
  state.missingTable = null;
  state.fromTables = [];
});

describe.each(CASES)('$name', ({ table, call, missingStatus = 404, checksUuid = true }) => {
  it('読み込みの DB の失敗は 500 (404 にしない)。DB の生の文面は本文に出さない', async () => {
    state.failTable = table;
    const res = await call(ROW_ID);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(RAW_DB_MESSAGE);
    expect(state.fromTables).toContain(table);
  });

  it(`行が無いときは ${missingStatus}`, async () => {
    state.missingTable = table;
    const res = await call(ROW_ID);
    expect(res.status).toBe(missingStatus);
    expect(state.fromTables).toContain(table);
  });

  if (checksUuid) {
    it(`UUID の形でない id は DB に渡さず ${missingStatus}`, async () => {
      const res = await call(NOT_UUID);
      expect(res.status).toBe(missingStatus);
      expect(state.fromTables).not.toContain(table);
    });
  }
});
