/**
 * #1215 user_badges の書き込み権限の回帰テスト
 *
 * user_badges には SELECT ポリシー ("Users can view own badges") しか無く、INSERT ポリシーが無い
 * (RLS は有効なので INSERT は既定で拒否される)。そのため /api/badges がセッションの client で
 * insert すると常に 42501 になり、戻り値の error を見ていなかったせいで、保存されないまま
 * 「新規獲得」を返していた。修正では保存だけを service role で行う (src/app/api/badges/route.ts)。
 *
 * 自己 INSERT ポリシーを足すと、ログインユーザーが任意のバッジを自分に付与できてしまう。
 * 「ポリシーを足して直す」方向に退行しないよう、次を固定する:
 *   - anon / authenticated は user_badges に INSERT / upsert できない (自分の user_id でも他人の user_id でも 42501)
 *   - authenticated は自分の行を UPDATE / DELETE できない (行は変わらない)
 *   - 本人は自分の行だけ SELECT できる (他人の行は見えない)
 *   - service role は route と同じ upsert (onConflict + ignoreDuplicates) で保存でき、
 *     2 回目以降は「今回挿入できた行」だけを返す (= 既に持っているバッジは「新規獲得」にならない)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/user-badges-insert.test.ts
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
  const email = `rls-1215-${label}-${TS}@homegohan.test`;
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
//   owner: バッジを持つ本人 / other: 別のログインユーザー (他人の行が見えないことの確認用)
// ---------------------------------------------------------------
let owner: TestUser;
let other: TestUser;
/** badges マスタの id (code → id) */
const badgeIds: Record<string, string> = {};
const BADGE_CODES = ['first_bite', 'photo_10', 'streak_3'] as const;

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');

  const { data, error } = await srAdmin.from('badges').select('id, code').in('code', [...BADGE_CODES]);
  if (error) throw new Error(`badges マスタの取得に失敗: ${error.message}`);
  for (const code of BADGE_CODES) {
    const row = (data ?? []).find((b) => b.code === code);
    if (!row) throw new Error(`badges マスタに ${code} がありません (supabase/baseline/prod_reference_data.sql を確認)`);
    badgeIds[code] = row.id;
  }
}, 60_000);

afterAll(async () => {
  const userIds = [owner, other].filter(Boolean).map((u) => u.userId);
  if (userIds.length > 0) {
    // このテストが作ったユーザーの行だけを消す (他のユーザーの user_badges には触れない)
    await srAdmin.from('user_badges').delete().in('user_id', userIds);

    // 後片付けの確認 (残っていれば失敗させる)
    const { data: left } = await srAdmin.from('user_badges').select('user_id').in('user_id', userIds);
    expect(left ?? []).toEqual([]);
  }
  for (const u of [owner, other]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

/** service role で、ユーザーが持つ user_badges の badge_id を数える (RLS の影響を受けない確認用) */
async function badgeIdsOf(userId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('user_badges').select('badge_id').eq('user_id', userId);
  if (error) throw new Error(`badgeIdsOf: ${error.message}`);
  return (data ?? []).map((r) => r.badge_id).sort();
}

// ================================================================
// INSERT / upsert の拒否 (修正前の /api/badges が毎回踏んでいた 42501)
// ================================================================
describe('#1215 user_badges: authenticated / anon は INSERT できない', () => {
  it('B-1: anon は user_badges に書けない (42501)', async () => {
    const { error } = await anonClient()
      .from('user_badges')
      .insert({ user_id: owner.userId, badge_id: badgeIds.first_bite });
    expect(error?.code).toBe('42501');
    expect(await badgeIdsOf(owner.userId)).toEqual([]);
  });

  it('B-2: ログインユーザーは自分の user_id でも書けない (42501)。修正前の /api/badges が毎回これで失敗していた', async () => {
    const { error } = await authedClient(owner.jwt)
      .from('user_badges')
      .insert({ user_id: owner.userId, badge_id: badgeIds.first_bite });
    expect(error?.code).toBe('42501');
    expect(await badgeIdsOf(owner.userId)).toEqual([]);
  });

  it('B-3: ログインユーザーは他人の user_id でも書けない (他人へのバッジ付与の防止)', async () => {
    const { error } = await authedClient(other.jwt)
      .from('user_badges')
      .insert({ user_id: owner.userId, badge_id: badgeIds.first_bite });
    expect(error?.code).toBe('42501');
    expect(await badgeIdsOf(owner.userId)).toEqual([]);
  });

  it('B-4: upsert (ON CONFLICT DO NOTHING) でも同じ。まとめて書く形でも自己付与はできない', async () => {
    const { error } = await authedClient(owner.jwt)
      .from('user_badges')
      .upsert(
        [
          { user_id: owner.userId, badge_id: badgeIds.first_bite },
          { user_id: owner.userId, badge_id: badgeIds.photo_10 },
        ],
        { onConflict: 'user_id,badge_id', ignoreDuplicates: true },
      )
      .select('badge_id');
    expect(error?.code).toBe('42501');
    expect(await badgeIdsOf(owner.userId)).toEqual([]);
  });
});

// ================================================================
// service role の upsert (route.ts が使う形)
// ================================================================
describe('#1215 user_badges: service role の upsert (route.ts と同じ形)', () => {
  it('B-5: 1 回の upsert で複数件を保存でき、返るのは今回挿入できた行だけ。2 回目は既存分を返さない', async () => {
    const options = { onConflict: 'user_id,badge_id', ignoreDuplicates: true };

    // 1 回目: 2 件まとめて保存。DB 既定の obtained_at が付き、2 件とも返る
    const first = await srAdmin
      .from('user_badges')
      .upsert(
        [
          { user_id: owner.userId, badge_id: badgeIds.first_bite },
          { user_id: owner.userId, badge_id: badgeIds.photo_10 },
        ],
        options,
      )
      .select('badge_id, obtained_at');
    expect(first.error).toBeNull();
    expect((first.data ?? []).map((r) => r.badge_id).sort()).toEqual(
      [badgeIds.first_bite, badgeIds.photo_10].sort(),
    );
    for (const row of first.data ?? []) {
      expect(row.obtained_at).toBeTruthy();
    }

    // 2 回目: 既存 2 件 + 新規 1 件。重複があっても全体は失敗せず、返るのは新規の 1 件だけ
    const second = await srAdmin
      .from('user_badges')
      .upsert(
        [
          { user_id: owner.userId, badge_id: badgeIds.first_bite },
          { user_id: owner.userId, badge_id: badgeIds.photo_10 },
          { user_id: owner.userId, badge_id: badgeIds.streak_3 },
        ],
        options,
      )
      .select('badge_id, obtained_at');
    expect(second.error).toBeNull();
    expect((second.data ?? []).map((r) => r.badge_id)).toEqual([badgeIds.streak_3]);

    // 3 回目: 全部既存。エラーにならず、何も返らない (= 「新規獲得」は 0 件)
    const third = await srAdmin
      .from('user_badges')
      .upsert(
        [
          { user_id: owner.userId, badge_id: badgeIds.first_bite },
          { user_id: owner.userId, badge_id: badgeIds.streak_3 },
        ],
        options,
      )
      .select('badge_id, obtained_at');
    expect(third.error).toBeNull();
    expect(third.data ?? []).toEqual([]);

    expect(await badgeIdsOf(owner.userId)).toEqual(
      [badgeIds.first_bite, badgeIds.photo_10, badgeIds.streak_3].sort(),
    );
  });

  it('B-6: 既存行の obtained_at は upsert で上書きされない (獲得日時が毎回変わらない)', async () => {
    const before = await srAdmin
      .from('user_badges')
      .select('obtained_at')
      .eq('user_id', owner.userId)
      .eq('badge_id', badgeIds.first_bite)
      .single();
    expect(before.error).toBeNull();

    const { error } = await srAdmin
      .from('user_badges')
      .upsert([{ user_id: owner.userId, badge_id: badgeIds.first_bite }], {
        onConflict: 'user_id,badge_id',
        ignoreDuplicates: true,
      })
      .select('badge_id');
    expect(error).toBeNull();

    const after = await srAdmin
      .from('user_badges')
      .select('obtained_at')
      .eq('user_id', owner.userId)
      .eq('badge_id', badgeIds.first_bite)
      .single();
    expect(after.data?.obtained_at).toBe(before.data?.obtained_at);
  });
});

// ================================================================
// SELECT / UPDATE / DELETE
// ================================================================
describe('#1215 user_badges: 読み取りは本人の行だけ。更新・削除はできない', () => {
  beforeAll(async () => {
    // 前のテストの結果に依存しないよう、owner に 3 行を用意する (既にあれば何もしない)
    const { error } = await srAdmin.from('user_badges').upsert(
      BADGE_CODES.map((code) => ({ user_id: owner.userId, badge_id: badgeIds[code] })),
      { onConflict: 'user_id,badge_id', ignoreDuplicates: true },
    );
    if (error) throw new Error(`owner の user_badges を用意できません: ${error.message}`);
  });

  it('B-7: 本人は自分の行を読める。別のログインユーザーには見えない (SELECT ポリシーは変更なし)', async () => {
    const own = await authedClient(owner.jwt).from('user_badges').select('badge_id').eq('user_id', owner.userId);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(3);

    const others = await authedClient(other.jwt).from('user_badges').select('badge_id').eq('user_id', owner.userId);
    expect(others.error).toBeNull();
    expect(others.data ?? []).toEqual([]);
  });

  it('B-8: 本人でも自分の行を UPDATE / DELETE できない (ポリシーが無いので 0 行が対象になり、行は変わらない)', async () => {
    const client = authedClient(owner.jwt);

    const updated = await client
      .from('user_badges')
      .update({ message: 'forged' })
      .eq('user_id', owner.userId)
      .select('badge_id');
    expect(updated.data ?? []).toEqual([]);

    const deleted = await client.from('user_badges').delete().eq('user_id', owner.userId).select('badge_id');
    expect(deleted.data ?? []).toEqual([]);

    // service role から見て、行は 3 件のまま・message も書き換わっていない
    expect(await badgeIdsOf(owner.userId)).toHaveLength(3);
    const { data } = await srAdmin.from('user_badges').select('message').eq('user_id', owner.userId);
    expect((data ?? []).every((r) => r.message === null)).toBe(true);
  });
});
