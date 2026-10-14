/**
 * #1171 app_logs の SELECT 範囲の回帰テスト (user_id IS NULL の行が全員に読めていた問題)
 *
 * 修正前のポリシー (SELECT は 2 本。どちらも roles=public で、permissive ポリシーは OR で合成される):
 *   "Users can view own logs" USING (auth.uid() = user_id)                          ← 20260102000001_create_app_logs.sql
 *   "Users can read own logs" USING ((auth.uid() = user_id) OR (user_id IS NULL))   ← 20260511000137_backfill_oob_remaining.sql
 * 後者の `OR user_id IS NULL` が穴で、user_id = NULL の行は anon (公開キーだけ。ログイン不要) を含む全員が
 * PostgREST で読めた。app_logs は anon / authenticated に GRANT 済みのため、防いでいるのは RLS だけ。
 * message / error_message / error_stack には生の DB エラーやスタックトレースが入る。
 *
 * user_id が NULL になる行:
 *   - .withUser() を使わないロガー呼び出し、cron / バッチ
 *   - アカウント削除 (app_logs.user_id は REFERENCES auth.users ON DELETE SET NULL。
 *     src/app/api/account/delete/route.ts は app_logs に触れないので、削除後その人の行が NULL 行 = 全員に公開になる)
 *
 * 期待する認可 (修正後):
 *   - anon: app_logs は 0 件 (user_id IS NULL の行も読めない)
 *   - authenticated: 自分の行 (auth.uid() = user_id) だけ。NULL 行と他人の行は読めない
 *   - service_role: 全行 (RLS の対象外。scripts/read-logs.mjs の経路)
 *   - アカウント削除で NULL になった行も、service_role 以外には読めない
 * 書き込みの制限は #1241 (log-tables-insert.test.ts)。ここでは SELECT のみを扱う。
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 * app_logs をユーザーのセッションで読むコードは無い (読むのは service role の scripts/read-logs.mjs だけ) ので、
 * 正当な利用経路に影響しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/app-logs-select-scope.test.ts
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
// クライアントファクトリ (log-tables-insert.test.ts と同型)
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

const TS = Date.now();
const MARK = `rls-1171-${TS}`; // 後片付けと「このテストが入れた行だけ」の絞り込みに使う印 (request_id の接頭辞)

// ---------------------------------------------------------------
// テストユーザー (使い捨て。ローカル専用のパスワード)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-1171-${label}-${TS}@homegohan.test`;
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
// フィクスチャ (service role が入れる 4 行。request_id = `${MARK}-<ラベル>`)
//   null   : user_id = NULL (.withUser() を使わないロガー呼び出し・cron / バッチ相当)
//   owner  : owner の行
//   other  : other の行 (owner から見て他人)
//   leaver : leaver の行。S-7 でアカウントを削除して user_id を NULL にする
//   どの行も error_message / error_stack を持つ (生のエラー本文が読めてしまうことが問題の本体)
// ---------------------------------------------------------------
type Label = 'null' | 'owner' | 'other' | 'leaver';

let owner: TestUser;
let other: TestUser;
let leaver: TestUser;

function appLogRow(label: Label, userId: string | null) {
  return {
    level: 'error',
    source: 'api-route',
    function_name: 'rls-1171-test',
    message: `#1171 ${label}`,
    request_id: `${MARK}-${label}`,
    user_id: userId,
    error_message: `#1171 ${label} error_message (生の DB エラー相当)`,
    error_stack: `Error: #1171 ${label}\n    at fixtureFrame (/app/src/lib/fixture.ts:1:1)`,
    metadata: { fixture: label },
  };
}

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');
  leaver = await createTestUser('leaver');

  const { error } = await srAdmin
    .from('app_logs')
    .insert([
      appLogRow('null', null),
      appLogRow('owner', owner.userId),
      appLogRow('other', other.userId),
      appLogRow('leaver', leaver.userId),
    ]);
  if (error) throw new Error(`Failed to insert app_logs fixtures: ${error.message}`);
}, 60_000);

afterAll(async () => {
  // service role で、このテストが入れた行だけを条件付きで消す (ほかのログは消さない)
  await srAdmin.from('app_logs').delete().like('request_id', `${MARK}-%`);

  // 後片付けの確認 (残っていれば失敗させる)
  const { data: left } = await srAdmin.from('app_logs').select('id').like('request_id', `${MARK}-%`);
  expect(left ?? []).toEqual([]);

  // leaver は S-7 で削除済みのことがある (その場合の deleteUser のエラーは無視する)
  for (const u of [owner, other, leaver]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

/** そのクライアントから読める fixture 行のラベル一覧 (昇順)。RLS で見えない行は含まれない */
async function visible(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.from('app_logs').select('request_id').like('request_id', `${MARK}-%`);
  expect(error).toBeNull();
  return (data ?? []).map((r) => String(r.request_id).slice(MARK.length + 1)).sort();
}

// ================================================================
// app_logs SELECT
//   S-7 は fixture の leaver を削除して user_id を NULL にするため、必ず最後に置く (S-1〜S-6 の前提を崩さない)
// ================================================================
describe('#1171 app_logs SELECT', () => {
  it('S-1: anon (公開キーだけ) は app_logs を 1 行も読めない。user_id IS NULL の行も、本文 (エラー・スタック) も', async () => {
    expect(await visible(anonClient())).toEqual([]);

    // 攻撃者が request_id を指定して NULL 行の本文を取りにいっても取れない
    const { data, error } = await anonClient()
      .from('app_logs')
      .select('message, error_message, error_stack')
      .eq('request_id', `${MARK}-null`);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it('S-2: anon が user_id IS NULL を指定して探しても 0 件 (テーブル全体への探索)', async () => {
    const { data, error } = await anonClient().from('app_logs').select('id').is('user_id', null).limit(1);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it('S-3: ログインユーザー (other) は自分の行だけ読める。NULL 行も他人 (owner / leaver) の行も読めない', async () => {
    expect(await visible(authedClient(other.jwt))).toEqual(['other']);
  });

  it('S-4: ログインユーザー (owner) は自分の行だけ読める。user_id IS NULL を指定しても 0 件', async () => {
    const client = authedClient(owner.jwt);
    expect(await visible(client)).toEqual(['owner']);

    const probe = await client.from('app_logs').select('id').is('user_id', null).limit(1);
    expect(probe.error).toBeNull();
    expect(probe.data ?? []).toEqual([]);
  });

  it('S-5: 回帰ガード: 本人は自分の行を読める (他人の行は読めない)。修正前後で変わらない', async () => {
    const names = await visible(authedClient(owner.jwt));
    expect(names).toContain('owner');
    expect(names).not.toContain('other');
  });

  it('S-6: service role は 4 行すべて読める。NULL 行の本文も読める (scripts/read-logs.mjs の経路は影響を受けない)', async () => {
    expect(await visible(srAdmin)).toEqual(['leaver', 'null', 'other', 'owner']);

    const { data, error } = await srAdmin
      .from('app_logs')
      .select('user_id, error_message, error_stack')
      .eq('request_id', `${MARK}-null`)
      .single();
    expect(error).toBeNull();
    expect(data?.user_id).toBeNull();
    expect(data?.error_message).toContain('#1171 null');
    expect(data?.error_stack).toContain('fixtureFrame');
  });

  it('S-7: アカウント削除 (ON DELETE SET NULL で user_id が NULL になる) 後も、その行は anon にも他人にも読めない', async () => {
    const { error: deleteError } = await srAdmin.auth.admin.deleteUser(leaver.userId);
    expect(deleteError).toBeNull();

    // FK の ON DELETE SET NULL で行が残り、user_id だけが NULL になっている (service role で確認)
    const { data: row, error: readError } = await srAdmin
      .from('app_logs')
      .select('user_id')
      .eq('request_id', `${MARK}-leaver`)
      .single();
    expect(readError).toBeNull();
    expect(row?.user_id).toBeNull();

    // NULL になった行を含め、anon には何も見えない / other には自分の行だけ見える
    expect(await visible(anonClient())).toEqual([]);
    expect(await visible(authedClient(other.jwt))).toEqual(['other']);
    // service role からは引き続き読める
    expect(await visible(srAdmin)).toContain('leaver');
  });
});
