/**
 * external_data_consents (外国の AI 事業者への提供の同意記録) の RLS・権限の回帰テスト (T15 / #1154)
 *
 * 経緯:
 *   - 設計書 (docs/design/cross/08-legal-compliance.md §4.3) は、同意を記録するテーブルとして external_data_consents を定めていて、
 *     本番にも作ってあった。しかしアプリはこのテーブルを一度も読み書きしていなかった。
 *   - 修正前のポリシー: ext_consent_self_read (SELECT: 自分の行) / ext_consent_self_insert (INSERT: user_id = 自分) /
 *     ext_consent_no_delete (DELETE: 常に拒否)。UPDATE のポリシーは無い。anon / authenticated にはテーブルの GRANT ALL がある。
 *   - 同意の記録は「いつ・どの版の文面に・どの IP / 端末から同意したか」が証拠になる。クライアントが自由に INSERT できると、
 *     日時・IP アドレス・User-Agent・文面の版を、利用者側が好きな値で書けてしまい、記録の証拠価値が下がる。
 *     (自分の同意の改ざんなので他人への害は無いが、サーバーが請求に応じて出せる記録としては不適切)
 *   - そこで同意・撤回は、サーバーの API (service role) だけが書く。IP アドレスと User-Agent は、クライアントの申告ではなく
 *     サーバーがリクエストから取る。クライアント (anon / authenticated) は、自分の行の SELECT だけができる。
 *
 * 期待する認可 (20261008200300_ai_consent_policy_version.sql の後):
 *   - 列 policy_version (同意した文面の版) がある
 *   - anon: 何も読み書きできない
 *   - ログインユーザー: 自分の行だけ SELECT できる。INSERT・UPDATE・DELETE は、自分の行にも他人の行にもできない
 *   - service role: 従来どおり読み書きできる。有効な (revoked_at が NULL の) 行は (user_id, provider) ごとに 1 件
 *   - アカウント削除 (auth.admin.deleteUser) では、user_id の外部キー (ON DELETE CASCADE) で行が消える
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/external-data-consents.test.ts
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
// クライアントファクトリ (cookie-consents-scope.test.ts と同型)
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
  const email = `rls-ext-consents-${label}-${TS}@homegohan.test`;
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
const TABLE = 'external_data_consents';
const VERSION = 'rls-test-version';

/**
 * owner の行の初期値。改ざんされたかどうかは、この値との比較で確かめる。
 * policy_version は含めない: 基本の seed は、policy_version を足す前の本番にもある列だけで作り、
 * 権限のテスト (X-5 〜 X-11) が「列が無い」ことで偶然失敗・成功しないようにする。
 * 版を確かめるテスト (X-1, X-12, X-13, X-15) は、それぞれ policy_version を明示して入れる。
 */
const OWNER_ROW = {
  provider: 'xai',
  consented: true,
  ip_address: '203.0.113.8',
  user_agent: 'rls-test-ua-owner',
} as const;
/** 攻撃側が書き込もうとする値 */
const TAMPERED = {
  consented: false,
  policy_version: 'tampered-version',
  ip_address: '198.51.100.1',
  user_agent: 'tampered-ua',
} as const;

let owner: TestUser;
let other: TestUser;

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');
}, 60_000);

afterAll(async () => {
  const ids = [owner?.userId, other?.userId].filter((id): id is string => Boolean(id));
  if (ids.length > 0) {
    // service role で、このテストのユーザーの行だけを消す (ほかの同意記録は消さない)
    await srAdmin.from(TABLE).delete().in('user_id', ids);

    // 後片付けの確認 (残っていれば失敗させる)
    const { data: left } = await srAdmin.from(TABLE).select('id').in('user_id', ids);
    expect(left ?? []).toEqual([]);
  }

  // ユーザーを消すと、user_id の外部キー (ON DELETE CASCADE) でそのユーザーの行も消える
  for (const u of [owner, other]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

interface SeededRows {
  ownerRowId: string; // owner の有効な行 (provider = xai)
  otherRowId: string; // other の有効な行 (provider = xai)
}

/** service role で、owner と other の行を消してから 1 件ずつ入れ直す。テストごとに別の行を使う */
async function seed(): Promise<SeededRows> {
  const cleared = await srAdmin.from(TABLE).delete().in('user_id', [owner.userId, other.userId]);
  if (cleared.error) throw new Error(`seed: clear rows: ${cleared.error.message}`);

  const ownerRow = await srAdmin
    .from(TABLE)
    .insert({ user_id: owner.userId, ...OWNER_ROW })
    .select('id')
    .single();
  if (ownerRow.error || !ownerRow.data) throw new Error(`seed: owner row: ${ownerRow.error?.message}`);

  const otherRow = await srAdmin
    .from(TABLE)
    .insert({
      user_id: other.userId,
      provider: 'xai',
      consented: true,
      ip_address: '203.0.113.9',
      user_agent: 'rls-test-ua-other',
    })
    .select('id')
    .single();
  if (otherRow.error || !otherRow.data) throw new Error(`seed: other row: ${otherRow.error?.message}`);

  return { ownerRowId: ownerRow.data.id as string, otherRowId: otherRow.data.id as string };
}

/** service role で行を読む (RLS の対象外)。無ければ null */
async function readRow(id: string) {
  const { data, error } = await srAdmin
    .from(TABLE)
    .select('id, user_id, provider, consented, revoked_at, ip_address, user_agent')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`readRow ${id}: ${error.message}`);
  return data;
}

/** service role で、ユーザーの行の件数を数える (INSERT が通ったかどうかの確認用) */
async function countRows(userId: string): Promise<number> {
  const { data, error } = await srAdmin.from(TABLE).select('id').eq('user_id', userId);
  if (error) throw new Error(`countRows ${userId}: ${error.message}`);
  return (data ?? []).length;
}

// ================================================================
// 読み取り: 自分の行だけ (self read only)
// ================================================================
describe('external_data_consents: ログインユーザーは自分の行だけ読める', () => {
  it('X-1: 本人は自分の行を SELECT できる。同意した文面の版 (policy_version) も読める', async () => {
    const { ownerRowId } = await seed();
    // 版は migration (20261008200300) で足した列。サーバーが同意を記録するときに入れる
    const versioned = await srAdmin.from(TABLE).update({ policy_version: VERSION }).eq('id', ownerRowId);
    expect(versioned.error).toBeNull();

    const { data, error } = await authedClient(owner.jwt)
      .from(TABLE)
      .select('id, user_id, provider, consented, revoked_at, policy_version')
      .eq('id', ownerRowId)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      id: ownerRowId,
      user_id: owner.userId,
      provider: OWNER_ROW.provider,
      consented: true,
      revoked_at: null,
      policy_version: VERSION,
    });
  });

  it('X-2: 絞り込み無しで取っても、他人の行は混ざらない', async () => {
    const { ownerRowId, otherRowId } = await seed();

    const all = await authedClient(owner.jwt).from(TABLE).select('id, user_id');
    expect(all.error).toBeNull();
    const rows = (all.data ?? []) as Array<{ id: string; user_id: string }>;
    expect(rows.map((r) => r.id)).toContain(ownerRowId);
    expect(rows.map((r) => r.id)).not.toContain(otherRowId);
    for (const row of rows) expect(row.user_id).toBe(owner.userId);
  });

  it('X-3: 別のユーザーは、owner の行を SELECT できない (id を指定しても、絞り込み無しでも)', async () => {
    const { ownerRowId } = await seed();

    const byId = await authedClient(other.jwt).from(TABLE).select('id, ip_address, user_agent').eq('id', ownerRowId);
    expect(byId.data ?? []).toEqual([]);

    const byUser = await authedClient(other.jwt)
      .from(TABLE)
      .select('id, ip_address, user_agent')
      .eq('user_id', owner.userId);
    expect(byUser.data ?? []).toEqual([]);

    const all = await authedClient(other.jwt).from(TABLE).select('id, user_id');
    for (const row of (all.data ?? []) as Array<{ user_id: string }>) expect(row.user_id).toBe(other.userId);
  });

  it('X-4: 未ログイン (anon) は、どの行も読めない', async () => {
    const { ownerRowId } = await seed();

    const byId = await anonClient().from(TABLE).select('id, ip_address, user_agent').eq('id', ownerRowId);
    expect(byId.data ?? []).toEqual([]);

    const all = await anonClient().from(TABLE).select('id');
    expect(all.data ?? []).toEqual([]);
  });
});

// ================================================================
// 書き込み: クライアントからは更新・削除・追加のいずれもできない
// ================================================================
describe('external_data_consents: クライアントからは更新・削除・追加できない (書き込みはサーバーだけ)', () => {
  it('X-5: 本人も、自分の行を UPDATE できない (撤回・版・IP アドレスの書き換えも含めて、行は変わらない)', async () => {
    const { ownerRowId } = await seed();

    await authedClient(owner.jwt).from(TABLE).update({ revoked_at: new Date().toISOString() }).eq('id', ownerRowId);
    await authedClient(owner.jwt).from(TABLE).update(TAMPERED).eq('id', ownerRowId);

    // エラーになるか 0 件の更新かは問わない。行が変わらないことが要件
    expect(await readRow(ownerRowId)).toMatchObject({
      user_id: owner.userId,
      provider: OWNER_ROW.provider,
      consented: true,
      revoked_at: null,
      ip_address: OWNER_ROW.ip_address,
      user_agent: OWNER_ROW.user_agent,
    });
  });

  it('X-6: 別のユーザーは、owner の行を UPDATE できない', async () => {
    const { ownerRowId } = await seed();

    await authedClient(other.jwt).from(TABLE).update({ revoked_at: new Date().toISOString() }).eq('id', ownerRowId);
    await authedClient(other.jwt).from(TABLE).update(TAMPERED).eq('id', ownerRowId);

    expect(await readRow(ownerRowId)).toMatchObject({
      user_id: owner.userId,
      consented: true,
      revoked_at: null,
      ip_address: OWNER_ROW.ip_address,
    });
  });

  it('X-7: 本人も、自分の行を DELETE できない (行は残る)', async () => {
    const { ownerRowId } = await seed();

    await authedClient(owner.jwt).from(TABLE).delete().eq('id', ownerRowId);

    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, consented: true });
  });

  it('X-8: 別のユーザーは、owner の行を DELETE できない (行は残る)', async () => {
    const { ownerRowId } = await seed();

    await authedClient(other.jwt).from(TABLE).delete().eq('id', ownerRowId);
    await anonClient().from(TABLE).delete().eq('id', ownerRowId);

    expect(await readRow(ownerRowId)).toMatchObject({ user_id: owner.userId, consented: true });
  });

  it('X-9: 本人も、自分名義の同意の行を INSERT できない (42501)。同意の記録 (日時・IP・版) はサーバーだけが作る', async () => {
    await seed();
    // 有効な行が無い状態にしてから試す (有効な行の重複 23505 で失敗したのではなく、権限で拒否されることを見る)
    await srAdmin.from(TABLE).delete().eq('user_id', owner.userId);

    const { error } = await authedClient(owner.jwt)
      .from(TABLE)
      .insert({ user_id: owner.userId, provider: 'google', consented: true, ip_address: '198.51.100.2' });
    expect(error?.code).toBe('42501');
    expect(await countRows(owner.userId)).toBe(0);
  });

  it('X-10: 本人も、他人名義の行を INSERT できない (42501)', async () => {
    await seed();
    await srAdmin.from(TABLE).delete().eq('user_id', other.userId);

    const { error } = await authedClient(owner.jwt)
      .from(TABLE)
      .insert({ user_id: other.userId, provider: 'google', consented: true });
    expect(error?.code).toBe('42501');
    expect(await countRows(other.userId)).toBe(0);
  });

  it('X-11: 未ログイン (anon) は INSERT できない (42501)', async () => {
    await seed();
    await srAdmin.from(TABLE).delete().eq('user_id', owner.userId);

    const { error } = await anonClient()
      .from(TABLE)
      .insert({ user_id: owner.userId, provider: 'google', consented: true });
    expect(error?.code).toBe('42501');
    expect(await countRows(owner.userId)).toBe(0);
  });
});

// ================================================================
// service role: サーバーの API が同意を記録・撤回する経路は影響を受けない
// ================================================================
describe('external_data_consents: service role (サーバー) は同意を記録・撤回できる', () => {
  it('X-12: 3 事業者 (xai / google / openai) ぶんを、文面の版・IP アドレス・User-Agent つきで INSERT して読み戻せる', async () => {
    await seed();
    await srAdmin.from(TABLE).delete().eq('user_id', owner.userId);

    for (const provider of ['xai', 'google', 'openai']) {
      const { error } = await srAdmin.from(TABLE).insert({
        user_id: owner.userId,
        provider,
        consented: true,
        policy_version: VERSION,
        ip_address: '203.0.113.20',
        user_agent: `rls-test-ua-${provider}`,
      });
      expect(error, `provider ${provider}`).toBeNull();
    }

    const { data, error } = await srAdmin
      .from(TABLE)
      .select('provider, consented, revoked_at, policy_version, ip_address, user_agent')
      .eq('user_id', owner.userId)
      .order('provider');
    expect(error).toBeNull();
    expect(data).toHaveLength(3);
    expect((data ?? []).map((r: { provider: string }) => r.provider)).toEqual(['google', 'openai', 'xai']);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      expect(row).toMatchObject({
        consented: true,
        revoked_at: null,
        policy_version: VERSION,
        ip_address: '203.0.113.20',
        user_agent: `rls-test-ua-${row.provider}`,
      });
    }
  });

  it('X-13: 有効な行 (revoked_at が NULL) は (user_id, provider) ごとに 1 件。撤回 (revoked_at を入れる) と、その後の同意はできる', async () => {
    const { ownerRowId } = await seed();

    // 同じ事業者の有効な行は 2 件目を作れない (部分ユニーク索引 idx_ext_consents_active)
    const duplicate = await srAdmin
      .from(TABLE)
      .insert({ user_id: owner.userId, ...OWNER_ROW, policy_version: 'next-version' });
    expect(duplicate.error?.code).toBe('23505');

    // 撤回: revoked_at を入れる (行は消さない。監査のために残る)
    const revoked = await srAdmin
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', ownerRowId)
      .is('revoked_at', null)
      .select('id');
    expect(revoked.error).toBeNull();
    expect(revoked.data).toEqual([{ id: ownerRowId }]);

    // 撤回のあとは、同じ事業者に新しい同意の行を作れる
    const regrant = await srAdmin
      .from(TABLE)
      .insert({ user_id: owner.userId, ...OWNER_ROW, policy_version: 'next-version' })
      .select('id')
      .single();
    expect(regrant.error).toBeNull();

    // 古い行と新しい行の両方が残る
    expect(await countRows(owner.userId)).toBe(2);
  });

  it('X-14: IP アドレスに不正な文字列は入らない (22P02)。サーバーは形式を確かめてから入れること', async () => {
    await seed();
    await srAdmin.from(TABLE).delete().eq('user_id', owner.userId);

    const { error } = await srAdmin
      .from(TABLE)
      .insert({ user_id: owner.userId, provider: 'xai', consented: true, ip_address: 'not-an-ip' });
    expect(error?.code).toBe('22P02');
    expect(await countRows(owner.userId)).toBe(0);
  });

  it('X-15: アカウント削除 (auth.admin.deleteUser) で、そのユーザーの行は外部キーのカスケードで消える (RLS・権限の影響を受けない)', async () => {
    const doomed = await createTestUser('doomed');
    try {
      const { error } = await srAdmin
        .from(TABLE)
        .insert({ user_id: doomed.userId, provider: 'xai', consented: true, policy_version: VERSION });
      expect(error).toBeNull();
      expect(await countRows(doomed.userId)).toBe(1);

      // src/app/api/account/delete/route.ts と同じく、service role の auth.admin.deleteUser でユーザーを消す
      const { error: deleteError } = await srAdmin.auth.admin.deleteUser(doomed.userId);
      expect(deleteError).toBeNull();
      expect(await countRows(doomed.userId)).toBe(0);
    } finally {
      // 途中で失敗してもユーザーを残さない (削除済みなら何も起きない)
      await srAdmin.auth.admin.deleteUser(doomed.userId);
    }
  });
});
