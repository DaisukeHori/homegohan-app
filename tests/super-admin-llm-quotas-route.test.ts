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
 *   - #1912: 組織のプランの値 (ORG_PLAN_VALUES = standard / premium / enterprise。subscription_plans に無いキー) も
 *     GET に出し (plan_source: 'org_plan'・表示名「<値>（組織のプラン）」)、PATCH で保存できる。どちらにも無いキーは 404 のまま、
 *     GET では plan_source: 'unknown' (画面は保存させない)
 *   - #1912: subscription_plans の組織のプランの行 (plan_type = 'org' の org_*) は、値が判定に使われない
 *     (組織の利用者の上限は ORG_PLAN_VALUES の行で決まる) ので、PATCH は 409 PLAN_READ_ONLY で断る (保存しない・監査ログを書かない)
 * 実 DB での確認は tests/integration/operator/super-admin-llm.test.ts と tests/integration/rls/ai-daily-limit-rpc.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { AI_DAILY_LIMIT_MAX, LLM_QUOTAS_ENFORCED_NOTE } from '@/lib/super-admin/llm-schemas';
import {
  AI_DAILY_LIMIT_READ_ONLY_NOTES,
  LLM_QUOTA_AUDIT_ACTION,
  PLAN_READ_ONLY_CODE,
  PLAN_READ_ONLY_MESSAGE,
  aiDailyLimitRowReadOnlyReason,
  buildAiDailyLimitRows,
  isAiDailyLimitRowEditable,
  isOrgSubscriptionPlanRow,
} from '@/lib/super-admin/ai-daily-limits';
import { ORG_PLAN_VALUES } from '@/lib/org-plans';

const requireRole = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
  limits: [] as Array<Record<string, unknown>>,
  /** 表ごとの読み取りのエラー */
  readError: {} as Record<string, { message: string; code?: string } | undefined>,
  /** ai_daily_limits への書き込み (update / upsert) が返すエラー */
  writeError: null as { message: string } | null,
  /** 2 回目以降の ai_daily_limits の読み取り (0 行のあとの読み直し) が返すエラー */
  rereadError: null as { message: string; code?: string } | null,
  upserts: [] as Array<{ table: string; values: Record<string, unknown>; options: unknown }>,
  updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, 'eq' | 'is', unknown]> }>,
  audits: [] as Array<Record<string, unknown>>,
  /** subscription_plans を plan_key で 1 行引いた回数 (PATCH の存在の確認) */
  planLookups: 0,
  /** ai_daily_limits を読んだ回数 (1 回目 = 保存の前の読み、2 回目 = 0 行のあとの読み直し) */
  limitReads: 0,
  /** ai_daily_limits への書き込みを DB に送る直前に 1 回だけ実行する (読んでから書くまでの別の運営の操作の再現) */
  beforeWrite: null as (() => void) | null,
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

const SAVED_COLUMNS = ['plan_key', 'daily_limit', 'updated_at'] as const;
const savedRow = (row: Record<string, unknown>) => Object.fromEntries(SAVED_COLUMNS.map((column) => [column, row[column]]));

/** service_role のクライアントの作り物 (subscription_plans と ai_daily_limits)。PostgREST と同じく eq は NULL に一致しない */
function adminQuery(table: string) {
  const filters: Array<[string, 'eq' | 'is', unknown]> = [];
  const matches = (row: Record<string, unknown>) =>
    filters.every(([key, kind, value]) => (kind === 'is' ? row[key] === null : row[key] !== null && row[key] === value));
  const rows = () => (table === 'subscription_plans' ? db.plans : db.limits).filter(matches);
  let op: 'select' | 'update' | 'upsert' = 'select';
  let payload: Record<string, unknown> = {};
  let upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};

  const write = async () => {
    const interleave = db.beforeWrite;
    if (interleave) {
      db.beforeWrite = null;
      interleave();
    }
    if (db.writeError) return { data: null, error: db.writeError };
    if (op === 'update') {
      const targets = rows();
      for (const row of targets) Object.assign(row, payload);
      return { data: targets[0] ? savedRow(targets[0]) : null, error: null };
    }
    const existing = db.limits.find((row) => row.plan_key === payload.plan_key);
    if (existing) {
      // ON CONFLICT DO NOTHING: 作れなかった行は返らない
      if (upsertOptions.ignoreDuplicates) return { data: null, error: null };
      Object.assign(existing, payload);
      return { data: savedRow(existing), error: null };
    }
    db.limits.push({ ...payload });
    return { data: savedRow(payload), error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    eq: (key: string, value: unknown) => {
      filters.push([key, 'eq', value]);
      return builder;
    },
    is: (key: string, value: null) => {
      filters.push([key, 'is', value]);
      return builder;
    },
    update: (values: Record<string, unknown>) => {
      op = 'update';
      payload = values;
      db.updates.push({ table, values, filters });
      return builder;
    },
    upsert: (values: Record<string, unknown>, options: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      op = 'upsert';
      payload = values;
      upsertOptions = options;
      db.upserts.push({ table, values, options });
      return builder;
    },
    maybeSingle: async () => {
      if (op !== 'select') return write();
      if (table === 'subscription_plans') db.planLookups += 1;
      if (table === 'ai_daily_limits') {
        db.limitReads += 1;
        if (db.limitReads > 1 && db.rereadError) return { data: null, error: db.rereadError };
      }
      // PostgREST と同じく、返すのは行の写し (あとで行が書き換わっても、読んだ値は変わらない)
      const found = rows()[0];
      return { data: found ? { ...found } : null, error: db.readError[table] ?? null };
    },
    then: (resolve: (value: unknown) => unknown) =>
      resolve({ data: rows().map((row) => ({ ...row })), error: db.readError[table] ?? null }),
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
  db.writeError = null;
  db.rereadError = null;
  db.upserts = [];
  db.updates = [];
  db.audits = [];
  db.planLookups = 0;
  db.limitReads = 0;
  db.beforeWrite = null;
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
      { plan_key: 'free', plan_source: 'subscription_plan', display_name: 'Free', plan_type: 'personal', daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-11T00:00:00Z' },
      { plan_key: 'pro', plan_source: 'subscription_plan', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
      { plan_key: 'org_enterprise', plan_source: 'subscription_plan', display_name: 'Org Enterprise', plan_type: 'org', daily_limit: null, configured: true, effective_daily_limit: null, updated_at: '2026-10-11T00:00:00Z' },
      // 組織のプランの値 (#1912)。ai_daily_limits に行が無くても出す (保存すると行を作る)
      { plan_key: 'standard', plan_source: 'org_plan', display_name: 'standard（組織のプラン）', plan_type: null, daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
      { plan_key: 'premium', plan_source: 'org_plan', display_name: 'premium（組織のプラン）', plan_type: null, daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
      { plan_key: 'enterprise', plan_source: 'org_plan', display_name: 'enterprise（組織のプラン）', plan_type: null, daily_limit: null, configured: false, effective_daily_limit: 10, updated_at: null },
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
  it('実在するプランの上限を保存し (行が無ければ作る・保存した人)、保存した行を返す。監査ログに前と後の値と理由を残す', async () => {
    const res = await PATCH(patch({ plan_key: 'pro', daily_limit: 20, reason: '有料の検証' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ plan_key: 'pro', daily_limit: 20 });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      table: 'ai_daily_limits',
      values: { plan_key: 'pro', daily_limit: 20, updated_by: ADMIN_ID },
      // 読んだときに行が無かったので作るだけ (読んでから書くまでに別の運営が作っていたら何もしない)
      options: { onConflict: 'plan_key', ignoreDuplicates: true },
    });
    expect(db.updates).toEqual([]);
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

  it('無制限 (null) と 0 (その日は使えない) も保存できる。前の値を監査ログに残す (行があれば、読んだ値のままのときだけ更新する)', async () => {
    expect((await PATCH(patch({ plan_key: 'free', daily_limit: null, reason: '一時的に外す' }))).status).toBe(200);
    expect(db.updates[0].values).toMatchObject({ daily_limit: null, updated_by: ADMIN_ID });
    expect(db.updates[0].filters).toEqual([
      ['plan_key', 'eq', 'free'],
      ['daily_limit', 'eq', 10],
    ]);
    expect(db.audits[0].details).toMatchObject({ before: { daily_limit: 10 }, after: { daily_limit: null } });

    expect((await PATCH(patch({ plan_key: 'free', daily_limit: 0, reason: '止める' }))).status).toBe(200);
    expect(db.updates[1].values).toMatchObject({ daily_limit: 0 });
    // 読んだ値が NULL (無制限) のときは .is で比べる (PostgREST の eq.null は NULL に一致しない)
    expect(db.updates[1].filters).toEqual([
      ['plan_key', 'eq', 'free'],
      ['daily_limit', 'is', null],
    ]);
    expect(db.audits[1].details).toMatchObject({ before: { daily_limit: null }, after: { daily_limit: 0 } });
    expect(db.limits.find((row) => row.plan_key === 'free')?.daily_limit).toBe(0);
    expect(db.upserts).toEqual([]);
  });

  it.each(ORG_PLAN_VALUES)(
    '#1912: 組織のプランの値 %s (subscription_plans に無い) も 200 で保存する。行が無ければ作り、監査ログは今と同じ形',
    async (planKey) => {
      const res = await PATCH(patch({ plan_key: planKey, daily_limit: 15, reason: '組織の上限を変える' }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toMatchObject({ plan_key: planKey, daily_limit: 15 });
      expect(db.upserts).toEqual([
        expect.objectContaining({
          table: 'ai_daily_limits',
          values: expect.objectContaining({ plan_key: planKey, daily_limit: 15, updated_by: ADMIN_ID }),
          options: { onConflict: 'plan_key', ignoreDuplicates: true },
        }),
      ]);
      expect(db.audits).toEqual([
        expect.objectContaining({
          actor_id: ADMIN_ID,
          action_type: LLM_QUOTA_AUDIT_ACTION,
          target_type: 'ai_daily_limit',
          details: { plan_key: planKey, before: null, after: { daily_limit: 15 }, reason: '組織の上限を変える' },
        }),
      ]);
      // 組織のプランの値は subscription_plans で存在を確かめない (そこに無いのが正しい)
      expect(db.planLookups).toBe(0);
    },
  );

  it('#1912: 組織のプランの値の行が既にあれば、前の値を監査ログに残して上書きする。値の範囲の検査は同じ (超えれば 400)', async () => {
    db.limits.push({ plan_key: 'premium', daily_limit: 10, updated_at: '2026-10-21T00:00:00Z' });

    expect((await PATCH(patch({ plan_key: 'premium', daily_limit: null, reason: '無制限に' }))).status).toBe(200);
    expect(db.audits[0].details).toMatchObject({ plan_key: 'premium', before: { daily_limit: 10 }, after: { daily_limit: null } });

    const over = await PATCH(patch({ plan_key: 'premium', daily_limit: AI_DAILY_LIMIT_MAX + 1, reason: 'x' }));
    expect(over.status).toBe(400);
    expect(db.updates).toHaveLength(1);
    expect(db.upserts).toEqual([]);
  });

  it('#1912: 組織のプランの値でも、super_admin でなければ拒む (未認証 401・権限なし 403・保存しない)', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await PATCH(patch({ plan_key: 'standard', daily_limit: 1, reason: 'x' }))).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await PATCH(patch({ plan_key: 'enterprise', daily_limit: 1, reason: 'x' }))).status).toBe(403);

    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
    expect(db.upserts).toEqual([]);
    expect(db.audits).toEqual([]);
  });

  it.each(['Standard', 'org_premium', 'standard_x'])(
    '#1912: 組織のプランの値に似ただけのキー (%s) は、subscription_plans に無ければ 404 のまま (行を作らない)',
    async (planKey) => {
      const res = await PATCH(patch({ plan_key: planKey, daily_limit: 5, reason: 'x' }));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('PLAN_NOT_FOUND');
      expect(db.planLookups).toBe(1);
      expect(db.upserts).toEqual([]);
      expect(db.audits).toEqual([]);
    },
  );

  it.each(['org_starter', 'org_standard', 'org_pro', 'org_enterprise'])(
    '#1912: subscription_plans の組織のプランの行 (%s。plan_type = org) は 409 PLAN_READ_ONLY で断る。保存しない・監査ログを書かない',
    async (planKey) => {
      db.plans.push(
        ...['org_starter', 'org_standard', 'org_pro']
          .filter((key) => !db.plans.some((plan) => plan.plan_key === key))
          .map((key) => ({ plan_key: key, display_name: key, plan_type: 'org' })),
      );

      const res = await PATCH(patch({ plan_key: planKey, daily_limit: 5, reason: '組織の上限を変えるつもり' }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toEqual({ code: PLAN_READ_ONLY_CODE, message: PLAN_READ_ONLY_MESSAGE });
      expect(json.error.message).toContain('standard / premium / enterprise');
      expect(db.planLookups).toBe(1);
      expect(db.upserts).toEqual([]);
      expect(db.audits).toEqual([]);
    },
  );

  it('#1912: org_* を断っても、組織のプランの値 (standard) と個人のプランはそのまま保存できる', async () => {
    expect((await PATCH(patch({ plan_key: 'org_enterprise', daily_limit: 5, reason: 'x' }))).status).toBe(409);
    expect((await PATCH(patch({ plan_key: 'standard', daily_limit: 5, reason: '組織の上限' }))).status).toBe(200);
    expect((await PATCH(patch({ plan_key: 'pro', daily_limit: 5, reason: '個人の上限' }))).status).toBe(200);

    expect(db.upserts.map((upsert) => upsert.values.plan_key)).toEqual(['standard', 'pro']);
    expect(db.audits.map((audit) => (audit.details as { plan_key: string }).plan_key)).toEqual(['standard', 'pro']);
  });

  it('#1912: 組織のプランの値が subscription_plans に plan_type = org で同じキーであっても、判定に使われる値なので保存できる', async () => {
    db.plans.push({ plan_key: 'premium', display_name: 'Premium', plan_type: 'org' });

    const res = await PATCH(patch({ plan_key: 'premium', daily_limit: 8, reason: '組織の上限' }));

    expect(res.status).toBe(200);
    expect(db.upserts).toHaveLength(1);
    expect(db.audits).toHaveLength(1);
  });

  it('#1912: 個人・家族のプランの行 (plan_type が org でない) は断らない', async () => {
    db.plans.push({ plan_key: 'family_basic', display_name: 'Family Basic', plan_type: 'family' });

    expect((await PATCH(patch({ plan_key: 'family_basic', daily_limit: 30, reason: '家族の上限' }))).status).toBe(200);
    expect(db.upserts.map((upsert) => upsert.values.plan_key)).toEqual(['family_basic']);
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
    db.writeError = { message: 'permission denied for table ai_daily_limits' };

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

describe('PATCH /api/super-admin/llm/quotas: 同時の保存 (読んでから書くまでに別の運営が変えた)', () => {
  const limitOf = (planKey: string) => db.limits.find((row) => row.plan_key === planKey);
  const otherOperatorSets = (planKey: string, dailyLimit: number | null) => () => {
    const row = limitOf(planKey);
    if (row) row.daily_limit = dailyLimit;
    else db.limits.push({ plan_key: planKey, daily_limit: dailyLimit, updated_at: '2026-10-23T00:00:00Z' });
  };

  it('409 CONFLICT_STALE_DATA: 行があり、別の運営が違う値へ先に変えた。上書きせず、記録しない (監査の before を古い値にしない)', async () => {
    db.beforeWrite = otherOperatorSets('free', 30);
    const res = await PATCH(patch({ plan_key: 'free', daily_limit: 20, reason: 'x' }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('CONFLICT_STALE_DATA');
    expect(json.error.message).toContain('読み込み直して');
    expect(limitOf('free')?.daily_limit).toBe(30);
    expect(db.updates[0].filters).toEqual([
      ['plan_key', 'eq', 'free'],
      ['daily_limit', 'eq', 10],
    ]);
    expect(db.audits).toEqual([]);
  });

  it('409: 行が無く、別の運営が違う値で先に作った。上書きせず、記録しない', async () => {
    db.beforeWrite = otherOperatorSets('pro', 7);
    const res = await PATCH(patch({ plan_key: 'pro', daily_limit: 20, reason: 'x' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CONFLICT_STALE_DATA');
    expect(limitOf('pro')?.daily_limit).toBe(7);
    expect(db.audits).toEqual([]);
  });

  it('409: 行があったが、読んでから書くまでに消えた。作り直さず、記録しない', async () => {
    db.beforeWrite = () => {
      db.limits = db.limits.filter((row) => row.plan_key !== 'free');
    };
    const res = await PATCH(patch({ plan_key: 'free', daily_limit: 20, reason: 'x' }));
    expect(res.status).toBe(409);
    expect(limitOf('free')).toBeUndefined();
    expect(db.audits).toEqual([]);
  });

  it.each([
    ['行があった', 'free', 20],
    ['行が無かった', 'pro', 20],
    ['無制限 (null) へ', 'free', null],
  ] as const)('200: %s。別の運営が同じ値を先に保存していたら、書かず記録もしない (今の行を返す)', async (_label, planKey, dailyLimit) => {
    db.beforeWrite = otherOperatorSets(planKey, dailyLimit);
    const res = await PATCH(patch({ plan_key: planKey, daily_limit: dailyLimit, reason: 'x' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ plan_key: planKey, daily_limit: dailyLimit });
    expect(db.audits).toEqual([]);
  });

  it('続けて送り直すと、読み直した今の値 (先の運営の変更) を before として記録する', async () => {
    db.beforeWrite = otherOperatorSets('free', 30);
    expect((await PATCH(patch({ plan_key: 'free', daily_limit: 20, reason: 'x' }))).status).toBe(409);
    expect((await PATCH(patch({ plan_key: 'free', daily_limit: 20, reason: 'y' }))).status).toBe(200);
    expect(limitOf('free')?.daily_limit).toBe(20);
    expect(db.audits.map((audit) => audit.details)).toEqual([
      { plan_key: 'free', before: { daily_limit: 30 }, after: { daily_limit: 20 }, reason: 'y' },
    ]);
  });

  it('500: 0 行のあとの読み直しに失敗した。汎用の文だけを返し、記録しない', async () => {
    db.beforeWrite = otherOperatorSets('free', 30);
    db.rereadError = { message: 'connection reset by peer', code: '08006' };
    const res = await PATCH(patch({ plan_key: 'free', daily_limit: 20, reason: 'x' }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('connection reset');
    expect(db.audits).toEqual([]);
  });
});

describe('buildAiDailyLimitRows: 一覧の組み立て', () => {
  it('free の行も無ければ、行の無いプランは無制限。組織のプランの値を次に、どちらにも無いキーの行を最後に出す (unknown は保存できない)', () => {
    const rows = buildAiDailyLimitRows(
      [{ plan_key: 'pro', display_name: 'Pro', plan_type: 'personal' }],
      [
        { plan_key: 'legacy_plan', daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' },
        { plan_key: 'premium', daily_limit: 10, updated_at: '2026-10-21T00:00:00Z' },
      ],
    );
    expect(rows).toEqual([
      { plan_key: 'pro', plan_source: 'subscription_plan', display_name: 'Pro', plan_type: 'personal', daily_limit: null, configured: false, effective_daily_limit: null, updated_at: null },
      { plan_key: 'standard', plan_source: 'org_plan', display_name: 'standard（組織のプラン）', plan_type: null, daily_limit: null, configured: false, effective_daily_limit: null, updated_at: null },
      { plan_key: 'premium', plan_source: 'org_plan', display_name: 'premium（組織のプラン）', plan_type: null, daily_limit: 10, configured: true, effective_daily_limit: 10, updated_at: '2026-10-21T00:00:00Z' },
      { plan_key: 'enterprise', plan_source: 'org_plan', display_name: 'enterprise（組織のプラン）', plan_type: null, daily_limit: null, configured: false, effective_daily_limit: null, updated_at: null },
      { plan_key: 'legacy_plan', plan_source: 'unknown', display_name: null, plan_type: null, daily_limit: 3, configured: true, effective_daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' },
    ]);
    expect(rows.map((row) => isAiDailyLimitRowEditable(row))).toEqual([true, true, true, true, false]);
  });

  it('#1912: 組織のプランの値が subscription_plans にもあれば、プランの表の行として 1 回だけ出す (重ねない)', () => {
    const rows = buildAiDailyLimitRows([{ plan_key: 'standard', display_name: 'Standard', plan_type: 'org' }], []);
    expect(rows.map((row) => [row.plan_key, row.plan_source, row.display_name])).toEqual([
      ['standard', 'subscription_plan', 'Standard'],
      ['premium', 'org_plan', 'premium（組織のプラン）'],
      ['enterprise', 'org_plan', 'enterprise（組織のプラン）'],
    ]);
  });

  it('#1912: subscription_plans の組織のプランの行 (org_*) は保存できない行になり、理由ごとの案内がある。組織のプランの値は保存できる', () => {
    const rows = buildAiDailyLimitRows(
      [
        { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal' },
        { plan_key: 'family_basic', display_name: 'Family Basic', plan_type: 'family' },
        { plan_key: 'org_standard', display_name: 'Org Standard', plan_type: 'org' },
        { plan_key: 'org_enterprise', display_name: 'Org Enterprise', plan_type: 'org' },
      ],
      [{ plan_key: 'legacy_plan', daily_limit: 3, updated_at: '2026-10-11T00:00:00Z' }],
    );

    expect(rows.map((row) => [row.plan_key, aiDailyLimitRowReadOnlyReason(row), isAiDailyLimitRowEditable(row)])).toEqual([
      ['pro', null, true],
      ['family_basic', null, true],
      ['org_standard', 'org_subscription_plan', false],
      ['org_enterprise', 'org_subscription_plan', false],
      ['standard', null, true],
      ['premium', null, true],
      ['enterprise', null, true],
      ['legacy_plan', 'unknown_key', false],
    ]);
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.org_subscription_plan).toContain('組織の上限は standard / premium / enterprise の行で決まります');
    expect(AI_DAILY_LIMIT_READ_ONLY_NOTES.unknown_key).toContain('保存できません');
  });

  it('#1912: 組織のプランの値が plan_type = org で subscription_plans にあっても、保存できる行のまま (PATCH と同じ判定)', () => {
    const rows = buildAiDailyLimitRows([{ plan_key: 'standard', display_name: 'Standard', plan_type: 'org' }], []);
    expect(rows.map((row) => [row.plan_key, row.plan_source, isAiDailyLimitRowEditable(row)])).toEqual([
      ['standard', 'subscription_plan', true],
      ['premium', 'org_plan', true],
      ['enterprise', 'org_plan', true],
    ]);
    expect(isOrgSubscriptionPlanRow({ plan_key: 'standard', plan_type: 'org' })).toBe(false);
    expect(isOrgSubscriptionPlanRow({ plan_key: 'org_pro', plan_type: 'org' })).toBe(true);
    expect(isOrgSubscriptionPlanRow({ plan_key: 'org_pro', plan_type: null })).toBe(false);
    expect(isOrgSubscriptionPlanRow({ plan_key: 'pro', plan_type: 'personal' })).toBe(false);
  });
});
