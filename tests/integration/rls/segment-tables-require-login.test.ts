/**
 * #1242 segment_stats / segment_definitions / metric_definitions の SELECT をログイン必須にする回帰テスト
 *
 * 修正前の本番 (supabase/baseline/catalog/catalog_policies.csv) は、3 テーブルとも
 *   *_select: FOR SELECT, roles=public, USING (true)
 * のため、公開の anon キーだけで GET /rest/v1/segment_stats?select=* などを直接読めた。
 * アプリの /api/comparison/rankings はログインが必要なのに、DB 層は未ログインでも読める (認可の不一致)。
 * 中身はコホート比較の統計とセグメント・指標の定義で、個人情報は含まない。
 *
 * 期待する認可 (修正後):
 *   - SELECT: ログインユーザー (authenticated) と service_role のみ。anon は 0 件
 *   - INSERT / UPDATE / DELETE: ポリシー無し。anon・ログインユーザーとも拒否 (書けるのは service_role のみ)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 * 正当な利用者は、ログインユーザーのセッションで読む /api/comparison/rankings と、
 * service_role で読み書きする Edge Function calculate-segment-stats のみ。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/segment-tables-require-login.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (support-ticket-messages-rls.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------
const stamp = Date.now();
const email = `seg-tables-login-${stamp}@homegohan.test`;
const password = 'TestPass!2026-rls';
const segmentCode = `seg-login-test-${stamp}`;
const metricCode = `metric-login-test-${stamp}`;

let userId = '';
let userJwt = '';
let segmentId = '';
let metricId = '';
let statsId = '';

beforeAll(async () => {
  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user: ${authError?.message}`);
  }
  userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signIn = await anonClient().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`Failed to sign in: ${signIn.error?.message}`);
  }
  userJwt = signIn.data.session.access_token;

  // service_role でテスト行を作る (code は一意な値)
  const seg = await srAdmin
    .from('segment_definitions')
    .insert({ code: segmentCode, name: 'ログイン必須テスト用セグメント', axes: { test: true }, level: 1 })
    .select('id')
    .single();
  if (seg.error || !seg.data) throw new Error(`Failed to insert segment: ${seg.error?.message}`);
  segmentId = seg.data.id;

  const met = await srAdmin
    .from('metric_definitions')
    .insert({ code: metricCode, name: 'ログイン必須テスト用指標', category: 'test' })
    .select('id')
    .single();
  if (met.error || !met.data) throw new Error(`Failed to insert metric: ${met.error?.message}`);
  metricId = met.data.id;

  const stats = await srAdmin
    .from('segment_stats')
    .insert({
      segment_id: segmentId,
      metric_id: metricId,
      period_type: 'weekly',
      period_start: '2000-01-03',
      period_end: '2000-01-09',
      user_count: 1,
      avg_value: 1,
    })
    .select('id')
    .single();
  if (stats.error || !stats.data) throw new Error(`Failed to insert stats: ${stats.error?.message}`);
  statsId = stats.data.id;
});

afterAll(async () => {
  // segment_stats は FK (ON DELETE CASCADE) だが、明示的に先に消す
  if (statsId) await srAdmin.from('segment_stats').delete().eq('id', statsId);
  if (segmentId) await srAdmin.from('segment_definitions').delete().eq('id', segmentId);
  if (metricId) await srAdmin.from('metric_definitions').delete().eq('id', metricId);
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
});

// ---------------------------------------------------------------
// SELECT: 未ログインは読めない / ログインユーザーと service_role は読める
// ---------------------------------------------------------------
describe('#1242 SELECT はログイン必須', () => {
  it('S-1: anon は segment_stats を読めない (0 件)', async () => {
    const { data, error } = await anonClient().from('segment_stats').select('id').eq('id', statsId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-2: anon は segment_definitions を読めない (0 件)', async () => {
    const { data, error } = await anonClient().from('segment_definitions').select('id').eq('id', segmentId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-3: anon は metric_definitions を読めない (0 件)', async () => {
    const { data, error } = await anonClient().from('metric_definitions').select('id').eq('id', metricId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('S-4: ログインユーザーは segment_stats を読める', async () => {
    const { data, error } = await authedClient(userJwt).from('segment_stats').select('id').eq('id', statsId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('S-5: ログインユーザーは segment_definitions を読める', async () => {
    const { data, error } = await authedClient(userJwt)
      .from('segment_definitions')
      .select('id')
      .eq('id', segmentId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('S-6: ログインユーザーは metric_definitions を読める', async () => {
    const { data, error } = await authedClient(userJwt)
      .from('metric_definitions')
      .select('id')
      .eq('id', metricId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('S-7: ログインユーザーは segment_stats から定義への埋め込み (JOIN) も読める', async () => {
    const { data, error } = await authedClient(userJwt)
      .from('segment_stats')
      .select('id, segment_definitions(code), metric_definitions(code)')
      .eq('id', statsId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const row = data![0] as unknown as {
      segment_definitions: { code: string } | null;
      metric_definitions: { code: string } | null;
    };
    expect(row.segment_definitions?.code).toBe(segmentCode);
    expect(row.metric_definitions?.code).toBe(metricCode);
  });

  it('S-8: service_role は 3 テーブルとも読める (Edge Function calculate-segment-stats の経路)', async () => {
    const stats = await srAdmin.from('segment_stats').select('id').eq('id', statsId);
    const seg = await srAdmin.from('segment_definitions').select('id').eq('id', segmentId);
    const met = await srAdmin.from('metric_definitions').select('id').eq('id', metricId);
    expect(stats.error).toBeNull();
    expect(seg.error).toBeNull();
    expect(met.error).toBeNull();
    expect(stats.data).toHaveLength(1);
    expect(seg.data).toHaveLength(1);
    expect(met.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------
// 書き込み: anon・ログインユーザーとも拒否 (修正前後とも変わらない)
// ---------------------------------------------------------------
describe('#1242 書き込みは service_role のみ', () => {
  const insertCases: Array<{ id: string; table: string; row: () => Record<string, unknown> }> = [
    {
      id: 'W-1',
      table: 'segment_stats',
      row: () => ({
        segment_id: segmentId,
        metric_id: metricId,
        period_type: 'weekly',
        period_start: '2000-02-07',
        period_end: '2000-02-13',
      }),
    },
    {
      id: 'W-2',
      table: 'segment_definitions',
      row: () => ({ code: `seg-login-ins-${stamp}`, name: '不正な挿入', axes: {} }),
    },
    {
      id: 'W-3',
      table: 'metric_definitions',
      row: () => ({ code: `metric-login-ins-${stamp}`, name: '不正な挿入', category: 'test' }),
    },
  ];

  for (const c of insertCases) {
    it(`${c.id}: anon は ${c.table} に insert できない`, async () => {
      const { error } = await anonClient().from(c.table).insert(c.row());
      expect(error).not.toBeNull();
    });

    it(`${c.id}b: ログインユーザーは ${c.table} に insert できない`, async () => {
      const { error } = await authedClient(userJwt).from(c.table).insert(c.row());
      expect(error).not.toBeNull();
    });
  }

  it('W-4: ログインユーザーは segment_stats を update / delete できない (0 行に作用)', async () => {
    const client = authedClient(userJwt);
    const upd = await client.from('segment_stats').update({ user_count: 999 }).eq('id', statsId).select('id');
    expect(upd.data ?? []).toEqual([]);
    const del = await client.from('segment_stats').delete().eq('id', statsId).select('id');
    expect(del.data ?? []).toEqual([]);

    const { data } = await srAdmin.from('segment_stats').select('user_count').eq('id', statsId).single();
    expect(data?.user_count).toBe(1);
  });
});
