/**
 * cookie_consents (Cookie 同意記録) の RLS 回帰テスト
 *
 * 修正前のポリシー (20260508120000_operator_phase_4_5_foundation.sql §3.20-1。本番の catalog_policies.csv も同じ):
 *   cookie_consents_self  FOR ALL  TO public  USING ((auth.uid() = user_id) OR (user_id IS NULL))  ← WITH CHECK 無し
 * 「未ログイン時は user_id = NULL」の行を扱うための条件だが、`OR (user_id IS NULL)` のせいで、
 *   - anon キー (公開鍵) だけで、user_id が NULL のすべての行 (ip_address / user_agent / session_id を含む) を SELECT・UPDATE・DELETE できた
 *   - anon でもログインユーザーでも、user_id が NULL の行を INSERT できた (同意記録の偽造・書き込み領域の悪用)
 *   - WITH CHECK が無く USING が使われるため、ログインユーザーは自分の行の user_id を NULL に書き換えられた (行を匿名化して誰でも触れる状態にできる)
 * テーブルには anon / authenticated に GRANT ALL があるため、防いでいるのは RLS だけ。
 *
 * このテーブルをアプリは読み書きしていない (v1 の Cookie 同意は localStorage。src/lib/posthog.ts)。
 * そのため修正は「本人の行だけ」に絞る (20261007150250_cookie_consents_owner_only.sql)。
 * user_id が NULL の行は service role (RLS の対象外) だけが扱う。将来、未ログインの同意をサーバーに残すときは、
 * サーバー側のルートから service role で書く。
 *
 * 期待する認可 (修正後):
 *   - anon: SELECT・UPDATE・DELETE は何も見えず何も変わらない。INSERT は拒否 (42501)
 *   - ログインユーザー: 自分の行 (user_id = 自分) だけ SELECT・UPDATE・DELETE できる。匿名行と他人の行は見えず、変更もできない
 *     INSERT は user_id = 自分 の行だけ。user_id NULL や他人の user_id は拒否 (42501)。
 *     UPDATE で自分の行の user_id を NULL / 他人に書き換えることも拒否 (42501)
 *   - service role: 匿名行 (user_id NULL) を含めて、従来どおり読み書きできる
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/cookie-consents-scope.test.ts
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

// ---------------------------------------------------------------
// テストユーザー (使い捨て。ローカル専用のパスワード)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

const TS = Date.now();

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-cookie-consents-${label}-${TS}@homegohan.test`;
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
//   owner: 自分の同意記録を持つユーザー / other: 無関係の別のログインユーザー (攻撃者)
// ---------------------------------------------------------------
const MARK = `rls-cc-${TS}`; // session_id の接頭辞。後片付けで「このテストが入れた行だけ」を特定する印

// 匿名行 (user_id NULL) と本人の行の初期値。改ざんされたかどうかは、この値との比較で確かめる
const ANON_ROW = { analytics: true, advertising: false, ip_address: '203.0.113.7', user_agent: 'test-ua' } as const;
const OWNER_ROW = { analytics: true, advertising: true, ip_address: '203.0.113.8', user_agent: 'test-ua-owner' } as const;
// 攻撃側が書き込もうとする値
const TAMPERED = { analytics: false, advertising: true, ip_address: '198.51.100.1', user_agent: 'tampered-ua' } as const;

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');
}, 60_000);

afterAll(async () => {
  // service role で、このテストが入れた行だけを条件付きで消す (ほかの同意記録は消さない)
  await srAdmin.from('cookie_consents').delete().like('session_id', `${MARK}%`);

  // 後片付けの確認 (残っていれば失敗させる)
  const { data: left } = await srAdmin.from('cookie_consents').select('id').like('session_id', `${MARK}%`);
  expect(left ?? []).toEqual([]);

  // ユーザーを消すと、user_id の外部キー (ON DELETE CASCADE) でそのユーザーの行も消える
  for (const u of [owner, other]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

interface SeededRows {
  anonId: string; // user_id NULL の行
  ownerRowId: string; // owner の行
}

/** service role で、匿名行 (user_id NULL) と owner の行を 1 件ずつ入れる。テストごとに別の行を使う */
async function seed(label: string): Promise<SeededRows> {
  const anonRow = await srAdmin
    .from('cookie_consents')
    .insert({ user_id: null, session_id: `${MARK}-${label}-anon`, ...ANON_ROW })
    .select('id')
    .single();
  if (anonRow.error || !anonRow.data) throw new Error(`seed anon row ${label}: ${anonRow.error?.message}`);

  const ownerRow = await srAdmin
    .from('cookie_consents')
    .insert({ user_id: owner.userId, session_id: `${MARK}-${label}-owner`, ...OWNER_ROW })
    .select('id')
    .single();
  if (ownerRow.error || !ownerRow.data) throw new Error(`seed owner row ${label}: ${ownerRow.error?.message}`);

  return { anonId: anonRow.data.id as string, ownerRowId: ownerRow.data.id as string };
}

/** service role で行を読む (RLS の対象外)。無ければ null */
async function readRow(id: string) {
  const { data, error } = await srAdmin
    .from('cookie_consents')
    .select('id, user_id, session_id, analytics, advertising, ip_address, user_agent')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`readRow ${id}: ${error.message}`);
  return data;
}

/** service role で、session_id が一致する行の件数を数える (INSERT が通ったかどうかの確認用) */
async function countBySession(sessionId: string): Promise<number> {
  const { data, error } = await srAdmin.from('cookie_consents').select('id').eq('session_id', sessionId);
  if (error) throw new Error(`countBySession ${sessionId}: ${error.message}`);
  return (data ?? []).length;
}

// ================================================================
// anon (公開鍵だけ)
// ================================================================
describe('cookie_consents: 未ログイン (anon) は同意記録を読み書きできない', () => {
  it('C-1: anon は user_id が NULL の行 (ip_address / user_agent を含む) を SELECT できない', async () => {
    const { anonId } = await seed('c1');

    const byId = await anonClient()
      .from('cookie_consents')
      .select('id, session_id, ip_address, user_agent')
      .eq('id', anonId);
    expect(byId.data ?? []).toEqual([]);

    // 絞り込み無しでも、anon には 1 行も見えない
    const all = await anonClient().from('cookie_consents').select('id, session_id, ip_address, user_agent');
    expect(all.data ?? []).toEqual([]);
  });

  it('C-2: anon は user_id が NULL の行を UPDATE できない (行は書き換わらない)', async () => {
    const { anonId } = await seed('c2');

    const { data } = await anonClient().from('cookie_consents').update(TAMPERED).eq('id', anonId).select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(anonId)).toMatchObject(ANON_ROW);
  });

  it('C-3: anon は user_id が NULL の行を DELETE できない (行は残る)', async () => {
    const { anonId } = await seed('c3');

    const { data } = await anonClient().from('cookie_consents').delete().eq('id', anonId).select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(anonId)).toMatchObject(ANON_ROW);
  });

  it('C-4: anon は user_id が NULL の行を INSERT できない (42501)。行は作られない', async () => {
    const sessionId = `${MARK}-c4`;
    const { error } = await anonClient()
      .from('cookie_consents')
      .insert({ user_id: null, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });

  it('C-5: anon は他人 (owner) の user_id でも INSERT できない (42501)。同意の偽造はできない', async () => {
    const sessionId = `${MARK}-c5`;
    const { error } = await anonClient()
      .from('cookie_consents')
      .insert({ user_id: owner.userId, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });
});

// ================================================================
// 無関係のログインユーザー (other)
// ================================================================
describe('cookie_consents: 別のログインユーザーは、匿名行にも他人の行にも触れない', () => {
  it('C-6: 別のユーザーは、匿名行も owner の行も SELECT できない', async () => {
    const { anonId, ownerRowId } = await seed('c6');

    const byId = await authedClient(other.jwt)
      .from('cookie_consents')
      .select('id, user_id, session_id, ip_address, user_agent')
      .in('id', [anonId, ownerRowId]);
    expect(byId.data ?? []).toEqual([]);

    // 絞り込み無しでも、自分の行 (0 件) 以外は 1 行も見えない
    const all = await authedClient(other.jwt)
      .from('cookie_consents')
      .select('id, user_id, session_id, ip_address, user_agent');
    expect(all.data ?? []).toEqual([]);
  });

  it('C-7: 別のユーザーは、匿名行 (user_id NULL) を UPDATE できない', async () => {
    const { anonId } = await seed('c7');

    const { data } = await authedClient(other.jwt)
      .from('cookie_consents')
      .update(TAMPERED)
      .eq('id', anonId)
      .select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(anonId)).toMatchObject(ANON_ROW);
  });

  it('C-8: 別のユーザーは、匿名行を自分の user_id に付け替えて横取りできない', async () => {
    const { anonId } = await seed('c8');

    const { data } = await authedClient(other.jwt)
      .from('cookie_consents')
      .update({ user_id: other.userId })
      .eq('id', anonId)
      .select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(anonId)).toMatchObject({ user_id: null, ...ANON_ROW });
  });

  it('C-9: 別のユーザーは、owner の行を UPDATE できない', async () => {
    const { ownerRowId } = await seed('c9');

    const { data } = await authedClient(other.jwt)
      .from('cookie_consents')
      .update(TAMPERED)
      .eq('id', ownerRowId)
      .select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, ...OWNER_ROW });
  });

  it('C-10: 別のユーザーは、匿名行を DELETE できない', async () => {
    const { anonId } = await seed('c10');

    const { data } = await authedClient(other.jwt).from('cookie_consents').delete().eq('id', anonId).select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(anonId)).toMatchObject(ANON_ROW);
  });

  it('C-11: 別のユーザーは、owner の行を DELETE できない', async () => {
    const { ownerRowId } = await seed('c11');

    const { data } = await authedClient(other.jwt)
      .from('cookie_consents')
      .delete()
      .eq('id', ownerRowId)
      .select('id');
    expect(data ?? []).toEqual([]);
    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, ...OWNER_ROW });
  });

  it('C-12: 別のユーザーは、user_id が NULL の行を INSERT できない (42501)', async () => {
    const sessionId = `${MARK}-c12`;
    const { error } = await authedClient(other.jwt)
      .from('cookie_consents')
      .insert({ user_id: null, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });

  it('C-13: 別のユーザーは、owner の user_id で INSERT できない (42501)。他人名義の同意は作れない', async () => {
    const sessionId = `${MARK}-c13`;
    const { error } = await authedClient(other.jwt)
      .from('cookie_consents')
      .insert({ user_id: owner.userId, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });
});

// ================================================================
// 本人 (owner): 自分の行だけは従来どおり使える
// ================================================================
describe('cookie_consents: 本人は自分の行だけ読み書きできる', () => {
  it('C-14: 本人は自分の行を SELECT できる', async () => {
    const { ownerRowId } = await seed('c14');

    const { data, error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .select('id, user_id, analytics, advertising, ip_address, user_agent')
      .eq('id', ownerRowId)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: ownerRowId, user_id: owner.userId, ...OWNER_ROW });
  });

  it('C-15: 本人にも匿名行 (user_id NULL) は見えない。見えるのは自分の行だけ', async () => {
    const { anonId, ownerRowId } = await seed('c15');

    const byId = await authedClient(owner.jwt)
      .from('cookie_consents')
      .select('id')
      .in('id', [anonId, ownerRowId]);
    expect(byId.error).toBeNull();
    expect((byId.data ?? []).map((r: { id: string }) => r.id)).toEqual([ownerRowId]);

    // 絞り込み無しで取っても、他人の行・匿名行は混ざらない
    const all = await authedClient(owner.jwt).from('cookie_consents').select('id, user_id');
    expect(all.error).toBeNull();
    for (const row of (all.data ?? []) as Array<{ id: string; user_id: string | null }>) {
      expect(row.user_id).toBe(owner.userId);
    }
  });

  it('C-16: 本人は自分の行を UPDATE できる (同意の変更・撤回)', async () => {
    const { ownerRowId } = await seed('c16');

    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .update({ analytics: false, advertising: false })
      .eq('id', ownerRowId);
    expect(error).toBeNull();
    expect(await readRow(ownerRowId)).toMatchObject({
      user_id: owner.userId,
      analytics: false,
      advertising: false,
      // 触っていない列は変わらない
      ip_address: OWNER_ROW.ip_address,
      user_agent: OWNER_ROW.user_agent,
    });
  });

  it('C-17: 本人は自分の行の user_id を NULL に書き換えられない (42501)。匿名行化して手放せない', async () => {
    const { ownerRowId } = await seed('c17');

    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .update({ user_id: null })
      .eq('id', ownerRowId);
    expect(error?.code).toBe('42501');
    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, ...OWNER_ROW });
  });

  it('C-18: 本人は自分の行の user_id を他人 (other) に書き換えられない (42501)', async () => {
    const { ownerRowId } = await seed('c18');

    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .update({ user_id: other.userId })
      .eq('id', ownerRowId);
    expect(error?.code).toBe('42501');
    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, ...OWNER_ROW });
  });

  it('C-19: 本人は自分の行を DELETE できる', async () => {
    const { ownerRowId } = await seed('c19');

    const { error } = await authedClient(owner.jwt).from('cookie_consents').delete().eq('id', ownerRowId);
    expect(error).toBeNull();
    expect(await readRow(ownerRowId)).toBeNull();
  });

  it('C-20: 本人は user_id = 自分 の行を INSERT できる', async () => {
    const sessionId = `${MARK}-c20`;
    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .insert({ user_id: owner.userId, session_id: sessionId, analytics: true, advertising: false, user_agent: 'test-ua-c20' });
    expect(error).toBeNull();
    expect(await countBySession(sessionId)).toBe(1);

    // INSERT した行は本人から読める (RETURNING 付きの INSERT が使われても失敗しない)
    const { data, error: selectError } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .select('user_id, analytics, advertising, user_agent')
      .eq('session_id', sessionId)
      .single();
    expect(selectError).toBeNull();
    expect(data).toMatchObject({ user_id: owner.userId, analytics: true, advertising: false, user_agent: 'test-ua-c20' });
  });

  it('C-21: 本人は user_id が NULL の行を INSERT できない (42501)', async () => {
    const sessionId = `${MARK}-c21`;
    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .insert({ user_id: null, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });

  it('C-22: 本人は他人 (other) の user_id で INSERT できない (42501)', async () => {
    const sessionId = `${MARK}-c22`;
    const { error } = await authedClient(owner.jwt)
      .from('cookie_consents')
      .insert({ user_id: other.userId, session_id: sessionId, ...TAMPERED });
    expect(error?.code).toBe('42501');
    expect(await countBySession(sessionId)).toBe(0);
  });
});

// ================================================================
// service role: 匿名の同意をサーバーから残す経路は影響を受けない
// ================================================================
describe('cookie_consents: service role は匿名行 (user_id NULL) を含めて従来どおり扱える', () => {
  it('C-23: service role は user_id が NULL の行を INSERT・SELECT・UPDATE・DELETE できる', async () => {
    const sessionId = `${MARK}-c23`;
    const inserted = await srAdmin
      .from('cookie_consents')
      .insert({ user_id: null, session_id: sessionId, ...ANON_ROW })
      .select('id, user_id, ip_address, user_agent')
      .single();
    expect(inserted.error).toBeNull();
    expect(inserted.data).toMatchObject({ user_id: null, ip_address: ANON_ROW.ip_address, user_agent: ANON_ROW.user_agent });
    const id = inserted.data!.id as string;

    const updated = await srAdmin.from('cookie_consents').update({ analytics: false }).eq('id', id).select('analytics');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ analytics: false }]);

    const deleted = await srAdmin.from('cookie_consents').delete().eq('id', id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id }]);
    expect(await readRow(id)).toBeNull();
  });

  it('C-24: アカウント削除 (auth.admin.deleteUser) で、そのユーザーの行は外部キーのカスケードで消える (RLS の影響を受けない)', async () => {
    const doomed = await createTestUser('doomed');
    const sessionId = `${MARK}-c24`;
    try {
      const { error } = await srAdmin
        .from('cookie_consents')
        .insert({ user_id: doomed.userId, session_id: sessionId, ...OWNER_ROW });
      expect(error).toBeNull();
      expect(await countBySession(sessionId)).toBe(1);

      // src/app/api/account/delete/route.ts と同じく、service role の auth.admin.deleteUser でユーザーを消す
      const { error: deleteError } = await srAdmin.auth.admin.deleteUser(doomed.userId);
      expect(deleteError).toBeNull();
      expect(await countBySession(sessionId)).toBe(0);
    } finally {
      // 途中で失敗してもユーザーを残さない (削除済みなら何も起きない)
      await srAdmin.auth.admin.deleteUser(doomed.userId);
    }
  });
});
