/**
 * #1149 (T40): GET / PATCH /api/super-admin/llm/quotas (AI の 1 日の利用回数の上限。プランごと)
 *
 *   - 以前の GET はコードに直接書いた目安を返すだけで、PATCH は保存せずに 501 を返していた (保存できない見せかけの管理画面)。
 *   - いまは DB の ai_daily_limits を読み書きする。保存した値は、AI を使う入口の判定 (consume_ai_usage) が次の利用から読む。
 *   - GET: subscription_plans の全プランと ai_daily_limits の行を合わせて返す。自分の行が無いプランは free の値 (effective_daily_limit)。
 *     enforced: true
 *   - PATCH: { plan_key, daily_limit (null は無制限), reason } を検証し、実在するプランだけを保存 (upsert) する。
 *     監査ログ (super_admin.llm_quota.update) に前と後の値と理由を残す。存在しないプランは 404、入力の誤りは 400
 *   - どちらも super_admin だけ (未認証 401・権限なし 403)。DB のエラーは汎用の 500 (本文に DB の文を出さない)
 * 実 DB での確認は tests/integration/operator/super-admin-llm.test.ts と tests/integration/rls/ai-daily-limit-rpc.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { AI_DAILY_LIMIT_MAX, LLM_QUOTAS_ENFORCED_NOTE } from '@/lib/super-admin/llm-schemas';
import { LLM_QUOTA_AUDIT_ACTION, buildAiDailyLimitRows } from '@/lib/super-admin/ai-daily-limits';

const requireRole = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
  limits: [] as Array<Record<string, unknown>>,
  /** 表ごとの読み取りのエラー */
  readError: {} as Record<string, { message: string; code?: string } | undefined>,
  upsertError: null as { message: string } | null,
  upserts: [] as Array<{ table: string; values: Record<string, unknown>; options: unknown }>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

/** service_role のクライアントの作り物 (subscription_plans と ai_daily_limits) */
function adminQuery(table: string) {
  const filters: Record<string, unknown> = {};
  const rows = () => {
    const source = table === 'subscription_plans' ? db.plans : db.limits;
    return source.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
  };
  let upserted: Record<string, unknown> | null = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    eq: (key: string, value: unknown) => {
      filters[key] = value;
      return builder;
    },
    upsert: (values: Record<string, unknown>, options: unknown) => {
      db.upserts.push({ table, values, options });
      upserted = values;
      return builder;
    },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: db.readError[table] ?? null }),
    single: async () =>
      db.upsertError
        ? { data: null, error: db.upsertError }
        : { data: { plan_key: upserted?.plan_key, daily_limit: upserted?.daily_limit, updated_at: upserted?.updated_at }, error: null },
    then: (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: db.readError[table] ?? null }),
  };
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => adminQuery(table) }),
  // 監査ログはログインした本人の権限で書く
  createClient: async () => ({
    from: (table: string) => ({
      insert: async (values: Record<string, unknown>) => {
        if (table === 'admin_audit_logs') db.audits.push(values);
        return { error: null };
      },
    }),
  }),
}));

vi.mock('@/lib/db-logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => ({ ...logger, withUser: () => logger })), generateRequestId: vi.fn(() => 'req_test') };
});

import { GET, PATCH } from '../src/app/api/super-admin/llm/quotas/route';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';

function patch(body: unknown): Request {
  return new Request('http://localhost/api/super-admin/llm/quotas', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['super_admin'] });
  db.plans = [
    { plan_key: 'free', display_name: 'Free', plan_type: 'personal' },
    { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal' },
    { plan_key: 'org_enterprise', display_name: 'Org Enterprise', plan_type: 'org' },
  ];
  db.limits = [
    { plan_key: 'free', daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
    { plan_key: 'org_enterprise', daily_limit: null, updated_at: '2026-10-11T00:00:00Z' },
  ];
  db.readError = {};
  db.upsertError = null;
  db.upserts = [];
  db.audits = [];
});

describe('GET /api/super-admin/llm/quotas', () => {
  it('全プランの上限を返す。自分の行が無いプランは free の値。enforced: true と説明を付ける', async () => {
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(json.enforced).toBe(true);
    expect(json.note).toBe(LLM_QUOTAS_ENFORCED_NOTE);
    expect(json.default_plan_key).toBe('free');
    expect(json.data).toEqual([
      { plan_key: 'free', display_name: 'Free', plan_type: 'personal', daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
      { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
      { plan_key: 'org_enterprise', display_name: 'Org Enterprise', plan_type: 'org', daily_limit: null, configured: true, effective_daily_limit: null, updated_at: '2026-10-11T00:00:00Z' },
    ]);
  });

  it('DB の読み取りに失敗したら、汎用の 500 (DB の文を本文に出さない)', async () => {
    db.readError.ai_daily_limits = { message: 'relation "ai_daily_limits" does not exist', code: '42P01' };

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('ai_daily_limits');
  });

  it('未認証は 401、権限が無ければ 403', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET()).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET()).status).toBe(403);
  });
});

describe('PATCH /api/super-admin/llm/quotas', () => {
  it('実在するプランの上限を保存し (upsert・保存した人)、保存した行を返す。監査ログに前と後の値と理由を残す', async () => {
    const res = await PATCH(patch({ plan_key: 'pro', daily_limit: 20, reason: '有料の検証' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ plan_key: 'pro', daily_limit: 20 });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      table: 'ai_daily_limits',
      values: { plan_key: 'pro', daily_limit: 20, updated_by: ADMIN_ID },
      options: { onConflict: 'plan_key' },
    });
    expect(db.audits).toEqual([
      expect.objectContaining({
        actor_id: ADMIN_ID,
        action_type: LLM_QUOTA_AUDIT_ACTION,
        target_type: 'ai_daily_limit',
        details: { plan_key: 'pro', before: null, after: { daily_limit: 20 }, reason: '有料の検証' },
        ip_address: '203.0.113.5',
      }),
    ]);
  });

  it('無制限 (null) と 0 (その日は使えない) も保存できる。前の値を監査ログに残す', async () => {
    expect((await PATCH(patch({ plan_key: 'free', daily_limit: null, reason: '一時的に外す' }))).status).toBe(200);
    expect(db.upserts[0].values).toMatchObject({ plan_key: 'free', daily_limit: null });
    expect(db.audits[0].details).toMatchObject({ before: { daily_limit: 10 }, after: { daily_limit: null } });

    expect((await PATCH(patch({ plan_key: 'free', daily_limit: 0, reason: '止める' }))).status).toBe(200);
    expect(db.upserts[1].values).toMatchObject({ daily_limit: 0 });
  });

  it('存在しないプランは 404 (行を作らない・監査ログも残さない)', async () => {
    const res = await PATCH(patch({ plan_key: 'no_such_plan', daily_limit: 5, reason: '打ち間違い' }));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('PLAN_NOT_FOUND');
    expect(db.upserts).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it.each([
    ['負の数', { plan_key: 'free', daily_limit: -1, reason: 'x' }],
    ['小数', { plan_key: 'free', daily_limit: 1.5, reason: 'x' }],
    ['上限を超える', { plan_key: 'free', daily_limit: AI_DAILY_LIMIT_MAX + 1, reason: 'x' }],
    ['数値でない', { plan_key: 'free', daily_limit: '10', reason: 'x' }],
    ['daily_limit が無い', { plan_key: 'free', reason: 'x' }],
    ['理由が空', { plan_key: 'free', daily_limit: 10, reason: '  ' }],
    ['プランが空', { plan_key: '', daily_limit: 10, reason: 'x' }],
    ['本文が JSON でない', null],
  ])('入力の誤り (%s) は 400 VALIDATION_ERROR。保存しない', async (_label, body) => {
    const req =
      body === null
        ? new Request('http://localhost/api/super-admin/llm/quotas', { method: 'PATCH', body: 'not json' })
        : patch(body);
    const res = await PATCH(req);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(db.upserts).toEqual([]);
  });

  it('保存に失敗したら、汎用の 500 (DB の文を本文に出さない)・監査ログを残さない', async () => {
    db.upsertError = { message: 'permission denied for table ai_daily_limits' };

    const res = await PATCH(patch({ plan_key: 'pro', daily_limit: 20, reason: 'x' }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain('permission denied');
    expect(db.audits).toEqual([]);
  });

  it('未認証は 401、権限が無ければ 403 (保存しない)', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await PATCH(patch({ plan_key: 'pro', daily_limit: 1, reason: 'x' }))).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await PATCH(patch({ plan_key: 'pro', daily_limit: 1, reason: 'x' }))).status).toBe(403);

    expect(db.upserts).toEqual([]);
  });
});

describe('buildAiDailyLimitRows: 一覧の組み立て', () => {
  it('free の行も無ければ、行の無いプランは無制限。プランの表に無いキーの行も最後に出す', () => {
    const rows = buildAiDailyLimitRows(
      [{ plan_key: 'pro', display_name: 'Pro', plan_type: 'personal' }],
      [{ plan_key: 'legacy_plan', daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' }],
    );
    expect(rows).toEqual([
      { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: null, updated_at: null },
      { plan_key: 'legacy_plan', display_name: null, plan_type: null, daily_limit: 3, configured: true, effective_daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' },
    ]);
  });
});
