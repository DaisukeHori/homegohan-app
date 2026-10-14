/**
 * #1241 ログ系 3 テーブルの「開いている INSERT ポリシー」の回帰テスト
 *
 * 修正前のポリシー (20260102000001_create_app_logs.sql / 20260511000137_backfill_oob_remaining.sql):
 *   app_logs           "Allow service role insert": INSERT TO public            WITH CHECK (true)  ← 名前に反して anon でも書ける
 *   ai_content_logs    "System can insert ai logs": INSERT TO authenticated     WITH CHECK (true)  ← 他人の user_id でも書ける
 *   system_daily_stats "System can insert stats":   INSERT TO authenticated     WITH CHECK (true)  ← 一般ユーザーが集計値を書ける
 * のため、監査ログの偽造・管理画面の数値の汚染・他人への濡れ衣が可能だった。
 *
 * 3 テーブルへの書き込みは、アプリ上すべて service role (RLS の対象外) 経由:
 *   - app_logs: src/lib/db-logger.ts / supabase/functions/_shared/db-logger.ts / src/app/api/log/route.ts
 *   - ai_content_logs / system_daily_stats: 書き込む経路なし (account/delete が service role で DELETE するのみ)
 * そのため INSERT ポリシーを削除する (service role は影響を受けない)。
 *
 * 期待する認可 (修正後):
 *   - anon / authenticated の INSERT は 3 テーブルとも拒否 (42501)。他人の user_id でも自分の user_id でも同じ
 *   - service role の INSERT は成功する
 *   - 自分の app_logs 行の SELECT は従来どおり可能 (SELECT ポリシーは変更しない)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/log-tables-insert.test.ts
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
// テストユーザー (使い捨て。ローカル専用のパスワード)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-1241-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email, password });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signInResult.error?.message}`);
  }
  return { userId, email, jwt: signInResult.data.session.access_token };
}

// ---------------------------------------------------------------
// フィクスチャ
//   attacker: ログイン済みの攻撃者 / victim: 濡れ衣を着せられる側
// ---------------------------------------------------------------
const TS = Date.now();
const MARK = `rls-1241-${TS}`; // 後片付けで「このテストが入れた行だけ」を特定する印
// system_daily_stats は date が UNIQUE のため、実データと衝突しない遠い未来の日付を使う
const STAT_DATES = ['2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04'];

let attacker: TestUser;
let victim: TestUser;

beforeAll(async () => {
  attacker = await createTestUser('attacker');
  victim = await createTestUser('victim');
}, 60_000);

afterAll(async () => {
  // service role で、このテストが入れた行だけを条件付きで消す (ほかのログは消さない)
  await srAdmin.from('app_logs').delete().like('request_id', `${MARK}%`);
  await srAdmin.from('ai_content_logs').delete().like('input_prompt', `${MARK}%`);
  await srAdmin.from('system_daily_stats').delete().in('date', STAT_DATES);

  // 後片付けの確認 (残っていれば失敗させる)
  const { data: leftLogs } = await srAdmin.from('app_logs').select('id').like('request_id', `${MARK}%`);
  const { data: leftAi } = await srAdmin.from('ai_content_logs').select('id').like('input_prompt', `${MARK}%`);
  const { data: leftStats } = await srAdmin.from('system_daily_stats').select('id').in('date', STAT_DATES);
  expect(leftLogs ?? []).toEqual([]);
  expect(leftAi ?? []).toEqual([]);
  expect(leftStats ?? []).toEqual([]);

  for (const u of [attacker, victim]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

function appLogRow(label: string, userId: string | null) {
  return {
    level: 'error',
    source: 'client',
    message: `#1241 ${label}`,
    request_id: `${MARK}-${label}`,
    user_id: userId,
    error_stack: 'forged stack trace',
    metadata: { forged: true },
  };
}

function aiLogRow(label: string, userId: string | null) {
  return {
    user_id: userId,
    content_type: 'other',
    input_prompt: `${MARK}-${label}`,
    output_content: 'forged output',
    model_name: 'forged-model',
    tokens_used: 1,
    cost_usd: 99.99,
    flagged: true,
    flag_reason: 'forged flag',
  };
}

function statsRow(date: string) {
  return { date, total_users: 999999, new_users: 999999, active_users: 999999, dau: 999999 };
}

/** service role で、印の付いた app_logs 行の件数を数える */
async function countAppLogs(label: string): Promise<number> {
  const { data } = await srAdmin.from('app_logs').select('id').eq('request_id', `${MARK}-${label}`);
  return (data ?? []).length;
}

async function countAiLogs(label: string): Promise<number> {
  const { data } = await srAdmin.from('ai_content_logs').select('id').eq('input_prompt', `${MARK}-${label}`);
  return (data ?? []).length;
}

async function countStats(date: string): Promise<number> {
  const { data } = await srAdmin.from('system_daily_stats').select('id').eq('date', date);
  return (data ?? []).length;
}

// ================================================================
// app_logs
// ================================================================
describe('#1241 app_logs INSERT', () => {
  it('S-1: anon は app_logs に書けない (42501)。偽の行は残らない', async () => {
    const { error } = await anonClient().from('app_logs').insert(appLogRow('s1', null));
    expect(error?.code).toBe('42501');
    expect(await countAppLogs('s1')).toBe(0);
  });

  it('S-2: anon が他人 (victim) の user_id で偽のエラーログを書けない (濡れ衣の防止)', async () => {
    const { error } = await anonClient().from('app_logs').insert(appLogRow('s2', victim.userId));
    expect(error?.code).toBe('42501');
    expect(await countAppLogs('s2')).toBe(0);
  });

  it('S-3: ログインユーザーも app_logs に直接書けない (他人の user_id でも自分の user_id でも)', async () => {
    const client = authedClient(attacker.jwt);
    const other = await client.from('app_logs').insert(appLogRow('s3-other', victim.userId));
    expect(other.error?.code).toBe('42501');
    const own = await client.from('app_logs').insert(appLogRow('s3-own', attacker.userId));
    expect(own.error?.code).toBe('42501');
    expect(await countAppLogs('s3-other')).toBe(0);
    expect(await countAppLogs('s3-own')).toBe(0);
  });

  it('S-4: service role は app_logs に書ける (db-logger / api/log の経路は影響を受けない)', async () => {
    const { error } = await srAdmin.from('app_logs').insert(appLogRow('s4', attacker.userId));
    expect(error).toBeNull();
    expect(await countAppLogs('s4')).toBe(1);
  });

  it('S-5: 本人は service role が書いた自分の app_logs 行を読める (SELECT ポリシーは変更なし)', async () => {
    const { data, error } = await authedClient(attacker.jwt)
      .from('app_logs')
      .select('id')
      .eq('request_id', `${MARK}-s4`);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
  });
});

// ================================================================
// ai_content_logs
// ================================================================
describe('#1241 ai_content_logs INSERT', () => {
  it('S-6: ログインユーザーは他人 (victim) の user_id で ai_content_logs に書けない (flagged / cost_usd の偽造)', async () => {
    const { error } = await authedClient(attacker.jwt)
      .from('ai_content_logs')
      .insert(aiLogRow('s6', victim.userId));
    expect(error?.code).toBe('42501');
    expect(await countAiLogs('s6')).toBe(0);
  });

  it('S-7: ログインユーザーは自分の user_id でも書けない (書き込みは service role のみ)', async () => {
    const { error } = await authedClient(attacker.jwt)
      .from('ai_content_logs')
      .insert(aiLogRow('s7', attacker.userId));
    expect(error?.code).toBe('42501');
    expect(await countAiLogs('s7')).toBe(0);
  });

  it('S-8: anon は ai_content_logs に書けない', async () => {
    const { error } = await anonClient().from('ai_content_logs').insert(aiLogRow('s8', null));
    expect(error?.code).toBe('42501');
    expect(await countAiLogs('s8')).toBe(0);
  });

  it('S-9: service role は ai_content_logs に書ける', async () => {
    const { error } = await srAdmin.from('ai_content_logs').insert(aiLogRow('s9', victim.userId));
    expect(error).toBeNull();
    expect(await countAiLogs('s9')).toBe(1);
  });

  it('S-10: 本人は自分宛ての ai_content_logs 行を読める。他人 (attacker) には見えない (SELECT ポリシーは変更なし)', async () => {
    const own = await authedClient(victim.jwt)
      .from('ai_content_logs')
      .select('id')
      .eq('input_prompt', `${MARK}-s9`);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);

    const other = await authedClient(attacker.jwt)
      .from('ai_content_logs')
      .select('id')
      .eq('input_prompt', `${MARK}-s9`);
    expect(other.error).toBeNull();
    expect(other.data ?? []).toEqual([]);
  });
});

// ================================================================
// system_daily_stats
// ================================================================
describe('#1241 system_daily_stats INSERT', () => {
  it('S-11: ログインユーザーは system_daily_stats に書けない (管理画面の数値の汚染)', async () => {
    const { error } = await authedClient(attacker.jwt).from('system_daily_stats').insert(statsRow(STAT_DATES[0]));
    expect(error?.code).toBe('42501');
    expect(await countStats(STAT_DATES[0])).toBe(0);
  });

  it('S-12: anon は system_daily_stats に書けない', async () => {
    const { error } = await anonClient().from('system_daily_stats').insert(statsRow(STAT_DATES[1]));
    expect(error?.code).toBe('42501');
    expect(await countStats(STAT_DATES[1])).toBe(0);
  });

  it('S-13: service role は system_daily_stats に書ける', async () => {
    const { error } = await srAdmin.from('system_daily_stats').insert(statsRow(STAT_DATES[2]));
    expect(error).toBeNull();
    expect(await countStats(STAT_DATES[2])).toBe(1);
  });
});
