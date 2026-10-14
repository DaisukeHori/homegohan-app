/**
 * #1238 organization_challenge_participants の INSERT / UPDATE に組織スコープを付けることの回帰テスト
 *
 * 修正前のポリシー (20260511000137_backfill_oob_remaining.sql。本番 baseline も同じ) は
 *   "Users can join challenges"          INSERT  WITH CHECK (user_id = auth.uid())   ← challenge_id の組織を見ない
 *   "Users can update own participation" UPDATE  USING (user_id = auth.uid())        ← 同じく組織を見ず、current_value を自由に書ける
 * のため、組織 A のユーザーが組織 B の challenge_id で参加行を作る・実績 (current_value) を水増しできた
 * (外部キーの確認は RLS を通らないため、他組織の challenge_id でも入る)。
 * B の管理画面 (src/app/api/org/challenges/route.ts の participantCount) には見知らぬ参加者として現れる。
 *
 * 期待する認可 (修正後。設計: docs/design/org/09-rls-policies.md の participants):
 *   - INSERT: 本人 (user_id = auth.uid()) が、自分の所属組織のチャレンジに、進捗 0・順位なしで参加する場合だけ
 *   - UPDATE: 利用者からは更新させない (ポリシー無し)。進捗・順位の更新は service_role のバッチだけ
 *   - SELECT: 変更なし (チャレンジの組織のメンバーだけが見える)
 *   - DELETE: 変更なし (ポリシー無し。暗黙 DENY)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/challenge-participants-org-scope.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `rls-chpart-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `rls-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** 所属は特権列のため service_role で設定する */
async function setMembership(userId: string, orgId: string | null) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({
      organization_id: orgId,
      org_role: orgId ? 'member' : null,
      is_active_in_org: orgId !== null,
      roles: ['user'],
    })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

async function createChallenge(orgId: string, title: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: orgId,
      title,
      challenge_type: 'custom',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organization_challenges: ${error?.message}`);
  return data.id;
}

async function participantRows(challengeId: string, userId: string) {
  const { data, error } = await srAdmin
    .from('organization_challenge_participants')
    .select('id, current_value, rank')
    .eq('challenge_id', challengeId)
    .eq('user_id', userId);
  if (error) throw new Error(`participants: ${error.message}`);
  return data ?? [];
}

let orgA = '';
let orgB = '';
let challengeA = '';
let challengeB = '';

let a1: TestUser; // A のメンバー (参加の INSERT を試す)
let a2: TestUser; // A のメンバー (service_role が参加行を用意済み。UPDATE / DELETE を試す)
let a3: TestUser; // A のメンバー (進捗を水増しした INSERT を試す)
let a4: TestUser; // A のメンバー (順位を指定した INSERT を試す)
let a5: TestUser; // A のメンバー (他人・未ログインによる「なりすまし参加」の対象)
let b1: TestUser; // B のメンバー (service_role が参加行を用意済み)
let noOrg: TestUser; // どの組織にも所属しない

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1238 Org A ${TS}` }, { name: `#1238 Org B ${TS}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1238 Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1238 Org B'))!.id;

  [a1, a2, a3, a4, a5, b1, noOrg] = await Promise.all([
    createUser('a1'),
    createUser('a2'),
    createUser('a3'),
    createUser('a4'),
    createUser('a5'),
    createUser('b1'),
    createUser('no-org'),
  ]);

  await setMembership(a1.id, orgA);
  await setMembership(a2.id, orgA);
  await setMembership(a3.id, orgA);
  await setMembership(a4.id, orgA);
  await setMembership(a5.id, orgA);
  await setMembership(b1.id, orgB);

  challengeA = await createChallenge(orgA, 'A challenge');
  challengeB = await createChallenge(orgB, 'B challenge');

  // service_role で参加行を用意する (UPDATE / DELETE / SELECT の検証用)
  const { error: seedError } = await srAdmin.from('organization_challenge_participants').insert([
    { challenge_id: challengeA, user_id: a2.id, current_value: 10 },
    { challenge_id: challengeB, user_id: b1.id, current_value: 20 },
  ]);
  if (seedError) throw new Error(`seed participants: ${seedError.message}`);
}, 120_000);

afterAll(async () => {
  // 参加行は challenge の削除 (organizations の削除による CASCADE) とユーザーの削除で消える。
  // 所属は先に外す (owner_id 等の参照に備える)
  for (const id of createdUserIds) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .eq('id', id);
  }
  await srAdmin.from('organization_challenge_participants').delete().in('user_id', createdUserIds);
  if (orgA || orgB) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

// ================================================================
// INSERT
// ================================================================
describe('#1238 INSERT: 参加は自分の所属組織のチャレンジだけ', () => {
  it('S-1: 組織 A のメンバーは、組織 B のチャレンジに参加できない', async () => {
    const { error } = await asUser(a1.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeB, user_id: a1.id });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501'); // new row violates row-level security policy
    expect(await participantRows(challengeB, a1.id)).toHaveLength(0);
  });

  it('S-2: 組織 A のメンバーは、組織 A のチャレンジに参加できる (正当な経路)', async () => {
    const { error } = await asUser(a1.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: a1.id });
    expect(error).toBeNull();
    const rows = await participantRows(challengeA, a1.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].current_value)).toBe(0);
  });

  it('S-3: 他人の user_id では参加させられない (組織が同じでも)', async () => {
    const { error } = await asUser(a1.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: a5.id });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(await participantRows(challengeA, a5.id)).toHaveLength(0);
  });

  it('S-4: どの組織にも所属しないユーザーは参加できない', async () => {
    const { error } = await asUser(noOrg.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: noOrg.id });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(await participantRows(challengeA, noOrg.id)).toHaveLength(0);
  });

  it('S-5: 参加時に進捗 (current_value) を水増しして入れられない', async () => {
    const { error } = await asUser(a3.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: a3.id, current_value: 999999 });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(await participantRows(challengeA, a3.id)).toHaveLength(0);
  });

  it('S-6: 参加時に順位 (rank) を指定して入れられない', async () => {
    const { error } = await asUser(a4.jwt)
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: a4.id, rank: 1 });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(await participantRows(challengeA, a4.id)).toHaveLength(0);
  });

  it('S-7: 未ログイン (anon) は参加できない', async () => {
    const { error } = await anon()
      .from('organization_challenge_participants')
      .insert({ challenge_id: challengeA, user_id: a5.id });
    expect(error).not.toBeNull();
    expect(await participantRows(challengeA, a5.id)).toHaveLength(0);
  });
});

// ================================================================
// UPDATE / DELETE
// ================================================================
describe('#1238 UPDATE: 利用者からは更新できない (service_role だけ)', () => {
  it('S-8: 自分の参加行の current_value / rank を書き換えられない', async () => {
    const { data, error } = await asUser(a2.jwt)
      .from('organization_challenge_participants')
      .update({ current_value: 999999, rank: 1 })
      .eq('challenge_id', challengeA)
      .eq('user_id', a2.id)
      .select('id');
    // ポリシーが無いと、エラーにならず 0 件更新になる
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
    const rows = await participantRows(challengeA, a2.id);
    expect(Number(rows[0].current_value)).toBe(10);
    expect(rows[0].rank).toBeNull();
  });

  it('S-9: service_role は更新できる (バッチによる進捗更新の経路)', async () => {
    const { data, error } = await srAdmin
      .from('organization_challenge_participants')
      .update({ current_value: 42, rank: 3 })
      .eq('challenge_id', challengeA)
      .eq('user_id', a2.id)
      .select('id, current_value, rank');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(Number(data![0].current_value)).toBe(42);
    expect(data![0].rank).toBe(3);
  });

  it('S-10: 参加の取り消し (DELETE) のポリシーは無いまま (変更なし)', async () => {
    const { data, error } = await asUser(a2.jwt)
      .from('organization_challenge_participants')
      .delete()
      .eq('challenge_id', challengeA)
      .eq('user_id', a2.id)
      .select('id');
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
    expect(await participantRows(challengeA, a2.id)).toHaveLength(1);
  });
});

// ================================================================
// SELECT (変更なしの確認)
// ================================================================
describe('#1238 SELECT: 閲覧範囲は変わらない', () => {
  it('S-11: 自分の組織のチャレンジの参加者は見える', async () => {
    const { data, error } = await asUser(b1.jwt)
      .from('organization_challenge_participants')
      .select('user_id')
      .eq('challenge_id', challengeB);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.user_id)).toContain(b1.id);
  });

  it('S-12: 他の組織のチャレンジの参加者は見えない', async () => {
    const { data, error } = await asUser(a1.jwt)
      .from('organization_challenge_participants')
      .select('user_id')
      .eq('challenge_id', challengeB);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});
