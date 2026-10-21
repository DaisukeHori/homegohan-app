/**
 * #1678 (#1649 の残り): SQL の RPC が、プロフィールの名前の仮置き 'Guest' を名前として返さない回帰テスト
 *
 * 修正前: 3 つの RPC が user_profiles.nickname をそのまま名前として使っていた。
 *   - get_invite_details (組織・家族): invited_by_name = COALESCE(nickname, email) → 'Guest' が返り、
 *     Web の招待ページ (src/app/invite/[token]/page.tsx) に「Guest 様から招待が届いています」と出た
 *   - get_promotion_details: requested_by_name が同じ形 (src/app/family/promotions/[token]/page.tsx に「Guest 様から」)
 *   - create_family_group: 作成者の nickname を family_members.display_name に写すので、'Guest' が入った
 * 修正後 (20261016200000_rpc_profile_name_placeholder.sql):
 *   - public.normalize_profile_name(text) が @homegohan/shared の normalizeProfileName と同じ判定をする
 *     (Edge Functions の写し supabase/functions/_shared/profile-name.ts とも同じ答えになることを、同じ入力で確かめる)
 *     (前後の空白 = JavaScript の trim と同じ文字を除く・空と仮置きの 'Guest' は NULL)
 *   - get_invite_details / get_promotion_details は、名前が無ければメールアドレスを返す
 *   - create_family_group は、名前が無ければ display_name を NULL にする (前後の空白は除いて写す)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。API ルートは使わず、RPC を直接呼ぶ。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/rpc-profile-name-placeholder.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
// 結合テストの設定 (vitest.integration.config.ts) は @homegohan/shared の別名を持たないので、判定の本体を直接読む
import { PROFILE_NAME_PLACEHOLDER, normalizeProfileName } from '../../../packages/shared/src/profile-name';
// Edge Functions が使う写し (#1649)。正本との一致は tests/edge-profile-name-sync.test.ts が見張る。ここでは SQL とも一致することを見る
import { normalizeProfileName as edgeNormalizeProfileName } from '../../../supabase/functions/_shared/profile-name';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan } from '../helpers/family-plan';

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
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const createdOrgIds: string[] = [];

/** 関数の実行権限が無いときの PostgreSQL のエラーコード */
const PERMISSION_DENIED = '42501';
/** 招待の有効期限 (テストの間に切れなければよい) */
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
/** ユーザーごとのテストが、作成・招待を何本も直列に流すための時間の上限 */
const CASE_TIMEOUT_MS = 60_000;
/** 片付け (家族・組織・ユーザーの削除) の時間の上限 */
const CLEANUP_TIMEOUT_MS = 120_000;
/** BMP (U+0000〜U+FFFF) の最後の符号位置。JavaScript の trim が除く文字はすべて BMP にある */
const LAST_BMP_CODE_POINT = 0xffff;

/** nickname: null は「新規登録しただけで初期設定 (オンボーディング) 前」の人 (プロフィール行が無い) */
async function createUser(label: string, nickname: string | null): Promise<TestUser> {
  const email = `sec-rpc-name-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (nickname !== null) {
    const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
      db.from('user_profiles')
        .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

/** 代表者が create_family_group で家族を作る。代表者のメンバーの行の display_name も返す */
async function createFamilyAs(label: string, nickname: string): Promise<{ rep: TestUser; familyId: string; repDisplayName: string | null }> {
  const rep = await createUser(`rep-${label}`, nickname);
  // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1678 family ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);

  const { data: member, error: memberError } = await srAdmin
    .from('family_members')
    .select('display_name, role')
    .eq('family_id', familyId)
    .eq('user_id', rep.id)
    .single();
  if (memberError || !member) throw new Error(`family_members ${label}: ${memberError?.message}`);
  expect((member as { role: string }).role).toBe('representative');
  return { rep, familyId, repDisplayName: (member as { display_name: string | null }).display_name };
}

/** 家族の招待を (service_role で) 作り、未ログインのまま get_invite_details で引いた招待した人の名前を返す */
async function familyInviterName(label: string, familyId: string, inviter: TestUser): Promise<unknown> {
  const token = `rpc-name-family-${label}-${randomBytes(16).toString('hex')}`;
  const { error } = await srAdmin.from('family_invites').insert({
    family_id: familyId,
    email: `sec-rpc-name-invitee-${label}-${TS}@homegohan.test`,
    token,
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    invited_by: inviter.id,
  });
  if (error) throw new Error(`family_invites ${label}: ${error.message}`);
  const details = await anon().rpc('get_invite_details', { p_token: token });
  expect(details.error).toBeNull();
  expect(details.data).toMatchObject({ scope: 'family', scope_id: familyId });
  return (details.data as { invited_by_name: unknown }).invited_by_name;
}

/** 組織と組織の招待を (service_role で) 作り、未ログインのまま get_invite_details で引いた招待した人の名前を返す */
async function orgInviterName(label: string, nickname: string): Promise<{ owner: TestUser; name: unknown }> {
  const owner = await createUser(`org-owner-${label}`, nickname);
  const { data: org, error: orgError } = await srAdmin
    .from('organizations')
    .insert({ name: `#1678 org ${label} ${TS}`, owner_id: owner.id })
    .select('id')
    .single();
  if (orgError || !org) throw new Error(`organizations ${label}: ${orgError?.message}`);
  const orgId = (org as { id: string }).id;
  createdOrgIds.push(orgId);

  const token = `rpc-name-org-${label}-${randomBytes(16).toString('hex')}`;
  const { error } = await srAdmin.from('organization_invites').insert({
    organization_id: orgId,
    email: `sec-rpc-name-org-invitee-${label}-${TS}@homegohan.test`,
    token,
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    invited_by: owner.id,
  });
  if (error) throw new Error(`organization_invites ${label}: ${error.message}`);
  const details = await anon().rpc('get_invite_details', { p_token: token });
  expect(details.error).toBeNull();
  expect(details.data).toMatchObject({ scope: 'organization', scope_id: orgId });
  return { owner, name: (details.data as { invited_by_name: unknown }).invited_by_name };
}

/** 代表者が子供を足して昇格を依頼し、未ログインのまま get_promotion_details で引いた依頼した人の名前を返す */
async function promotionRequesterName(label: string, nickname: string): Promise<{ rep: TestUser; name: unknown }> {
  const { rep, familyId } = await createFamilyAs(`promo-${label}`, nickname);
  const child = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: `#1678 子供 ${label}`,
    p_child_profile: { age: 12 },
    p_birth_date: '1990-01-01', // #1173: 成人の placeholder (18 歳以上なので保護者の同意は要らない)
  });
  if (child.error || !child.data) throw new Error(`add_family_child ${label}: ${child.error?.message}`);
  const childId = (child.data as { id: string }).id;

  const request = await asUser(rep.jwt).rpc('request_child_promotion', {
    p_member_id: childId,
    p_email: `sec-rpc-name-promoted-${label}-${TS}@homegohan.test`,
  });
  if (request.error || !request.data) throw new Error(`request_child_promotion ${label}: ${request.error?.message}`);
  const token = (request.data as { token: string }).token;

  const details = await anon().rpc('get_promotion_details', { p_token: token });
  expect(details.error).toBeNull();
  expect(details.data).toMatchObject({ member_display_name: `#1678 子供 ${label}`, status: 'pending' });
  return { rep, name: (details.data as { requested_by_name: unknown }).requested_by_name };
}

async function sqlNormalize(value: string | null): Promise<unknown> {
  const { data, error } = await srAdmin.rpc('normalize_profile_name', { p_value: value });
  expect(error, error?.message).toBeNull();
  return data;
}

beforeAll(() => {
  // 判定の前提 (仮置きは 'Guest') が変わったら、migration の 'Guest' も直す必要がある
  expect(PROFILE_NAME_PLACEHOLDER).toBe('Guest');
});

afterAll(async () => {
  for (const id of createdFamilyIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id); // family_members / family_invites / 昇格の依頼は CASCADE
  }
  for (const id of createdOrgIds) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('organization_invites').delete().eq('organization_id', id);
    await srAdmin.from('organizations').delete().eq('id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, CLEANUP_TIMEOUT_MS);

describe('#1678 normalize_profile_name (SQL) は normalizeProfileName (TS の正本・Edge の写し) と同じ答えを返す', () => {
  // 仮置き・空・空白・大小違い・実名・NULL と、JavaScript の trim が除く / 除かない文字の境目
  const PARITY_CASES: ReadonlyArray<readonly [label: string, value: string | null]> = [
    ['仮置き', 'Guest'],
    ['前後に空白のある仮置き', ' Guest '],
    ['全角の空白と改行で囲んだ仮置き', '　Guest\n'],
    ['空', ''],
    ['空白だけ', ' \t '],
    ['全角の空白だけ', '　　'],
    ['ノーブレークスペースだけ', ' '],
    ['小文字の guest (本人の名前)', 'guest'],
    ['仮置きの中に空白 (本人の名前)', 'Gu est'],
    ['仮置きが 2 つ (本人の名前)', 'Guest Guest'],
    ['カタカナのゲスト (本人の名前)', 'ゲスト'],
    ['実名', '山田 太郎'],
    ['前後に空白のある実名', ' 山田 太郎 '],
    ['BOM とノーブレークスペースで囲んだ実名', ' たろう﻿'],
    // U+200B (ゼロ幅スペース) と U+180E は JavaScript の trim が除かない
    ['ゼロ幅スペースは除かない', '​たろう'],
    ['U+180E は除かない', '᠎たろう'],
    ['NULL', null],
  ];

  it.each(PARITY_CASES)('%s', async (_label, value) => {
    const sql = await sqlNormalize(value);
    expect(sql).toBe(normalizeProfileName(value));
    expect(sql, 'Edge の写し').toBe(edgeNormalizeProfileName(value));
  });

  it('期待値の確認: 上の対応表で、名前なし (null) と名前の両方が含まれる', () => {
    const results = PARITY_CASES.map(([, value]) => normalizeProfileName(value));
    expect(results).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'guest',
      'Gu est',
      'Guest Guest',
      'ゲスト',
      '山田 太郎',
      '山田 太郎',
      'たろう',
      '​たろう',
      '᠎たろう',
      null,
    ]);
  });

  it('JavaScript の trim が除く文字をすべて前後に付けても、同じ答えになる (仮置きは null・名前は前後を除く)', async () => {
    let jsWhitespace = '';
    for (let cp = 0; cp <= LAST_BMP_CODE_POINT; cp += 1) {
      const ch = String.fromCharCode(cp);
      if (ch.trim() === '') jsWhitespace += ch;
    }
    for (const core of [PROFILE_NAME_PLACEHOLDER, 'はなこ']) {
      const padded = `${jsWhitespace}${core}${jsWhitespace}`;
      const sql = await sqlNormalize(padded);
      expect(sql, core).toBe(normalizeProfileName(padded));
      expect(sql, `${core} (Edge の写し)`).toBe(edgeNormalizeProfileName(padded));
    }
  });

  it('未ログイン (anon)・ログインユーザー (authenticated) は直接呼べない (42501)。呼ぶのは 3 つの RPC の中だけ', async () => {
    const user = await createUser('caller', '#1678 呼び出し');
    for (const [who, api] of [
      ['anon', anon()],
      ['authenticated', asUser(user.jwt)],
    ] as const) {
      const { data, error } = await api.rpc('normalize_profile_name', { p_value: 'Guest' });
      expect(error?.code, `${who}: ${error?.message}`).toBe(PERMISSION_DENIED);
      expect(data).toBeNull();
    }
  }, CASE_TIMEOUT_MS);
});

describe('#1678 create_family_group は、仮置きの名前を display_name に写さない', () => {
  const CASES: ReadonlyArray<readonly [label: string, nickname: string, expected: string | null]> = [
    ['guest', 'Guest', null],
    ['guest-padded', ' Guest　', null],
    ['blank', ' \t ', null],
    ['named', ' はなこ ', 'はなこ'],
    ['guest-lower', 'guest', 'guest'],
  ];
  it.each(CASES)('%s', async (label, nickname, expected) => {
    const { repDisplayName } = await createFamilyAs(`create-${label}`, nickname);
    expect(repDisplayName).toBe(expected);
    expect(repDisplayName).toBe(normalizeProfileName(nickname));
  }, CASE_TIMEOUT_MS);
});

describe("#1678 get_invite_details は、招待した人の名前に 'Guest' を返さずメールアドレスにフォールバックする", () => {
  it("家族の招待: 招待した人の名前が 'Guest' ならメールアドレス", async () => {
    const { rep, familyId } = await createFamilyAs('invite-guest', 'Guest');
    const name = await familyInviterName('guest', familyId, rep);
    expect(name).toBe(rep.email);
    expect(name).not.toBe(PROFILE_NAME_PLACEHOLDER);
  }, CASE_TIMEOUT_MS);

  it('家族の招待: 招待した人の名前が空白だけならメールアドレス', async () => {
    const { rep, familyId } = await createFamilyAs('invite-blank', '　 ');
    expect(await familyInviterName('blank', familyId, rep)).toBe(rep.email);
  }, CASE_TIMEOUT_MS);

  it('家族の招待: 名前があれば、前後の空白を除いた名前', async () => {
    const { rep, familyId } = await createFamilyAs('invite-named', ' 山田花子 ');
    expect(await familyInviterName('named', familyId, rep)).toBe('山田花子');
  }, CASE_TIMEOUT_MS);

  it("組織の招待: 招待した人の名前が 'Guest' ならメールアドレス", async () => {
    const { owner, name } = await orgInviterName('guest', ' Guest ');
    expect(name).toBe(owner.email);
  }, CASE_TIMEOUT_MS);

  it('組織の招待: 名前があれば、その名前', async () => {
    const { name } = await orgInviterName('named', '佐藤');
    expect(name).toBe('佐藤');
  }, CASE_TIMEOUT_MS);
});

describe("#1678 get_promotion_details は、依頼した人の名前に 'Guest' を返さずメールアドレスにフォールバックする", () => {
  it("依頼した人の名前が 'Guest' ならメールアドレス", async () => {
    const { rep, name } = await promotionRequesterName('guest', 'Guest');
    expect(name).toBe(rep.email);
    expect(name).not.toBe(PROFILE_NAME_PLACEHOLDER);
  }, CASE_TIMEOUT_MS);

  it('名前があれば、前後の空白を除いた名前', async () => {
    const { name } = await promotionRequesterName('named', ' 鈴木 ');
    expect(name).toBe('鈴木');
  }, CASE_TIMEOUT_MS);
});
