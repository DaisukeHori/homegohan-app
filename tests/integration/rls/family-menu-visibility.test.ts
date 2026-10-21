/**
 * #1584 の 1: 家族の献立を読む SECURITY DEFINER の関数 2 本 (family_menu_visible_members・family_menu_planned_meals) と
 * GET /api/family/menu が、見てよい相手の献立だけを、画面に要る鍵だけで返すことを実 DB で確かめる結合テスト。
 * 設計書 docs/design/family/10-family-menu-view.md §11・§19.3。
 *
 * 準備は tests/integration/rls/family-member-names-scope.test.ts を写す (家族 F・G、除名済みで family_id が残った removed、
 * 行が無いのに family_id だけが G を指す intruder)。それに、退会の it 専用の大人 1 人・昇格の it 専用の 2 人・
 * 家族 H の it 専用の 3 人 (家族を作る 1 人と、招待を承諾する 2 人) を足して 13 人。
 * family_menu_planned_meals の結果は jsonb の配列 1 つなので、本ファイルの「行」はその配列の要素、
 * 「0 行」は family_menu_visible_members が 0 行・family_menu_planned_meals が空の配列 [] を返すことをいう。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/family-menu-visibility.test.ts
 * 本番には接続しない。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { MEAL_ORDER } from '@homegohan/shared';
import { apiCall } from '../helpers/api';
import { FAMILY_MENU_API_PATH, FAMILY_MENU_RANGE_MAX_DAYS } from '@/lib/membership/family-menu';
import { FamilyMenuDataSchema, FamilyMenuRpcRowSchema } from '@/schemas/membership/family-menu';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { grantFamilyPlan, setFamilyGroupPlan } from '../helpers/family-plan';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

/** 準備 (ユーザー 10 人の作成とサインイン・家族 2 つ・献立) の時間切れ */
const SETUP_TIMEOUT_MS = 120_000;
/** 後片付けの時間切れ */
const CLEANUP_TIMEOUT_MS = 120_000;
/** 1 つの it の時間切れ (利用者の作成・RPC の往復・1,085 食の書き込みを含む) */
const CASE_TIMEOUT_MS = 120_000;
/** PostgreSQL の「権限が無い」(insufficient_privilege) */
const PERMISSION_DENIED = '42501';
/** PostgREST の max_rows の既定 (Supabase)。行の集合を返す RPC はこの行数で黙って打ち切られる (tests/integration/security/llm-usage-summary.test.ts と同じ名前) */
const POSTGREST_DEFAULT_MAX_ROWS = 1000;
/** max_rows の it で 1 日に足す献立の数 (31 日 × 35 食 = 1,085 食 > POSTGREST_DEFAULT_MAX_ROWS) */
const BULK_MEALS_PER_DAY = 35;
/** 1 回の insert で送る planned_meals の行の数 (リクエストの大きさを抑える) */
const INSERT_CHUNK_ROWS = 500;
/** 家族 F の人数の上限 (family_groups.member_limit の CHECK の最大。昇格の it で子供 2 人が大人になっても当たらない) */
const FAMILY_F_MEMBER_LIMIT = 20;
/** 家族 G の人数の上限 (family_groups.member_limit の列の既定と同じ) */
const FAMILY_G_MEMBER_LIMIT = 4;
/** 関数の結果の要素 (1 食) の鍵の数 (設計書 §11.1・§13) */
const RPC_ELEMENT_KEY_COUNT = 12;

/** 画面が取る 1 週の範囲 (固定の暦日。テストの利用者は毎回新しいので他のデータと混ざらない) */
const WEEK_START = '2026-10-12';
const WEEK_END = '2026-10-18';
const DAY_GUEST = '2026-10-13';
const DAY_ADULT = '2026-10-14';
const DAY_SANDBOX = '2026-10-15';
const DAY_DELETED = '2026-10-16';
const DAY_PROMOTED = '2026-10-17';
/** 鍵と dish_names の it が献立を足す日 (他の it と別の日) */
const DAY_KEYS = '2026-10-18';
/** 範囲の外の日 (WEEK の翌々日) */
const DAY_OUT_OF_RANGE = '2026-10-20';
/** max_rows の it の 31 日 (他の it が使わない) */
const BULK_START = '2026-11-01';
const BULK_END = '2026-12-01';
/** 家族 H の it が献立を足す日 */
const DAY_FAMILY_H = '2026-10-15';

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
  nickname: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];

async function createUser(label: string, nickname: string): Promise<TestUser> {
  const email = `rls-family-menu-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token, nickname };
}

async function setProfileFamily(userId: string, familyId: string | null): Promise<void> {
  const { error } = await srAdmin.from('user_profiles').update({ family_id: familyId }).eq('id', userId);
  if (error) throw new Error(`user_profiles.family_id: ${error.message}`);
}

async function insertMember(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await srAdmin.from('family_members').insert(row).select('id').single();
  if (error || !data) throw new Error(`family_members: ${error?.message}`);
  return data.id as string;
}

async function setShareMenu(memberId: string, shareMenu: boolean): Promise<void> {
  const { error } = await srAdmin.from('family_members').update({ share_menu: shareMenu }).eq('id', memberId);
  if (error) throw new Error(`share_menu: ${error.message}`);
}

/** 1 日分の user_daily_meals を 1 行作り、その id を返す */
async function insertDay(userId: string, dayDate: string, isSandbox = false): Promise<string> {
  const { data, error } = await srAdmin
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: dayDate, is_sandbox: isSandbox })
    .select('id')
    .single();
  if (error || !data) throw new Error(`user_daily_meals ${dayDate}: ${error?.message}`);
  return data.id as string;
}

/** 献立を 1 日・1 食足し、planned_meals の id を返す */
async function insertMeal(
  userId: string,
  dayDate: string,
  dishName: string,
  options: { isSandbox?: boolean; extra?: Record<string, unknown> } = {},
): Promise<{ dailyMealId: string; mealId: string }> {
  const dailyMealId = await insertDay(userId, dayDate, options.isSandbox ?? false);
  const { data, error } = await srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'dinner', dish_name: dishName, ...options.extra })
    .select('id')
    .single();
  if (error || !data) throw new Error(`planned_meals ${dishName}: ${error?.message}`);
  return { dailyMealId, mealId: data.id as string };
}

async function deleteDays(dailyMealIds: string[]): Promise<void> {
  if (dailyMealIds.length === 0) return;
  // planned_meals は CASCADE で消える
  await srAdmin.from('user_daily_meals').delete().in('id', dailyMealIds);
}

interface VisibleRow {
  member_id: string;
  user_id: string;
}

async function visibleMembers(user: TestUser): Promise<VisibleRow[]> {
  const { data, error } = await asUser(user.jwt).rpc('family_menu_visible_members');
  if (error) throw new Error(`family_menu_visible_members: ${error.message}`);
  return (data ?? []) as VisibleRow[];
}

async function plannedMealsRaw(user: TestUser, start = WEEK_START, end = WEEK_END) {
  return asUser(user.jwt).rpc('family_menu_planned_meals', { p_start_date: start, p_end_date: end });
}

/** 献立の配列 (要素は jsonb の 1 食)。配列でなければ失敗にする */
async function plannedMeals(user: TestUser, start = WEEK_START, end = WEEK_END): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await plannedMealsRaw(user, start, end);
  if (error) throw new Error(`family_menu_planned_meals: ${error.message}`);
  expect(Array.isArray(data)).toBe(true);
  return data as Array<Record<string, unknown>>;
}

const mealIdsOf = (meals: Array<Record<string, unknown>>): string[] => meals.map((m) => String(m.id));
const memberIdsOf = (rows: VisibleRow[]): string[] => rows.map((r) => r.member_id);

let familyF = '';
let familyG = '';

let rep: TestUser; // 家族 F の代表者 (主な見る人)
let adult: TestUser; // 家族 F の大人 (share_menu TRUE)
let guest: TestUser; // 家族 F の大人 (share_menu を it の中で切り替える)
let removed: TestUser; // 家族 F から除名済み (family_id は F のまま)
let otherRep: TestUser; // 家族 G の代表者
let otherAdult: TestUser; // 家族 G の大人 (家族 F には left の行も持つ)
let intruder: TestUser; // どの家族のメンバーでもないが、user_profiles.family_id だけが G を指している
let deleted: TestUser; // 家族 F の大人 (代表者でない)。退会の it で消す
let promotedOff: TestUser; // 昇格の承諾で p_share_menu = false
let promotedOn: TestUser; // 昇格の承諾で既定 (TRUE)

let repMemberId = '';
let adultMemberId = '';
let guestMemberId = '';
let childMemberId = '';
let removedMemberId = '';
let leftMemberId = '';
let deletedMemberId = '';
let promoChildOffId = '';
let promoChildOnId = '';
let otherRepMemberId = '';
let otherAdultMemberId = '';

/** 準備で足した献立の id */
const meal: Record<string, string> = {};

beforeAll(async () => {
  [rep, adult, guest, removed, otherRep, otherAdult, intruder, deleted, promotedOff, promotedOn] = await Promise.all([
    createUser('rep', `F-rep-${TS}`),
    createUser('adult', `F-adult-${TS}`),
    createUser('guest', `F-guest-${TS}`),
    createUser('removed', `F-removed-${TS}`),
    createUser('other-rep', `G-rep-${TS}`),
    createUser('other-adult', `G-adult-${TS}`),
    createUser('intruder', `X-intruder-${TS}`),
    createUser('deleted', `F-deleted-${TS}`),
    createUser('promoted-off', `F-promoted-off-${TS}`),
    createUser('promoted-on', `F-promoted-on-${TS}`),
  ]);

  // 家族 F は昇格の it で子供 2 人が大人になるので、人数の上限を最大 (20) にしておく
  const { data: groups, error: groupError } = await srAdmin
    .from('family_groups')
    .insert([
      { name: `rls-family-menu F ${TS}`, representative_id: rep.id, member_limit: FAMILY_F_MEMBER_LIMIT },
      // 複数の行を 1 回で insert すると、どれかの行にしか無い列は他の行で NULL になるので、G にも member_limit を書く (列の既定と同じ 4)
      { name: `rls-family-menu G ${TS}`, representative_id: otherRep.id, member_limit: FAMILY_G_MEMBER_LIMIT },
    ])
    .select('id, name');
  if (groupError || !groups) throw new Error(`family_groups: ${groupError?.message}`);
  familyF = groups.find((g) => g.name.startsWith('rls-family-menu F'))!.id;
  familyG = groups.find((g) => g.name.startsWith('rls-family-menu G'))!.id;
  createdFamilyIds.push(familyF, familyG);
  // billing/03 §6.6: free のグループにはメンバーを足せないので、メンバーを足す前に家族プランにする (member_limit はそのまま)
  await setFamilyGroupPlan(srAdmin, [familyF, familyG]);

  repMemberId = await insertMember({ family_id: familyF, user_id: rep.id, role: 'representative', status: 'active' });
  adultMemberId = await insertMember({ family_id: familyF, user_id: adult.id, role: 'adult', status: 'active' });
  guestMemberId = await insertMember({ family_id: familyF, user_id: guest.id, role: 'adult', status: 'active' });
  deletedMemberId = await insertMember({ family_id: familyF, user_id: deleted.id, role: 'adult', status: 'active' });
  childMemberId = await insertMember({
    family_id: familyF,
    user_id: null,
    role: 'child',
    display_name: `F-child-${TS}`,
    child_profile: { birth_year: 2018 },
    // #1173 (cross/14): アカウントの無い子供の行は生年月日が必須 (family_members_child_birth_date_required)
    birth_date: '2018-04-01',
    status: 'active',
  });
  promoChildOffId = await insertMember({
    family_id: familyF,
    user_id: null,
    role: 'child',
    display_name: `F-promo-off-${TS}`,
    child_profile: { birth_year: 1990 },
    // #1173 (cross/14): アカウントの無い子供の行は生年月日が必須 (family_members_child_birth_date_required)。
    // 昇格の it で本人のアカウントにつなぐので 18 歳以上にする (18 歳未満は保護者の同意が無いと request_child_promotion が
    // PARENTAL_CONSENT_REQUIRED で止める。他の昇格の結合テストと同じ成人の placeholder の値)
    birth_date: '1990-01-01',
    status: 'active',
  });
  promoChildOnId = await insertMember({
    family_id: familyF,
    user_id: null,
    role: 'child',
    display_name: `F-promo-on-${TS}`,
    child_profile: { birth_year: 1990 },
    // #1173 (cross/14): アカウントの無い子供の行は生年月日が必須 (family_members_child_birth_date_required)。
    // 昇格の it で本人のアカウントにつなぐので 18 歳以上にする (18 歳未満は保護者の同意が無いと request_child_promotion が
    // PARENTAL_CONSENT_REQUIRED で止める。他の昇格の結合テストと同じ成人の placeholder の値)
    birth_date: '1990-01-01',
    status: 'active',
  });
  removedMemberId = await insertMember({
    family_id: familyF,
    user_id: removed.id,
    role: 'adult',
    status: 'removed',
    removed_at: new Date().toISOString(),
  });
  otherRepMemberId = await insertMember({ family_id: familyG, user_id: otherRep.id, role: 'representative', status: 'active' });
  otherAdultMemberId = await insertMember({ family_id: familyG, user_id: otherAdult.id, role: 'adult', status: 'active' });
  // G の大人は、以前 F に居て退出した (F の行は left)
  leftMemberId = await insertMember({ family_id: familyF, user_id: otherAdult.id, role: 'adult', status: 'left' });

  await Promise.all([
    setProfileFamily(rep.id, familyF),
    setProfileFamily(adult.id, familyF),
    setProfileFamily(guest.id, familyF),
    setProfileFamily(deleted.id, familyF),
    setProfileFamily(removed.id, familyF),
    setProfileFamily(otherRep.id, familyG),
    setProfileFamily(otherAdult.id, familyG),
    setProfileFamily(intruder.id, familyG),
  ]);

  meal.rep = (await insertMeal(rep.id, DAY_ADULT, `F-rep-dinner-${TS}`)).mealId;
  meal.adult = (await insertMeal(adult.id, DAY_ADULT, `F-adult-dinner-${TS}`)).mealId;
  meal.adultSandbox = (await insertMeal(adult.id, DAY_SANDBOX, `F-adult-sandbox-${TS}`, { isSandbox: true })).mealId;
  meal.adultOutOfRange = (await insertMeal(adult.id, DAY_OUT_OF_RANGE, `F-adult-later-${TS}`)).mealId;
  meal.guest = (await insertMeal(guest.id, DAY_GUEST, `F-guest-dinner-${TS}`)).mealId;
  meal.deleted = (await insertMeal(deleted.id, DAY_DELETED, `F-deleted-dinner-${TS}`)).mealId;
  meal.removed = (await insertMeal(removed.id, DAY_ADULT, `F-removed-dinner-${TS}`)).mealId;
  meal.otherAdult = (await insertMeal(otherAdult.id, DAY_ADULT, `G-adult-dinner-${TS}`)).mealId;
  meal.otherRep = (await insertMeal(otherRep.id, DAY_ADULT, `G-rep-dinner-${TS}`)).mealId;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  for (const id of createdFamilyIds.filter(Boolean)) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    await srAdmin.from('family_groups').delete().eq('id', id); // family_members / 招待 / 昇格の依頼は CASCADE
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id); // 献立は CASCADE (退会の it で消した人は error になるが見ない)
  }
}, CLEANUP_TIMEOUT_MS);

describe('#1584 の 1 family_menu_visible_members / family_menu_planned_meals (実 DB)', () => {
  it('同じ家族で share_menu = TRUE の大人の献立だけが返る。自分の行は返らない', async () => {
    const visible = await visibleMembers(rep);
    expect(memberIdsOf(visible).sort()).toEqual([adultMemberId, guestMemberId, deletedMemberId].sort());
    expect(visible.find((r) => r.member_id === adultMemberId)?.user_id).toBe(adult.id);

    const ids = mealIdsOf(await plannedMeals(rep));
    expect(ids.sort()).toEqual([meal.adult, meal.guest, meal.deleted].sort());
    expect(ids).not.toContain(meal.rep);
    // adult から見ると代表者の献立が見え、自分の献立は返らない
    const fromAdult = mealIdsOf(await plannedMeals(adult));
    expect(fromAdult).toContain(meal.rep);
    expect(fromAdult).not.toContain(meal.adult);
  });

  it('share_menu = FALSE の大人は visible_members にも献立にも出ない。TRUE に戻すと出る', async () => {
    await setShareMenu(guestMemberId, false);
    try {
      expect(memberIdsOf(await visibleMembers(rep))).not.toContain(guestMemberId);
      expect(mealIdsOf(await plannedMeals(rep))).not.toContain(meal.guest);
    } finally {
      await setShareMenu(guestMemberId, true);
    }
    expect(memberIdsOf(await visibleMembers(rep))).toContain(guestMemberId);
    expect(mealIdsOf(await plannedMeals(rep))).toContain(meal.guest);
  });

  it('退出 (left)・除名 (removed) の行のメンバーは出ない', async () => {
    const visible = memberIdsOf(await visibleMembers(rep));
    expect(visible).not.toContain(removedMemberId);
    expect(visible).not.toContain(leftMemberId);
    const ids = mealIdsOf(await plannedMeals(rep));
    expect(ids).not.toContain(meal.removed);
    expect(ids).not.toContain(meal.otherAdult);
  });

  it('子供 (user_id NULL) は visible_members に出ない', async () => {
    const visible = memberIdsOf(await visibleMembers(rep));
    for (const id of [childMemberId, promoChildOffId, promoChildOnId]) expect(visible).not.toContain(id);
  });

  it('別の家族の人・家族に居ない人には 0 行。anon は 42501 (EXECUTE が無い)', async () => {
    // 家族 G の代表者には G の大人だけ (F の人は出ない)
    expect(memberIdsOf(await visibleMembers(otherRep))).toEqual([otherAdultMemberId]);
    expect(mealIdsOf(await plannedMeals(otherRep))).toEqual([meal.otherAdult]);
    // F のメンバーには G の人が出ない
    expect(memberIdsOf(await visibleMembers(rep))).not.toContain(otherAdultMemberId);
    expect(memberIdsOf(await visibleMembers(rep))).not.toContain(otherRepMemberId);
    expect(mealIdsOf(await plannedMeals(rep))).not.toContain(meal.otherRep);
    // 家族に居ない人 (昇格の前の promotedOn: 行も family_id も無い) は 0 行
    expect(await visibleMembers(promotedOn)).toEqual([]);
    expect(await plannedMeals(promotedOn)).toEqual([]);

    const visibleByAnon = await anon().rpc('family_menu_visible_members');
    expect(visibleByAnon.error?.code).toBe(PERMISSION_DENIED);
    const mealsByAnon = await anon().rpc('family_menu_planned_meals', { p_start_date: WEEK_START, p_end_date: WEEK_END });
    expect(mealsByAnon.error?.code).toBe(PERMISSION_DENIED);
  });

  it('家族が dissolved なら 0 行', async () => {
    const { error } = await srAdmin
      .from('family_groups')
      .update({ status: 'dissolved', dissolved_at: new Date().toISOString() })
      .eq('id', familyG);
    if (error) throw new Error(`dissolve G: ${error.message}`);
    try {
      expect(await visibleMembers(otherRep)).toEqual([]);
      expect(await plannedMeals(otherRep)).toEqual([]);
    } finally {
      await srAdmin.from('family_groups').update({ status: 'active', dissolved_at: null }).eq('id', familyG);
    }
    expect(memberIdsOf(await visibleMembers(otherRep))).toEqual([otherAdultMemberId]);
  });

  it('代表者でないメンバーのアカウントを消す (auth.admin.deleteUser) と、その人の family_members の行と献立が消え、visible_members にも献立にも出ない', async () => {
    expect(memberIdsOf(await visibleMembers(rep))).toContain(deletedMemberId);

    const { error } = await srAdmin.auth.admin.deleteUser(deleted.id);
    expect(error).toBeNull();

    const members = await srAdmin.from('family_members').select('id').eq('user_id', deleted.id);
    expect(members.error).toBeNull();
    expect(members.data).toEqual([]);
    const days = await srAdmin.from('user_daily_meals').select('id').eq('user_id', deleted.id);
    expect(days.error).toBeNull();
    expect(days.data).toEqual([]);

    expect(memberIdsOf(await visibleMembers(rep))).not.toContain(deletedMemberId);
    expect(mealIdsOf(await plannedMeals(rep))).not.toContain(meal.deleted);
    expect(mealIdsOf(await plannedMeals(adult))).not.toContain(meal.deleted);
  }, CASE_TIMEOUT_MS);

  it('砂場 (is_sandbox = TRUE) の日の献立は返らない', async () => {
    const ids = mealIdsOf(await plannedMeals(rep));
    expect(ids).toContain(meal.adult);
    expect(ids).not.toContain(meal.adultSandbox);
  });

  it('範囲の外の日は返らない。32 日の範囲と逆順は FAMILY_MENU_RANGE_INVALID', async () => {
    expect(mealIdsOf(await plannedMeals(rep))).not.toContain(meal.adultOutOfRange);
    expect(mealIdsOf(await plannedMeals(rep, DAY_OUT_OF_RANGE, DAY_OUT_OF_RANGE))).toEqual([meal.adultOutOfRange]);
    // 範囲の両端は含む
    expect(mealIdsOf(await plannedMeals(rep, DAY_ADULT, DAY_ADULT))).toEqual([meal.adult]);

    // 31 日はちょうど通り、32 日は通らない
    const allowed = await plannedMealsRaw(rep, '2026-10-01', '2026-10-31');
    expect(allowed.error).toBeNull();
    expect(FAMILY_MENU_RANGE_MAX_DAYS).toBe(31);
    for (const [start, end] of [
      ['2026-10-01', '2026-11-01'],
      [WEEK_END, WEEK_START],
    ]) {
      const { data, error } = await plannedMealsRaw(rep, start, end);
      expect(data).toBeNull();
      expect(error?.message, `${start}..${end}`).toContain('FAMILY_MENU_RANGE_INVALID');
    }
  });

  it('family_menu_planned_meals が返す jsonb の配列の各要素の鍵は 12 個だけ (memo / generation_metadata / mode / dishes / image_url が無い。足した行の memo・generation_metadata・image_url に値があっても)', async () => {
    const added = await insertKeyedMeals();
    try {
      const meals = await plannedMeals(rep, DAY_KEYS, DAY_KEYS);
      expect(mealIdsOf(meals).sort()).toEqual([...added.mealIds].sort());
      const expectedKeys = Object.keys(FamilyMenuRpcRowSchema.shape).sort();
      expect(expectedKeys).toHaveLength(RPC_ELEMENT_KEY_COUNT);
      for (const element of meals) {
        expect(Object.keys(element).sort()).toEqual(expectedKeys);
        for (const forbidden of ['memo', 'generation_metadata', 'mode', 'dishes', 'image_url']) {
          expect(element, forbidden).not.toHaveProperty(forbidden);
        }
      }
      const raw = JSON.stringify(meals);
      expect(raw).not.toContain(added.generatedImageUrl);
      expect(raw).not.toContain(EXTERNAL_IMAGE_URL);
      expect(raw).not.toContain(SECRET_MEMO);
      expect(raw).not.toContain(SECRET_PROMPT);
      expect(raw).not.toContain(SECRET_INGREDIENT);
    } finally {
      await deleteDays([added.dailyMealId]);
    }
  });

  it('1 つの範囲の献立が PostgREST の max_rows の既定 (1,000) を超えても、family_menu_planned_meals は全部を 1 つの jsonb の配列で返す (31 日 × 1 日 35 食 = 1,085 食)', async () => {
    const days: Array<{ id: string; day_date: string }> = [];
    for (let offset = 0; offset < FAMILY_MENU_RANGE_MAX_DAYS; offset += 1) {
      days.push({ id: '', day_date: addDays(BULK_START, offset) });
    }
    expect(days[days.length - 1].day_date).toBe(BULK_END);
    const { data: dayRows, error: dayError } = await srAdmin
      .from('user_daily_meals')
      .insert(days.map((d) => ({ user_id: adult.id, day_date: d.day_date, is_sandbox: false })))
      .select('id, day_date');
    if (dayError || !dayRows) throw new Error(`bulk user_daily_meals: ${dayError?.message}`);
    const dailyMealIds = dayRows.map((d) => d.id as string);
    try {
      const plannedRows = dayRows.flatMap((d) =>
        Array.from({ length: BULK_MEALS_PER_DAY }, (_, i) => ({
          daily_meal_id: d.id,
          meal_type: MEAL_ORDER[i % MEAL_ORDER.length],
          dish_name: `bulk-${d.day_date}-${i}`,
          display_order: i,
        })),
      );
      const insertedIds: string[] = [];
      for (let i = 0; i < plannedRows.length; i += INSERT_CHUNK_ROWS) {
        const { data, error } = await srAdmin.from('planned_meals').insert(plannedRows.slice(i, i + INSERT_CHUNK_ROWS)).select('id');
        if (error || !data) throw new Error(`bulk planned_meals: ${error?.message}`);
        insertedIds.push(...data.map((r) => r.id as string));
      }
      const expectedCount = FAMILY_MENU_RANGE_MAX_DAYS * BULK_MEALS_PER_DAY;
      expect(insertedIds).toHaveLength(expectedCount);

      const meals = await plannedMeals(rep, BULK_START, BULK_END);
      const adultMeals = meals.filter((m) => m.member_id === adultMemberId);
      expect(adultMeals).toHaveLength(expectedCount);
      expect(adultMeals.length).toBeGreaterThan(POSTGREST_DEFAULT_MAX_ROWS);
      const returned = mealIdsOf(adultMeals);
      expect(new Set(returned).size).toBe(returned.length);
      expect([...returned].sort()).toEqual([...insertedIds].sort());
    } finally {
      await deleteDays(dailyMealIds);
    }
  }, CASE_TIMEOUT_MS);

  it('dish_names は dishes の配列 (順を保つ) と、キーつきのオブジェクトの値から、文字列で空でない name だけを返す。name の無い要素・文字列でない name・空の name は捨て、dishes が NULL なら空の配列', async () => {
    const added = await insertKeyedMeals();
    try {
      const meals = await plannedMeals(rep, DAY_KEYS, DAY_KEYS);
      const byId = new Map(meals.map((m) => [String(m.id), m]));
      expect(byId.get(added.arrayMealId)?.dish_names).toEqual(['主菜の鮭', '副菜のおひたし']);
      expect(byId.get(added.objectMealId)?.dish_names).toEqual(['古い形の主菜', '古い形の汁']);
      expect(byId.get(added.nullMealId)?.dish_names).toEqual([]);
      // 料理ごとの栄養・材料・作り方・画像の URL は名前と一緒に返らない
      const raw = JSON.stringify(meals);
      for (const leaked of ['calories_kcal_per_dish', 'recipeSteps', 'ingredients', SECRET_INGREDIENT, added.generatedImageUrl]) {
        expect(raw, leaked).not.toContain(leaked);
      }
    } finally {
      await deleteDays([added.dailyMealId]);
    }
  });

  it('凍結 (user_profiles.frozen_at) された share_menu = TRUE の大人の献立も返る', async () => {
    const { error } = await srAdmin.from('user_profiles').update({ frozen_at: new Date().toISOString() }).eq('id', adult.id);
    if (error) throw new Error(`freeze adult: ${error.message}`);
    try {
      expect(memberIdsOf(await visibleMembers(rep))).toContain(adultMemberId);
      expect(mealIdsOf(await plannedMeals(rep))).toContain(meal.adult);
    } finally {
      await srAdmin.from('user_profiles').update({ frozen_at: null }).eq('id', adult.id);
    }
  });

  it('見る人が凍結中 (frozen_at) でも、2 つの関数は凍結していないときと同じ行を返す', async () => {
    const beforeVisible = await visibleMembers(adult);
    const beforeMeals = await plannedMeals(adult);
    expect(beforeVisible.length).toBeGreaterThan(0);
    const { error } = await srAdmin.from('user_profiles').update({ frozen_at: new Date().toISOString() }).eq('id', adult.id);
    if (error) throw new Error(`freeze adult: ${error.message}`);
    try {
      expect(await visibleMembers(adult)).toEqual(beforeVisible);
      expect(await plannedMeals(adult)).toEqual(beforeMeals);
    } finally {
      await srAdmin.from('user_profiles').update({ frozen_at: null }).eq('id', adult.id);
    }
  });

  it('除名済みで family_id が元の家族を指したままの人 (removed) と、行が無いのに family_id だけが家族を指す人 (intruder) が呼ぶと、2 つの関数とも 0 行', async () => {
    for (const viewer of [removed, intruder]) {
      expect(await visibleMembers(viewer), viewer.nickname).toEqual([]);
      expect(await plannedMeals(viewer), viewer.nickname).toEqual([]);
    }
  });

  it('子供の行を昇格の承諾 (accept_child_promotion) で本人のアカウントに付け替えると、p_share_menu = false の人は visible_members にも献立にも出ず、既定 (TRUE) の人は出る', async () => {
    const promote = async (memberId: string, target: TestUser, shareMenu: boolean | undefined) => {
      const request = await asUser(rep.jwt).rpc('request_child_promotion', { p_member_id: memberId, p_email: target.email });
      if (request.error || !request.data) throw new Error(`request_child_promotion: ${request.error?.message}`);
      const token = (request.data as { token: string }).token;
      const args = shareMenu === undefined ? { p_token: token } : { p_token: token, p_share_menu: shareMenu };
      const { error } = await asUser(target.jwt).rpc('accept_child_promotion', args);
      expect(error).toBeNull();
    };
    // 2 人の子供の行を 1 人ずつ昇格させる
    await promote(promoChildOffId, promotedOff, false);
    await promote(promoChildOnId, promotedOn, undefined);

    const offMeal = (await insertMeal(promotedOff.id, DAY_PROMOTED, `F-promoted-off-${TS}`)).mealId;
    const onMeal = (await insertMeal(promotedOn.id, DAY_PROMOTED, `F-promoted-on-${TS}`)).mealId;

    const visible = await visibleMembers(rep);
    expect(memberIdsOf(visible)).not.toContain(promoChildOffId);
    expect(memberIdsOf(visible)).toContain(promoChildOnId);
    expect(visible.find((r) => r.member_id === promoChildOnId)?.user_id).toBe(promotedOn.id);
    const ids = mealIdsOf(await plannedMeals(rep));
    expect(ids).not.toContain(offMeal);
    expect(ids).toContain(onMeal);
  }, CASE_TIMEOUT_MS);

  it('家族 H: 作った直後は 2 つの関数とも 0 行。招待の承諾で 2 人が加わると、p_share_menu = false の人は出ず、既定 (TRUE) の人は出る。承諾した人から見ると、承諾の前は 0 行で、承諾の直後から家族を作った人 (share_menu TRUE) が出る (自分の p_share_menu に関わらない)。代表者を既定の人へ譲渡 (propose → accept) しても、3 人それぞれから見た 2 つの関数の結果は変わらず、family_groups.representative_id は譲渡先になる', async () => {
    const [creator, joinOff, joinOn] = await Promise.all([
      createUser('h-creator', `H-creator-${TS}`),
      createUser('h-join-off', `H-join-off-${TS}`),
      createUser('h-join-on', `H-join-on-${TS}`),
    ]);

    // billing/03 §6.6: 家族グループは家族プランの契約者だけが作れる (招待の承諾も、代表者が家族プランのグループにだけ足せる)
    await grantFamilyPlan(srAdmin, creator.id);
    const created = await asUser(creator.jwt).rpc('create_family_group', { p_name: `rls-family-menu H ${TS}`, p_plan_key: 'free' });
    if (created.error || !created.data) throw new Error(`create_family_group: ${created.error?.message}`);
    const familyH = (created.data as { id: string }).id;
    createdFamilyIds.push(familyH);

    // 作った直後: 自分だけの家族なので 0 行
    expect(await visibleMembers(creator)).toEqual([]);
    expect(await plannedMeals(creator)).toEqual([]);

    const creatorMeal = (await insertMeal(creator.id, DAY_FAMILY_H, `H-creator-${TS}`)).mealId;
    const joinOffMeal = (await insertMeal(joinOff.id, DAY_FAMILY_H, `H-join-off-${TS}`)).mealId;
    const joinOnMeal = (await insertMeal(joinOn.id, DAY_FAMILY_H, `H-join-on-${TS}`)).mealId;

    // 承諾の前: 承諾する人から見て 0 行
    expect(await visibleMembers(joinOn)).toEqual([]);
    expect(await plannedMeals(joinOn)).toEqual([]);

    const invite = async (target: TestUser): Promise<string> => {
      const { data, error } = await asUser(creator.jwt).rpc('create_family_invite', { p_family_id: familyH, p_email: target.email });
      if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
      return (data as { token: string }).token;
    };
    const offToken = await invite(joinOff);
    const onToken = await invite(joinOn);
    const acceptedOff = await asUser(joinOff.jwt).rpc('accept_family_invite', { p_token: offToken, p_share_menu: false });
    expect(acceptedOff.error).toBeNull();
    const acceptedOn = await asUser(joinOn.jwt).rpc('accept_family_invite', { p_token: onToken });
    expect(acceptedOn.error).toBeNull();
    const joinOffMemberId = (acceptedOff.data as { id: string }).id;
    const joinOnMemberId = (acceptedOn.data as { id: string }).id;
    const creatorMember = await srAdmin
      .from('family_members')
      .select('id')
      .eq('family_id', familyH)
      .eq('user_id', creator.id)
      .single();
    if (creatorMember.error || !creatorMember.data) throw new Error(`creator member: ${creatorMember.error?.message}`);
    const creatorMemberId = creatorMember.data.id as string;

    // 家族を作った人から: 既定 (TRUE) の人だけ
    expect(memberIdsOf(await visibleMembers(creator))).toEqual([joinOnMemberId]);
    expect(mealIdsOf(await plannedMeals(creator))).toEqual([joinOnMeal]);
    // 承諾した人から: 家族を作った人が出る (自分の p_share_menu に関わらない)。share_menu = false の人は出ない
    expect(memberIdsOf(await visibleMembers(joinOn))).toEqual([creatorMemberId]);
    expect(mealIdsOf(await plannedMeals(joinOn))).toEqual([creatorMeal]);
    expect(memberIdsOf(await visibleMembers(joinOff)).sort()).toEqual([creatorMemberId, joinOnMemberId].sort());
    expect(mealIdsOf(await plannedMeals(joinOff)).sort()).toEqual([creatorMeal, joinOnMeal].sort());
    expect(mealIdsOf(await plannedMeals(creator))).not.toContain(joinOffMeal);

    const viewers = [creator, joinOff, joinOn];
    const snapshot = async () =>
      Promise.all(viewers.map(async (viewer) => ({ visible: await visibleMembers(viewer), meals: await plannedMeals(viewer) })));
    const beforeTransfer = await snapshot();

    const proposal = await asUser(creator.jwt).rpc('propose_family_representative_transfer', {
      p_family_id: familyH,
      p_to_user_id: joinOn.id,
    });
    if (proposal.error || !proposal.data) throw new Error(`propose_family_representative_transfer: ${proposal.error?.message}`);
    const accepted = await asUser(joinOn.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: proposal.data as string });
    expect(accepted.error).toBeNull();

    const group = await srAdmin.from('family_groups').select('representative_id').eq('id', familyH).single();
    expect(group.error).toBeNull();
    expect(group.data?.representative_id).toBe(joinOn.id);
    expect(await snapshot()).toEqual(beforeTransfer);
  }, CASE_TIMEOUT_MS);

  it('GET /api/family/menu (dev サーバー経由) が、自分の家族の見てよいメンバーの献立だけを返し、別の家族は返さない', async () => {
    const path = `${FAMILY_MENU_API_PATH}?startDate=${WEEK_START}&endDate=${WEEK_END}`;

    const fromRep = await apiCall<{ data: unknown }>('GET', path, rep.jwt);
    expect(fromRep.status).toBe(200);
    const repData = FamilyMenuDataSchema.parse(fromRep.body.data);
    expect(repData.family_id).toBe(familyF);
    expect(repData.members.map((m) => m.member_id)).toContain(adultMemberId);
    const repMealIds = repData.members.flatMap((m) => m.days.flatMap((d) => d.meals.map((x) => x.id)));
    expect(repMealIds).toContain(meal.adult);
    expect(repMealIds).not.toContain(meal.rep);
    expect(repMealIds).not.toContain(meal.otherAdult);
    expect(repMealIds).not.toContain(meal.otherRep);
    const repRaw = JSON.stringify(fromRep.body);
    expect(repRaw).not.toContain(otherAdultMemberId);
    expect(repRaw).not.toContain(otherRepMemberId);

    const fromOther = await apiCall<{ data: unknown }>('GET', path, otherRep.jwt);
    expect(fromOther.status).toBe(200);
    const otherData = FamilyMenuDataSchema.parse(fromOther.body.data);
    expect(otherData.family_id).toBe(familyG);
    expect(otherData.members.map((m) => m.member_id)).toEqual([otherAdultMemberId]);
    const otherRaw = JSON.stringify(fromOther.body);
    for (const id of [adultMemberId, guestMemberId, meal.adult, meal.guest]) expect(otherRaw).not.toContain(id);

    const unauthenticated = await apiCall('GET', path, null);
    expect(unauthenticated.status).toBe(401);
  });
});

// ---- 鍵と dish_names の 2 つの it が足す献立 ----

const EXTERNAL_IMAGE_URL = 'https://images.unsplash.com/photo-1';
const SECRET_MEMO = `夫のメモ (家族に見せない) ${TS}`;
const SECRET_PROMPT = `生成のプロンプト ${TS}`;
const SECRET_INGREDIENT = `秘密の材料 ${TS}`;

/**
 * adult の DAY_KEYS に、user_daily_meals (is_sandbox = FALSE) 1 行とその子の planned_meals 3 行を足す。
 * dishes は 料理ごとの中身を持つ配列 (name の無い要素・name が数・空の name を混ぜる) / キーつきのオブジェクト / NULL。
 * 3 行とも memo と generation_metadata に値を入れ、image_url は バケットの URL / バケットの外の URL / NULL
 */
async function insertKeyedMeals(): Promise<{
  dailyMealId: string;
  mealIds: string[];
  arrayMealId: string;
  objectMealId: string;
  nullMealId: string;
  generatedImageUrl: string;
}> {
  const dailyMealId = await insertDay(adult.id, DAY_KEYS);
  const generatedImageUrl = `${url}/storage/v1/object/public/fridge-images/generated/${dailyMealId}/a.png`;
  const common = { memo: SECRET_MEMO, generation_metadata: { prompt: SECRET_PROMPT } };
  const dishDetail = {
    calories_kcal_per_dish: 300,
    ingredients: [SECRET_INGREDIENT],
    recipeSteps: ['焼く'],
    image_url: generatedImageUrl,
    image_prompt: SECRET_PROMPT,
  };
  const rows = [
    {
      daily_meal_id: dailyMealId,
      meal_type: 'dinner',
      dish_name: '主菜の鮭',
      display_order: 0,
      is_simple: false,
      image_url: generatedImageUrl,
      dishes: [
        { name: '主菜の鮭', ...dishDetail },
        { ...dishDetail },
        { name: 5, ...dishDetail },
        { name: '', ...dishDetail },
        { name: '副菜のおひたし', ...dishDetail },
      ],
      ...common,
    },
    {
      daily_meal_id: dailyMealId,
      meal_type: 'lunch',
      dish_name: '古い形の主菜',
      display_order: 1,
      image_url: EXTERNAL_IMAGE_URL,
      dishes: { a: { name: '古い形の主菜', ...dishDetail }, b: { name: '古い形の汁', ...dishDetail } },
      ...common,
    },
    {
      daily_meal_id: dailyMealId,
      meal_type: 'breakfast',
      dish_name: 'トースト',
      display_order: 2,
      image_url: null,
      dishes: null,
      ...common,
    },
  ];
  const { data, error } = await srAdmin.from('planned_meals').insert(rows).select('id, dish_name');
  if (error || !data) throw new Error(`keyed planned_meals: ${error?.message}`);
  const idOf = (dishName: string): string => {
    const row = data.find((r) => r.dish_name === dishName);
    if (!row) throw new Error(`planned_meals ${dishName} が無い`);
    return row.id as string;
  };
  return {
    dailyMealId,
    mealIds: data.map((r) => r.id as string),
    arrayMealId: idOf('主菜の鮭'),
    objectMealId: idOf('古い形の主菜'),
    nullMealId: idOf('トースト'),
    generatedImageUrl,
  };
}

/**
 * 固定の暦日 'YYYY-MM-DD' に日数を足す (暦の足し算だけ。今日は使わず、実行環境のタイムゾーンに依らないよう UTC の部品で組み立てる)
 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
