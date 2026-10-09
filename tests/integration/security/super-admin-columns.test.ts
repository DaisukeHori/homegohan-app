/**
 * 運営画面の API が実際の DB の列・表に合っていることの回帰テスト (#1306 #1126)
 *   /api/super-admin/exports, /api/super-admin/exports/[id]   データエクスポート (準備中。全メソッド 501)
 *   GET    /api/super-admin/llm/usage                           LLM 使用量
 *
 * 修正前は、存在しない列を読んで・更新していた。
 *   - エクスポートは、専用の表が無く、利用者本人の GDPR 削除要求の表 (gdpr_deletion_requests) を代用していた。
 *     その表に status 列は無い (状態は cancelled_at / executed_at で表す)。status を select / update していたため
 *     PostgREST が 42703 / PGRST204 で失敗し、error を見ていなかったので、どの id を指定しても 404 だった (#1306)。
 *     #1306 の修正で動くようになった DELETE (キャンセル) は、実在する本人の削除要求に cancelled_at を入れて
 *     取り消してしまうため、エクスポートのつもりで本人の削除要求を止める事故につながる。
 *     オーナー判断 (2026-10-08) で、エクスポートは直さず「準備中（未対応）」にした (#1126)。
 *     全メソッドが 501 OP_NOT_SUPPORTED を返し、この表には触れない。
 *   - llm_usage_logs に prompt_tokens / completion_tokens / cost_usd は無い
 *     (実際は input_tokens / output_tokens / estimated_cost_usd)。42703 で失敗し、常に 500 だった。
 * 単体テストは Supabase をモックして列の有無を見ないため、検出できなかった。
 * ここでは実際の Next サーバーと実 DB (ローカル Supabase) の組み合わせで確かめる。
 *
 *   E-1: GET は 501。本人の削除要求は変わらない
 *   E-2: DELETE (キャンセル) は 501。本人の GDPR 削除要求を取り消さない (cancelled_at が入らず、監査ログも残らない)
 *   E-3: 実行済みの要求でも 501 (422 にしない)。何も変わらない
 *   E-4: POST (依頼) は 501。GDPR 削除要求の表に行を作らない。存在しない id・UUID でない id も 501
 *   E-5: super_admin 以外は 403、未認証は 401。本人の削除要求は変わらない
 *   L-1: LLM 使用量は 200 で返り、LLM 呼び出しごとの行だけを集計する (実行ごとの合計行を二重に数えない)
 *   L-2: プロバイダー・モデルで絞り込める
 *   L-3: super_admin 以外は 403、未認証は 401
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/super-admin-columns.test.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { supabaseAdmin as srAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { cleanupAuditLogs, cleanupTestUser, createTestUserWithRoles, testEmail, type TestUser } from '../helpers/users';

const TS = Date.now();
/** この実行の LLM 使用量の行を、他のデータと分けて集計するための機能名 */
const FUNCTION_NAME = `it-1306-${TS}`;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let superAdmin: TestUser;
let plainAdmin: TestUser;
let subject: TestUser;
const gdprIds: string[] = [];

interface ExportBody {
  data?: unknown;
  error?: { code?: string; message?: string };
}

interface UsageBody {
  data?: {
    total_cost_usd: number;
    total_requests: number;
    total_tokens: number;
    by_model: Array<{ model: string; provider: string; requests: number; tokens: number; cost_usd: number }>;
    by_function: Array<{ function: string; requests: number; cost_usd: number }>;
  };
  error?: { code?: string; message?: string };
}

async function insertGdprRequest(overrides: Record<string, unknown> = {}) {
  const { data, error } = await srAdmin
    .from('gdpr_deletion_requests')
    .insert({ user_id: subject.userId, ...overrides })
    .select('id, requested_at, cancelled_at, executed_at')
    .single();
  if (error || !data) throw new Error(`gdpr_deletion_requests insert: ${error?.message}`);
  gdprIds.push(data.id as string);
  return data as { id: string; requested_at: string; cancelled_at: string | null; executed_at: string | null };
}

async function gdprRow(id: string) {
  const { data, error } = await srAdmin
    .from('gdpr_deletion_requests')
    .select('id, cancelled_at, executed_at')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`gdpr_deletion_requests select: ${error?.message}`);
  return data as { id: string; cancelled_at: string | null; executed_at: string | null };
}

async function gdprRowCount(userId: string) {
  const { count, error } = await srAdmin
    .from('gdpr_deletion_requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(`gdpr_deletion_requests count: ${error.message}`);
  return count ?? 0;
}

async function cancelAuditLogs(targetId: string) {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('id, actor_id, action_type, target_type, details')
    .eq('target_id', targetId);
  if (error) throw new Error(`admin_audit_logs select: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    actor_id: string;
    action_type: string;
    target_type: string;
    details: { action?: string; subject_user_id?: string };
  }>;
}

beforeAll(async () => {
  [superAdmin, plainAdmin, subject] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('sa-cols-sa', TS), roles: ['super_admin'] }),
    createTestUserWithRoles({ email: testEmail('sa-cols-admin', TS), roles: ['admin'] }),
    createTestUserWithRoles({ email: testEmail('sa-cols-subject', TS), roles: ['user'] }),
  ]);

  // LLM 呼び出しごとの行 3 件 (gpt-5-mini 2 回 + grok 1 回) と、それらの実行ごとの合計行 1 件。
  // Edge Function (supabase/functions/_shared/llm-usage.ts) は実行のたびにこの形で入れる。
  const executionId = randomUUID();
  const base = {
    function_name: FUNCTION_NAME,
    execution_id: executionId,
    user_id: subject.userId,
    success: true,
  };
  const { error } = await srAdmin.from('llm_usage_logs').insert([
    {
      ...base,
      provider: 'openai',
      endpoint: '/v1/chat/completions',
      model: 'gpt-5-mini',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      estimated_cost_usd: 0.5,
      is_summary: false,
    },
    {
      ...base,
      provider: 'openai',
      endpoint: '/v1/chat/completions',
      model: 'gpt-5-mini',
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      estimated_cost_usd: 0.25,
      is_summary: false,
    },
    {
      ...base,
      provider: 'xai',
      endpoint: '/v1/chat/completions',
      model: 'grok-4-1-fast-non-reasoning',
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      estimated_cost_usd: null, // 単価表に無いモデルは推定コストが入らない
      is_summary: false,
    },
    {
      ...base,
      provider: 'mixed',
      endpoint: 'summary',
      model: 'mixed',
      input_tokens: 400,
      output_tokens: 200,
      total_tokens: 600,
      estimated_cost_usd: 0.75,
      is_summary: true,
    },
  ]);
  if (error) throw new Error(`llm_usage_logs insert: ${error.message}`);

  // 初回のアクセスは Next がルートをコンパイルするので、テスト本体の時間切れを避けるため先に呼んでおく
  await apiCall('GET', `/api/super-admin/exports/${UNKNOWN_ID}`, superAdmin.jwt);
  await apiCall('DELETE', `/api/super-admin/exports/${UNKNOWN_ID}`, superAdmin.jwt);
  await apiCall('GET', '/api/super-admin/exports', superAdmin.jwt);
  await apiCall('GET', `/api/super-admin/llm/usage?period=1d&function=${FUNCTION_NAME}`, superAdmin.jwt);
}, 240_000);

afterAll(async () => {
  await srAdmin.from('llm_usage_logs').delete().eq('function_name', FUNCTION_NAME);
  if (gdprIds.length > 0) {
    await srAdmin.from('admin_audit_logs').delete().in('target_id', gdprIds);
    await srAdmin.from('gdpr_deletion_requests').delete().in('id', gdprIds);
  }
  for (const user of [superAdmin, plainAdmin, subject]) {
    if (!user) continue;
    await cleanupAuditLogs(user.userId);
    await cleanupTestUser(user.userId);
  }
}, 60_000);

describe('/api/super-admin/exports (準備中。全メソッド 501。本人の GDPR 削除要求の表 gdpr_deletion_requests に触れない)', () => {
  it('E-1: GET は 501 OP_NOT_SUPPORTED。本人の削除要求は変わらない', async () => {
    const row = await insertGdprRequest();

    const res = await apiCall<ExportBody>('GET', `/api/super-admin/exports/${row.id}`, superAdmin.jwt);

    expect(res.status).toBe(501);
    expect(res.body.error?.code).toBe('OP_NOT_SUPPORTED');
    expect(res.body.error?.message).toContain('準備中（未対応）');
    // 成功に見える応答 (種別・形式・状態を持つエクスポートの行) を返さない
    expect(res.body.data).toBeUndefined();

    const list = await apiCall<ExportBody>('GET', '/api/super-admin/exports', superAdmin.jwt);
    expect(list.status).toBe(501);
    expect(list.body.error?.code).toBe('OP_NOT_SUPPORTED');

    expect(await gdprRow(row.id)).toEqual({ id: row.id, cancelled_at: null, executed_at: null });
  });

  it('E-2: DELETE (キャンセル) は 501。本人の GDPR 削除要求を取り消さない (cancelled_at が入らず、監査ログも残らない)', async () => {
    const row = await insertGdprRequest();

    for (let i = 0; i < 2; i += 1) {
      const cancel = await apiCall<ExportBody>('DELETE', `/api/super-admin/exports/${row.id}`, superAdmin.jwt);
      expect(cancel.status).toBe(501);
      expect(cancel.body.error?.code).toBe('OP_NOT_SUPPORTED');
    }

    const after = await gdprRow(row.id);
    expect(after.cancelled_at).toBeNull();
    expect(after.executed_at).toBeNull();
    expect(await cancelAuditLogs(row.id)).toHaveLength(0);
  });

  it('E-3: 実行済みの要求でも 501 (422 にしない)。何も変わらない', async () => {
    const row = await insertGdprRequest({ executed_at: new Date().toISOString() });

    const get = await apiCall<ExportBody>('GET', `/api/super-admin/exports/${row.id}`, superAdmin.jwt);
    expect(get.status).toBe(501);

    const cancel = await apiCall<ExportBody>('DELETE', `/api/super-admin/exports/${row.id}`, superAdmin.jwt);
    expect(cancel.status).toBe(501);
    expect(cancel.body.error?.code).toBe('OP_NOT_SUPPORTED');

    expect((await gdprRow(row.id)).cancelled_at).toBeNull();
    expect(await cancelAuditLogs(row.id)).toHaveLength(0);
  });

  it('E-4: POST (依頼) は 501。偽の依頼 ID を返さず、GDPR 削除要求の表に行を作らない。存在しない id・UUID でない id も 501', async () => {
    const before = await gdprRowCount(superAdmin.userId);

    const post = await apiCall<ExportBody>('POST', '/api/super-admin/exports', superAdmin.jwt, {
      export_type: 'audit_logs',
      format: 'csv',
      mask_pii: true,
    });
    expect(post.status).toBe(501);
    expect(post.body.error?.code).toBe('OP_NOT_SUPPORTED');
    expect(post.body.data).toBeUndefined();
    expect(await gdprRowCount(superAdmin.userId)).toBe(before);

    for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
      const get = await apiCall<ExportBody>('GET', `/api/super-admin/exports/${id}`, superAdmin.jwt);
      expect(get.status, `GET ${id}`).toBe(501);
      const del = await apiCall<ExportBody>('DELETE', `/api/super-admin/exports/${id}`, superAdmin.jwt);
      expect(del.status, `DELETE ${id}`).toBe(501);
    }
  });

  it('E-5: super_admin 以外は 403、未認証は 401。本人の削除要求は変わらない', async () => {
    const row = await insertGdprRequest();

    expect((await apiCall('GET', `/api/super-admin/exports/${row.id}`, plainAdmin.jwt)).status).toBe(403);
    expect((await apiCall('DELETE', `/api/super-admin/exports/${row.id}`, plainAdmin.jwt)).status).toBe(403);
    expect((await apiCall('POST', '/api/super-admin/exports', plainAdmin.jwt, {})).status).toBe(403);
    expect((await apiCallNoAuth('GET', `/api/super-admin/exports/${row.id}`)).status).toBe(401);
    expect((await apiCallNoAuth('DELETE', `/api/super-admin/exports/${row.id}`)).status).toBe(401);
    expect((await apiCallNoAuth('POST', '/api/super-admin/exports', {})).status).toBe(401);

    expect((await gdprRow(row.id)).cancelled_at).toBeNull();
  });
});

describe('GET /api/super-admin/llm/usage (llm_usage_logs の列は input_tokens / output_tokens / estimated_cost_usd)', () => {
  const usage = (query: string) =>
    apiCall<UsageBody>('GET', `/api/super-admin/llm/usage?period=1d&function=${FUNCTION_NAME}${query}`, superAdmin.jwt);

  it('L-1: 200 で返り、LLM 呼び出しごとの行だけを集計する (実行ごとの合計行を二重に数えない)', async () => {
    const res = await usage('');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total_requests: 3,
      total_tokens: 600,
      total_cost_usd: 0.75,
    });
    const byModel = [...(res.body.data?.by_model ?? [])].sort((a, b) => a.model.localeCompare(b.model));
    expect(byModel).toEqual([
      { model: 'gpt-5-mini', provider: 'openai', requests: 2, tokens: 300, cost_usd: 0.75 },
      { model: 'grok-4-1-fast-non-reasoning', provider: 'xai', requests: 1, tokens: 300, cost_usd: 0 },
    ]);
    expect(res.body.data?.by_function).toEqual([{ function: FUNCTION_NAME, requests: 3, cost_usd: 0.75 }]);
  });

  it('L-2: プロバイダー・モデルで絞り込める', async () => {
    const xai = await usage('&provider=xai');
    expect(xai.status).toBe(200);
    expect(xai.body.data?.total_requests).toBe(1);
    expect(xai.body.data?.by_model.map((m) => m.model)).toEqual(['grok-4-1-fast-non-reasoning']);

    const openai = await usage('&provider=openai');
    expect(openai.body.data?.total_requests).toBe(2);

    const model = await usage('&model=gpt-5-mini');
    expect(model.body.data?.total_requests).toBe(2);
  });

  it('L-3: super_admin 以外は 403、未認証は 401', async () => {
    expect((await apiCall('GET', '/api/super-admin/llm/usage?period=1d', plainAdmin.jwt)).status).toBe(403);
    expect((await apiCallNoAuth('GET', '/api/super-admin/llm/usage?period=1d')).status).toBe(401);
  });
});
