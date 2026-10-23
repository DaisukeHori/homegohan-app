/**
 * #1611 GET /api/family/members/names が、他の家族のメンバーの名前を返さないことを実 RLS で確かめる結合テスト
 *
 * この API (src/app/api/family/members/names/route.ts) は、家族のメンバーの行をログイン中の利用者のクライアント
 * (RLS: family_members_select_self_or_family) で読み、display_name が無い人のプロフィールの名前だけを service_role で引く。
 * service_role で引くのは「RLS で読めた行の user_id」だけなので、他の家族の名前が返らないのは RLS に懸かっている。
 * 単体テスト (モックのクライアント) では RLS が効かないので、ローカル Supabase と dev サーバーに対して確かめる。
 *
 * 確かめること:
 *   - 家族のメンバーは、自分の家族の active なメンバーの名前だけを受け取る (除名済み・他の家族のメンバーは入らない)
 *   - 名前の決め方: display_name → プロフィールの今の名前 → null (仮置きの 'Guest' は名前とみなさない)
 *   - user_profiles.family_id が他の家族を指していても (メンバーではない)、その家族の名前は返らない (RLS で 0 行)
 *   - 除名済みのメンバーは、元の家族の名前を受け取らない
 *   - 未認証は 401
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/family-member-names-scope.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { FAMILY_MEMBER_NAMES_API_PATH, PROFILE_NAME_PLACEHOLDER } from '@/lib/membership/family-member-names';
import type { FamilyMemberNamesData } from '@/schemas/membership/family-member';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { setFamilyGroupPlan } from '../helpers/family-plan';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

/** 準備 (ユーザー 7 人の作成とサインイン・家族 2 つ) の時間切れ */
const SETUP_TIMEOUT_MS = 60_000;
/** 後片付けの時間切れ */
const CLEANUP_TIMEOUT_MS = 30_000;

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

interface TestUser {
  id: string;
  jwt: string;
  nickname: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string, nickname: string): Promise<TestUser> {
  const email = `rls-family-names-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token, nickname };
}

/** 本人の user_profiles.family_id を設定する (家族の画面と API は、これで自分の家族を決める) */
async function setProfileFamily(userId: string, familyId: string | null): Promise<void> {
  const { error } = await srAdmin.from('user_profiles').update({ family_id: familyId }).eq('id', userId);
  if (error) throw new Error(`user_profiles.family_id: ${error.message}`);
}

async function insertMember(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await srAdmin.from('family_members').insert(row).select('id').single();
  if (error || !data) throw new Error(`family_members: ${error?.message}`);
  return data.id as string;
}

let familyF = '';
let familyG = '';

let rep: TestUser; // 家族 F の代表者 (display_name なし → プロフィールの名前)
let adult: TestUser; // 家族 F の大人 (display_name あり → その呼び名)
let guest: TestUser; // 家族 F の大人 (プロフィールの名前が仮置きの 'Guest' → null)
let removed: TestUser; // 家族 F から除名済み
let otherRep: TestUser; // 家族 G の代表者 (F に対しては部外者)
let otherAdult: TestUser; // 家族 G の大人
let intruder: TestUser; // どの家族のメンバーでもないが、user_profiles.family_id だけが G を指している

let repMemberId = '';
let adultMemberId = '';
let guestMemberId = '';
let childMemberId = '';
let removedMemberId = '';
let otherRepMemberId = '';
let otherAdultMemberId = '';

const ADULT_CALL_NAME = `F-papa-${TS}`;
const CHILD_NAME = `F-child-${TS}`;
const OTHER_ADULT_CALL_NAME = `G-mama-${TS}`;

beforeAll(async () => {
  [rep, adult, guest, removed, otherRep, otherAdult, intruder] = await Promise.all([
    createUser('rep', `F-rep-${TS}`),
    createUser('adult', `F-adult-profile-${TS}`),
    createUser('guest', PROFILE_NAME_PLACEHOLDER),
    createUser('removed', `F-removed-${TS}`),
    createUser('other-rep', `G-rep-${TS}`),
    createUser('other-adult', `G-adult-profile-${TS}`),
    createUser('intruder', `X-intruder-${TS}`),
  ]);

  const { data: groups, error: groupError } = await srAdmin
    .from('family_groups')
    .insert([
      { name: `rls-family-names F ${TS}`, representative_id: rep.id },
      { name: `rls-family-names G ${TS}`, representative_id: otherRep.id },
    ])
    .select('id, name');
  if (groupError || !groups) throw new Error(`family_groups: ${groupError?.message}`);
  familyF = groups.find((g) => g.name.startsWith('rls-family-names F'))!.id;
  familyG = groups.find((g) => g.name.startsWith('rls-family-names G'))!.id;
  // billing/03 §6.6: free のグループにはメンバーを足せないので、メンバーを足す前に家族プランにする
  await setFamilyGroupPlan(srAdmin, [familyF, familyG]);

  repMemberId = await insertMember({ family_id: familyF, user_id: rep.id, role: 'representative', status: 'active' });
  adultMemberId = await insertMember({
    family_id: familyF,
    user_id: adult.id,
    role: 'adult',
    display_name: ADULT_CALL_NAME,
    status: 'active',
  });
  guestMemberId = await insertMember({ family_id: familyF, user_id: guest.id, role: 'adult', status: 'active' });
  childMemberId = await insertMember({
    family_id: familyF,
    user_id: null,
    role: 'child',
    display_name: CHILD_NAME,
    child_profile: { birth_year: 2018 },
    birth_date: '2018-04-01', // #1173: アカウント無しの子供の行は生年月日が必須 (CHECK family_members_child_birth_date_required)
    status: 'active',
  });
  removedMemberId = await insertMember({
    family_id: familyF,
    user_id: removed.id,
    role: 'adult',
    status: 'removed',
    removed_at: new Date().toISOString(),
  });
  otherRepMemberId = await insertMember({
    family_id: familyG,
    user_id: otherRep.id,
    role: 'representative',
    status: 'active',
  });
  otherAdultMemberId = await insertMember({
    family_id: familyG,
    user_id: otherAdult.id,
    role: 'adult',
    display_name: OTHER_ADULT_CALL_NAME,
    status: 'active',
  });

  await Promise.all([
    setProfileFamily(rep.id, familyF),
    setProfileFamily(adult.id, familyF),
    setProfileFamily(guest.id, familyF),
    // 除名済みでも、プロフィールの family_id が元の家族のまま残っている場合を確かめる
    setProfileFamily(removed.id, familyF),
    setProfileFamily(otherRep.id, familyG),
    setProfileFamily(otherAdult.id, familyG),
    // メンバーではないのに family_id だけが G を指す (API が family_id を信じても、RLS で行が読めないこと)
    setProfileFamily(intruder.id, familyG),
  ]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  // user_profiles.family_id の参照を外してから家族を消す。
  // family_members は family_groups の削除で CASCADE。family_groups.representative_id は ON DELETE RESTRICT のため、家族を先に消す
  if (createdUserIds.length > 0) {
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  const groupIds = [familyF, familyG].filter(Boolean);
  if (groupIds.length > 0) await srAdmin.from('family_groups').delete().in('id', groupIds);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, CLEANUP_TIMEOUT_MS);

/** API を本人の JWT で呼び、200 であることを確かめて、member id → 名前と本文の文字列を返す */
async function namesFor(user: TestUser): Promise<{ names: Map<string, string | null>; raw: string }> {
  const res = await apiCall<{ data: FamilyMemberNamesData }>('GET', FAMILY_MEMBER_NAMES_API_PATH, user.jwt);
  expect(res.status).toBe(200);
  const names = new Map(res.body.data.members.map((m) => [m.id, m.name] as const));
  return { names, raw: JSON.stringify(res.body) };
}

/** 家族 F の名前 (どれも G の利用者・部外者の応答に出てはいけない) */
function familyFNames(): string[] {
  return [rep.nickname, ADULT_CALL_NAME, adult.nickname, CHILD_NAME, removed.nickname];
}

/** 家族 G の名前 (どれも F の利用者・部外者の応答に出てはいけない) */
function familyGNames(): string[] {
  return [otherRep.nickname, OTHER_ADULT_CALL_NAME, otherAdult.nickname];
}

describe('#1611 GET /api/family/members/names は自分の家族の名前だけを返す (実 RLS)', () => {
  it('N-1: 家族 F の代表者は、F の active なメンバーの名前だけを受け取る (除名済み・G のメンバーは入らない)', async () => {
    const { names, raw } = await namesFor(rep);

    expect([...names.keys()].sort()).toEqual([repMemberId, adultMemberId, guestMemberId, childMemberId].sort());
    expect(names.get(repMemberId)).toBe(rep.nickname); // display_name なし → プロフィールの今の名前
    expect(names.get(adultMemberId)).toBe(ADULT_CALL_NAME); // display_name があればそれ
    expect(names.get(guestMemberId)).toBeNull(); // 仮置きの 'Guest' は名前とみなさない
    expect(names.get(childMemberId)).toBe(CHILD_NAME); // アカウントの無い子供は display_name
    // 除名済みの人の名前、display_name があるメンバーのプロフィールの名前は返さない
    expect(raw).not.toContain(removed.nickname);
    expect(raw).not.toContain(adult.nickname);
    for (const name of familyGNames()) expect(raw).not.toContain(name);
    expect(raw).not.toContain(otherRepMemberId);
    expect(raw).not.toContain(otherAdultMemberId);
  });

  it('N-2: 家族 G の代表者は、G のメンバーの名前だけを受け取る (F の名前は入らない)', async () => {
    const { names, raw } = await namesFor(otherRep);

    expect([...names.keys()].sort()).toEqual([otherRepMemberId, otherAdultMemberId].sort());
    expect(names.get(otherRepMemberId)).toBe(otherRep.nickname);
    expect(names.get(otherAdultMemberId)).toBe(OTHER_ADULT_CALL_NAME);
    for (const name of familyFNames()) expect(raw).not.toContain(name);
  });

  it('N-3: user_profiles.family_id が G を指していても、メンバーでなければ G の名前は返らない (RLS で 0 行)', async () => {
    const { names, raw } = await namesFor(intruder);

    expect([...names.keys()]).toEqual([]);
    for (const name of familyGNames()) expect(raw).not.toContain(name);
  });

  it('N-4: 除名済みのメンバーは、元の家族 F の名前を受け取らない', async () => {
    const { names, raw } = await namesFor(removed);

    expect([...names.keys()]).toEqual([]);
    for (const name of familyFNames().filter((n) => n !== removed.nickname)) expect(raw).not.toContain(name);
  });

  it('N-5: 未認証は 401', async () => {
    const res = await apiCall('GET', FAMILY_MEMBER_NAMES_API_PATH, null);
    expect(res.status).toBe(401);
  });
});
