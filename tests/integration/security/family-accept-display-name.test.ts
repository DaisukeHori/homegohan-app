/**
 * #1584 の 2: 家族の招待・子供の昇格を承諾したメンバーの display_name に、本人のプロフィールの名前を写す回帰テスト
 *
 * 修正前: accept_family_invite は family_members の行を display_name なし (NULL) で作り、
 *   display_name だけを読む所 (週間献立の家族の表示の切り替え) では名前が無いままだった。
 * 修正後 (20261015170000_accept_copies_profile_name.sql):
 *   - accept_family_invite: 承諾した本人の user_profiles.nickname を、@homegohan/shared の normalizeProfileName と同じ判定で写す
 *     (前後の空白を除く・空白だけと仮置きの 'Guest' は写さず NULL のまま・プロフィールの行が無い人も NULL のまま)
 *   - accept_child_promotion: 子供のときの display_name が入っていれば上書きしない。空 (NULL・空白だけ) のときだけ写す
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。API ルートは使わず、RPC を直接呼ぶ。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-accept-display-name.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
// 結合テストの設定 (vitest.integration.config.ts) は @homegohan/shared の別名を持たないので、判定の本体を直接読む
import { PROFILE_NAME_PLACEHOLDER, normalizeProfileName } from '../../../packages/shared/src/profile-name';
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

/** ユーザーごとのテストが、作成・招待・承諾を何本も直列に流すための時間の上限 */
const CASE_TIMEOUT_MS = 60_000;
/** 片付け (家族・ユーザーの削除) の時間の上限 */
const CLEANUP_TIMEOUT_MS = 120_000;

/** nickname: null は「新規登録しただけで初期設定 (オンボーディング) 前」の人 (プロフィール行が無い) */
async function createUser(label: string, nickname: string | null): Promise<TestUser> {
  const email = `sec-accept-name-${label}-${TS}@homegohan.test`;
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

/** 代表者を作り、家族を 1 つ作る (1 ケース 1 家族。人数の上限に当たらないように) */
async function createFamily(label: string): Promise<{ rep: TestUser; familyId: string }> {
  const rep = await createUser(`rep-${label}`, `#1584 代表者 ${label}`);
  // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れるので、作る前に家族プランを手動付与する
  await grantFamilyPlan(srAdmin, rep.id);
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1584 family ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  return { rep, familyId };
}

/** 家族の招待を作り、宛先の人が承諾する。承諾で作られたメンバーの行の display_name を返す */
async function inviteAndAccept(label: string, nickname: string | null): Promise<{ displayName: string | null; member: TestUser }> {
  const { rep, familyId } = await createFamily(label);
  const member = await createUser(`member-${label}`, nickname);
  const invite = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: member.email });
  if (invite.error || !invite.data) throw new Error(`create_family_invite ${label}: ${invite.error?.message}`);
  const token = (invite.data as { token: string }).token;

  const { data, error } = await asUser(member.jwt).rpc('accept_family_invite', { p_token: token });
  expect(error).toBeNull();
  const returned = data as { id: string; family_id: string; user_id: string; display_name: string | null };
  expect(returned).toMatchObject({ family_id: familyId, user_id: member.id });

  // 戻り値 (RETURNING *) と、表に残った行が同じ名前
  const stored = await memberDisplayName(returned.id);
  expect(returned.display_name).toBe(stored);
  return { displayName: stored, member };
}

async function memberDisplayName(memberId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('family_members').select('display_name').eq('id', memberId).single();
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data as { display_name: string | null }).display_name;
}

async function nicknameOf(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('nickname').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return (data as { nickname: string | null } | null)?.nickname ?? null;
}

/** 子供を足し、昇格の依頼を出し、宛先の人が承諾する。承諾後の子供の行の display_name を返す */
async function promoteChild(
  label: string,
  childName: string,
  nickname: string | null,
  overrideChildName?: string | null,
): Promise<string | null> {
  // ラベルは招待のケースと重ならないよう promo- を付ける (メールアドレスがラベルから作られるため)
  const { rep, familyId } = await createFamily(`promo-${label}`);
  const child = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: childName,
    p_child_profile: { age: 12 },
    p_birth_date: '1990-01-01', // #1173: 成人の placeholder (18 歳以上なので保護者の同意は要らない)
  });
  if (child.error || !child.data) throw new Error(`add_family_child ${label}: ${child.error?.message}`);
  const childId = (child.data as { id: string }).id;

  // 子供の呼び名が空の行 (NULL・空白だけ) を作るには、アプリの経路が無いので service_role で書き換える
  if (overrideChildName !== undefined) {
    const { error } = await srAdmin.from('family_members').update({ display_name: overrideChildName }).eq('id', childId);
    if (error) throw new Error(`override child name ${label}: ${error.message}`);
  }

  const promoted = await createUser(`promoted-${label}`, nickname);
  const request = await asUser(rep.jwt).rpc('request_child_promotion', { p_member_id: childId, p_email: promoted.email });
  if (request.error || !request.data) throw new Error(`request_child_promotion ${label}: ${request.error?.message}`);
  const token = (request.data as { token: string }).token;

  const { data, error } = await asUser(promoted.jwt).rpc('accept_child_promotion', { p_token: token });
  expect(error).toBeNull();
  const returned = data as { id: string; user_id: string; display_name: string | null };
  expect(returned).toMatchObject({ id: childId, user_id: promoted.id });

  const stored = await memberDisplayName(childId);
  expect(returned.display_name).toBe(stored);
  return stored;
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
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, CLEANUP_TIMEOUT_MS);

describe('#1584 家族の招待の承諾 (accept_family_invite) で、プロフィールの名前を display_name に写す', () => {
  it('名前があれば、前後の空白を除いて写す', async () => {
    const { displayName } = await inviteAndAccept('named', '  はなこ  ');
    expect(displayName).toBe('はなこ');
  }, CASE_TIMEOUT_MS);

  it("仮置きの 'Guest' は写さない (NULL のまま)", async () => {
    const { displayName } = await inviteAndAccept('guest', 'Guest');
    expect(displayName).toBeNull();
  }, CASE_TIMEOUT_MS);

  it('初期設定より前 (プロフィールの行が無い) の人は写さない。プロフィールの行は仮置きの名前で作られる', async () => {
    const { displayName, member } = await inviteAndAccept('no-profile', null);
    expect(displayName).toBeNull();
    expect(await nicknameOf(member.id)).toBe('Guest');
  }, CASE_TIMEOUT_MS);

  // DB の判定と、画面・API が使う normalizeProfileName (packages/shared/src/profile-name.ts) が同じ結果になること。
  // 全角の空白 (U+3000)・改行・ノーブレークスペース (U+00A0)・BOM (U+FEFF) も、JavaScript の trim と同じく除く
  const PARITY_CASES: ReadonlyArray<readonly [label: string, nickname: string]> = [
    ['ws-only', ' \t '],
    ['ideographic-ws-only', '　　'],
    ['guest-padded', '　Guest\n'],
    ['guest-lower', 'guest'],
    ['guest-katakana', 'ゲスト'],
    ['nbsp-bom', ' たろう﻿'],
    ['inner-space', ' 山田 太郎 '],
  ];
  for (const [label, nickname] of PARITY_CASES) {
    it(`判定は normalizeProfileName と同じ: ${label}`, async () => {
      const { displayName } = await inviteAndAccept(`parity-${label}`, nickname);
      expect(displayName).toBe(normalizeProfileName(nickname));
    }, CASE_TIMEOUT_MS);
  }

  it('期待値の確認: 上の対応表で、写らないもの・写るものの両方が含まれる', () => {
    const results = PARITY_CASES.map(([, nickname]) => normalizeProfileName(nickname));
    expect(results).toEqual([null, null, null, 'guest', 'ゲスト', 'たろう', '山田 太郎']);
  });
});

describe('#1584 子供の昇格の承諾 (accept_child_promotion) は、子供のときの呼び名を上書きしない', () => {
  it('子供の呼び名が入っていれば、プロフィールの名前があっても上書きしない', async () => {
    expect(await promoteChild('keep', 'たろう', '山田太郎')).toBe('たろう');
  }, CASE_TIMEOUT_MS);

  it('子供の呼び名が NULL なら、プロフィールの名前を写す', async () => {
    expect(await promoteChild('fill-null', 'じろう', ' 山田次郎 ', null)).toBe('山田次郎');
  }, CASE_TIMEOUT_MS);

  it('子供の呼び名が空白だけなら、プロフィールの名前を写す', async () => {
    expect(await promoteChild('fill-blank', 'さぶろう', '山田三郎', '　 ')).toBe('山田三郎');
  }, CASE_TIMEOUT_MS);

  it("子供の呼び名が NULL でも、プロフィールの名前が 'Guest' なら写さない (NULL のまま)", async () => {
    expect(await promoteChild('guest', 'しろう', 'Guest', null)).toBeNull();
  }, CASE_TIMEOUT_MS);

  it('子供の呼び名が空白だけで、プロフィールの行が無い人なら、空白のまま変えない', async () => {
    expect(await promoteChild('no-profile', 'ごろう', null, '  ')).toBe('  ');
  }, CASE_TIMEOUT_MS);
});
