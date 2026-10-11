/**
 * Integration tests:
 *   GET   /api/super-admin/llm/usage
 *   GET   /api/super-admin/llm/quotas
 *   PATCH /api/super-admin/llm/quotas
 *
 * Roles: super_admin only
 * Auth boundary: 403 (admin), 401 (no auth)
 *
 * AI の 1 日の利用回数の上限 (#1149 / T40)。値は DB の ai_daily_limits (プランごと)。AI の利用の判定 (consume_ai_usage) が読む。
 *   - GET は全プランの上限を返す (自分の行が無いプランは free の値)。enforced: true
 *   - PATCH は実在するプランの上限を保存し、監査ログ (super_admin.llm_quota.update) に前と後の値と理由を残す。
 *     保存した値が判定に効くことは tests/integration/rls/ai-daily-limit-rpc.test.ts の「F. プランごとの上限」
 *     (以前の PATCH は 501 で何も保存しなかった。その前は、保存せずに監査ログだけを残していた)
 *   - 上限を変えるのは、ほかのテストが使わないプラン (family_addon) で行い、終わったら元に戻す (free の値は変えない)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUserWithRoles,
  cleanupTestUser,
  cleanupAuditLogs,
  testEmail,
  type TestUser,
} from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';

const TS = Date.now();

let superAdminUser: TestUser;
let adminUser: TestUser;
/** 上限を変えて確かめるプラン (ほかのテストが使わないもの) */
const QUOTA_TEST_PLAN = 'family_addon';
let originalQuotaRow: { plan_key: string; daily_limit: number | null } | null = null;

beforeAll(async () => {
  [superAdminUser, adminUser] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('llm-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('llm-admin', TS), roles: ['admin'] }),
  ]);
  const { data } = await supabaseAdmin.from('ai_daily_limits').select('plan_key, daily_limit').eq('plan_key', QUOTA_TEST_PLAN).maybeSingle();
  originalQuotaRow = data;
}, 60000);

afterAll(async () => {
  // 上限の行を元に戻す (無かったなら消す)
  if (originalQuotaRow) await supabaseAdmin.from('ai_daily_limits').upsert(originalQuotaRow, { onConflict: 'plan_key' });
  else await supabaseAdmin.from('ai_daily_limits').delete().eq('plan_key', QUOTA_TEST_PLAN);

  await Promise.all([
    cleanupAuditLogs(superAdminUser.userId),
    cleanupAuditLogs(adminUser.userId),
  ]);

  await Promise.all([
    cleanupTestUser(superAdminUser.userId),
    cleanupTestUser(adminUser.userId),
  ]);
}, 30000);

// ─────────────────────────────────────────
// GET /api/super-admin/llm/usage
// ─────────────────────────────────────────

describe('GET /api/super-admin/llm/usage', () => {
  it('200 for super_admin fetching LLM usage summary', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/usage?period=7d', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        total_cost_usd: number;
        total_cost_jpy: number;
        total_requests: number;
        total_tokens: number;
        by_model: unknown[];
        by_function: unknown[];
        top_users: unknown[];
        timeseries: unknown[];
        period: { from: string; to: string };
      };
    };
    expect(body.data).toHaveProperty('total_cost_usd');
    expect(body.data).toHaveProperty('total_cost_jpy');
    expect(body.data).toHaveProperty('total_requests');
    expect(body.data).toHaveProperty('total_tokens');
    expect(Array.isArray(body.data.by_model)).toBe(true);
    expect(Array.isArray(body.data.by_function)).toBe(true);
    expect(Array.isArray(body.data.top_users)).toBe(true);
    expect(Array.isArray(body.data.timeseries)).toBe(true);
    expect(body.data.period).toHaveProperty('from');
    expect(body.data.period).toHaveProperty('to');
  });

  it('200 with custom period range', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/llm/usage?period=custom&from=2026-05-01&to=2026-05-08',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
  });

  it('200 with model filter', async () => {
    const res = await apiCall(
      'GET',
      '/api/super-admin/llm/usage?period=30d&model=gpt-4o',
      superAdminUser.jwt
    );
    expect(res.status).toBe(200);
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/usage', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/llm/usage');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// GET /api/super-admin/llm/quotas
// ─────────────────────────────────────────

describe('GET /api/super-admin/llm/quotas', () => {
  it('200 for super_admin: 全プランの上限 (free は 1 日 10 回)。enforced: true', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/quotas', superAdminUser.jwt);
    expect(res.status).toBe(200);
    const body = res.body as {
      data: Array<{ plan_key: string; daily_limit: number | null; configured: boolean; effective_daily_limit: number | null }>;
      default_plan_key: string;
      enforced: boolean;
      note: string;
    };
    expect(body.enforced).toBe(true);
    expect(body.default_plan_key).toBe('free');
    const free = body.data.find((row) => row.plan_key === 'free');
    expect(free).toMatchObject({ configured: true, daily_limit: 10, effective_daily_limit: 10 });
    // subscription_plans のプランは全部出る
    expect(body.data.map((row) => row.plan_key)).toEqual(expect.arrayContaining(['free', 'pro', QUOTA_TEST_PLAN]));
  });

  it('403 for admin', async () => {
    const res = await apiCall('GET', '/api/super-admin/llm/quotas', adminUser.jwt);
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/super-admin/llm/quotas');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────
// PATCH /api/super-admin/llm/quotas
// ─────────────────────────────────────────

describe('PATCH /api/super-admin/llm/quotas', () => {
  const validBody = { plan_key: QUOTA_TEST_PLAN, daily_limit: 7, reason: 'Integration test quota update' };

  it('200 for super_admin: ai_daily_limits に保存し (保存した人も)、GET に出る。監査ログに前と後の値と理由を残す', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, validBody);
    expect(res.status).toBe(200);
    expect((res.body as { data: { plan_key: string; daily_limit: number } }).data).toMatchObject({ plan_key: QUOTA_TEST_PLAN, daily_limit: 7 });

    const { data: saved } = await supabaseAdmin
      .from('ai_daily_limits')
      .select('daily_limit, updated_by')
      .eq('plan_key', QUOTA_TEST_PLAN)
      .single();
    expect(saved).toEqual({ daily_limit: 7, updated_by: superAdminUser.userId });

    const list = await apiCall('GET', '/api/super-admin/llm/quotas', superAdminUser.jwt);
    const row = (list.body as { data: Array<{ plan_key: string; effective_daily_limit: number | null; configured: boolean }> }).data.find(
      (r) => r.plan_key === QUOTA_TEST_PLAN,
    );
    expect(row).toMatchObject({ configured: true, effective_daily_limit: 7 });

    const { data: audits, error } = await supabaseAdmin
      .from('admin_audit_logs')
      .select('details')
      .eq('actor_id', superAdminUser.userId)
      .eq('action_type', 'super_admin.llm_quota.update');
    expect(error).toBeNull();
    expect(audits).toHaveLength(1);
    expect(audits![0].details).toMatchObject({ plan_key: QUOTA_TEST_PLAN, after: { daily_limit: 7 }, reason: validBody.reason });
  });

  it('null は無制限として保存する', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, { ...validBody, daily_limit: null });
    expect(res.status).toBe(200);
    const { data } = await supabaseAdmin.from('ai_daily_limits').select('daily_limit').eq('plan_key', QUOTA_TEST_PLAN).single();
    expect(data?.daily_limit).toBeNull();
  });

  it('400 for super_admin with an invalid body (負の数・理由なし)。保存しない', async () => {
    for (const body of [{ ...validBody, daily_limit: -1 }, { plan_key: QUOTA_TEST_PLAN, daily_limit: 3 }]) {
      const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, body);
      expect(res.status).toBe(400);
    }
  });

  it('404 for a plan that does not exist (行を作らない)', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', superAdminUser.jwt, { ...validBody, plan_key: `no_such_plan_${TS}` });
    expect(res.status).toBe(404);
    const { data } = await supabaseAdmin.from('ai_daily_limits').select('plan_key').eq('plan_key', `no_such_plan_${TS}`);
    expect(data).toEqual([]);
  });

  it('403 for admin', async () => {
    const res = await apiCall('PATCH', '/api/super-admin/llm/quotas', adminUser.jwt, { ...validBody, reason: 'Admin should fail' });
    expect(res.status).toBe(403);
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('PATCH', '/api/super-admin/llm/quotas', { ...validBody, reason: 'No auth' });
    expect(res.status).toBe(401);
  });
});
