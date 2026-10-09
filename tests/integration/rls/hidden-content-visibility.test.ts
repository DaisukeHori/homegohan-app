/**
 * #1101 運営が「隠した」食事 (meals) とレシピ (recipes) の見え方と、隠し状態の守り
 *
 * 背景: 違反コンテンツの「削除」を、行を消さずに hidden_at を入れて隠す方式にした
 * (migration 20261008200500_hide_moderated_content.sql)。隠した行は、本人以外 (他のユーザー・家族・未ログイン) には
 * 見えず、本人には見える。完全な削除は保管期間のあとに行う (その削除ジョブは別の作業)。
 *
 * 期待する挙動:
 *   - A (meals): 本人は隠された自分の食事を読める。食事を共有している家族のメンバー・家族の外の人・未ログイン (anon) は
 *        隠された食事を読めない (エラーにならず 0 行)。隠されていない食事は、これまでどおり家族のメンバーが読める
 *   - B (recipes): 本人は隠された自分のレシピを読める。ほかのログインユーザーと anon は、公開レシピでも隠されたものを読めない
 *        (GET /api/recipes と同じ条件の一覧にも出ない)。隠されていない公開レシピは、これまでどおり読める。
 *        user_id が NULL (システムのレシピ) でも、隠したものは誰にも見えない
 *   - C (守り): hidden_at / hidden_by / hidden_reason を、ログインユーザー (本人を含む) と anon は書き換えられない。
 *        本人が自分の行の hidden_at を NULL に戻せると、隠された違反コンテンツを自分で元に戻せてしまう。
 *        運営 (service_role) だけが隠す・戻すことができる。値を変えない更新 (行をまるごと送り直す) は止めない。
 *        運営ユーザーのアカウントを消すと hidden_by だけ NULL に戻り、隠した状態は残る (外部キー ON DELETE SET NULL)
 *   - D (定義): ポリシー・列・外部キー・索引・トリガー・関数の属性
 *   - E (運営 API が使う関数): hideModeratedContent を実 DB で。隠す・すでに隠れた行は上書きしない・行が無くても成功・本人の権限では隠せない
 *   - F (家族への貼り付け): 隠された食事は paste_meal_to_family の元にできない (MEAL_HIDDEN。写した行は隠れていないので、
 *        隠した内容を家族に見せ直せてしまう)。運営が隠すと、貼り付けで作られた複製 (同じ paste_group_id) のうち、
 *        中身 (写真とメモ) が通報された行と同じものもまとめて隠れる。中身を書き換えた行は隠れない (違反していない他人の行を隠さない)。
 *        本人は paste_group_id を書き換えられない (他人のまとまりに入る・まとまりから外れる・まとまりに入った行を作る は 42501)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/hidden-content-visibility.test.ts
 *
 * 修正前 (migration を流す前) は、hidden_at 列が無いため seed の「隠す」で失敗する。流したあとは全件成功する。
 * 作った行は afterAll で消す。本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { hideModeratedContent } from '@/lib/admin/moderation-backend';

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

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

// ---------------------------------------------------------------
// テストユーザー
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];

async function createUser(label: string, withSession: boolean): Promise<TestUser> {
  const email = `hidden-content-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `hidden-content-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!withSession) return { id: data.user.id, jwt: '' };
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let owner: TestUser; // 食事・レシピの持ち主 (家族の代表者)
let famMember: TestUser; // 同じ家族のメンバー。持ち主の食事を共有されている
let stranger: TestUser; // 家族の外のログインユーザー
let moderator: TestUser; // 隠した運営ユーザー (hidden_by の外部キーの相手。JWT は使わない)

let familyId = '';
const mealIds = { visible: '', hidden: '' };
const recipeIds = { publicVisible: '', publicHidden: '', privateHidden: '', systemVisible: '', systemHidden: '' };
const createdMealIds: string[] = [];
const createdRecipeIds: string[] = [];

const RECIPE_NAME = (key: string) => `#1101 hidden-content ${key} ${TS}`;

/** 運営 (service_role) が隠す。モデレーション API (hideModeratedContent) と同じ書き込み */
async function hideAsOperator(table: 'meals' | 'recipes', id: string, hiddenBy: string | null = moderator.id) {
  const { error } = await srAdmin
    .from(table)
    .update({ hidden_at: new Date().toISOString(), hidden_by: hiddenBy, hidden_reason: 'moderation:delete_only' })
    .eq('id', id);
  if (error) throw new Error(`hide ${table} ${id}: ${error.message}`);
}

async function insertMeal(userId: string, memo: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('meals')
    .insert({ user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'dinner', memo })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert meal: ${error?.message}`);
  createdMealIds.push(data.id as string);
  return data.id as string;
}

async function insertRecipe(userId: string | null, key: string, isPublic: boolean): Promise<string> {
  const { data, error } = await srAdmin
    .from('recipes')
    .insert({ user_id: userId, name: RECIPE_NAME(key), is_public: isPublic })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert recipe ${key}: ${error?.message}`);
  createdRecipeIds.push(data.id as string);
  return data.id as string;
}

const LONG = 120_000;

beforeAll(async () => {
  [owner, famMember, stranger, moderator] = await Promise.all([
    createUser('owner', true),
    createUser('fam-member', true),
    createUser('stranger', true),
    createUser('moderator', false),
  ]);

  // 家族: 持ち主が代表者、もう 1 人は大人。どちらも active で食事を共有する (招待の流れは別のテストが確かめる)
  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `#1101 hidden-content family ${TS}`, representative_id: owner.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  const { error: memberError } = await srAdmin.from('family_members').insert([
    { family_id: familyId, user_id: owner.id, role: 'representative', status: 'active', share_meals: true },
    { family_id: familyId, user_id: famMember.id, role: 'adult', status: 'active', share_meals: true },
  ]);
  if (memberError) throw new Error(`family_members: ${memberError.message}`);

  // 食事 2 件 (片方を隠す)
  mealIds.visible = await insertMeal(owner.id, `#1101 visible ${TS}`);
  mealIds.hidden = await insertMeal(owner.id, `#1101 hidden ${TS}`);
  await hideAsOperator('meals', mealIds.hidden);

  // レシピ: 本人の公開 (隠さない / 隠す)、本人の非公開 (隠す)、システム (user_id NULL。隠さない / 隠す)
  recipeIds.publicVisible = await insertRecipe(owner.id, 'public-visible', true);
  recipeIds.publicHidden = await insertRecipe(owner.id, 'public-hidden', true);
  recipeIds.privateHidden = await insertRecipe(owner.id, 'private-hidden', false);
  recipeIds.systemVisible = await insertRecipe(null, 'system-visible', true);
  recipeIds.systemHidden = await insertRecipe(null, 'system-hidden', true);
  await hideAsOperator('recipes', recipeIds.publicHidden);
  await hideAsOperator('recipes', recipeIds.privateHidden);
  await hideAsOperator('recipes', recipeIds.systemHidden);
}, LONG);

afterAll(async () => {
  // recipes.user_id は ON DELETE SET NULL なので、ユーザーより先に行を消す。
  // テストが途中で落ちて id を控えそこねた行 (C4 の INSERT など) も、名前と持ち主で拾って消す
  if (createdRecipeIds.length > 0) await srAdmin.from('recipes').delete().in('id', createdRecipeIds);
  await srAdmin.from('recipes').delete().like('name', `#1101 hidden-content % ${TS}`);
  if (createdMealIds.length > 0) await srAdmin.from('meals').delete().in('id', createdMealIds);
  if (createdUserIds.length > 0) await srAdmin.from('meals').delete().in('user_id', createdUserIds);
  if (familyId) {
    // family_members は CASCADE。family_groups.representative_id は ON DELETE RESTRICT なので家族を先に消す
    await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
    await srAdmin.from('family_groups').delete().eq('id', familyId);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, LONG);

/** 指定した行 ID のうち、そのクライアントから読めるもの */
async function readableIds(c: SupabaseClient, table: 'meals' | 'recipes', ids: string[]): Promise<string[]> {
  const { data, error } = await c.from(table).select('id').in('id', ids);
  expect(error, `${table} の読み取りがエラーになった`).toBeNull();
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

const sorted = (ids: string[]) => [...ids].sort();

// ================================================================
// A: meals
// ================================================================

describe('#1101 A: 隠された食事 (meals)', () => {
  const both = () => [mealIds.visible, mealIds.hidden];

  it('A1: 本人は、隠された自分の食事も読める (隠し状態の列も読める)', async () => {
    expect(await readableIds(asUser(owner.jwt), 'meals', both())).toEqual(sorted(both()));

    const { data, error } = await asUser(owner.jwt)
      .from('meals')
      .select('hidden_at, hidden_by, hidden_reason')
      .eq('id', mealIds.hidden)
      .single();
    expect(error).toBeNull();
    expect(data?.hidden_at).not.toBeNull();
    expect(data?.hidden_by).toBe(moderator.id);
    expect(data?.hidden_reason).toBe('moderation:delete_only');
  });

  it('A2: 食事を共有している家族のメンバーは、隠されていない食事は読めるが、隠された食事は読めない', async () => {
    expect(await readableIds(asUser(famMember.jwt), 'meals', both())).toEqual([mealIds.visible]);

    // 持ち主の食事を user_id で絞った一覧でも、隠された食事は出ない
    const { data, error } = await asUser(famMember.jwt).from('meals').select('id').eq('user_id', owner.id);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id as string)).toEqual([mealIds.visible]);
  });

  it('A3: 家族の外のログインユーザーは、どちらも読めない', async () => {
    expect(await readableIds(asUser(stranger.jwt), 'meals', both())).toEqual([]);
  });

  it('A4: 未ログイン (anon) は、どちらも読めない (エラーにならず 0 行)', async () => {
    expect(await readableIds(anon(), 'meals', both())).toEqual([]);
  });

  it('A5: 運営 (service_role) は、隠された食事も読める', async () => {
    expect(await readableIds(srAdmin, 'meals', both())).toEqual(sorted(both()));
  });

  it('A6: 食事を共有している家族でも、共有を切ると隠されていない食事も読めなくなる (これまでの挙動のまま)', async () => {
    const { error: unshareError } = await srAdmin
      .from('family_members')
      .update({ share_meals: false })
      .eq('family_id', familyId)
      .eq('user_id', owner.id);
    expect(unshareError).toBeNull();
    try {
      expect(await readableIds(asUser(famMember.jwt), 'meals', both())).toEqual([]);
    } finally {
      await srAdmin.from('family_members').update({ share_meals: true }).eq('family_id', familyId).eq('user_id', owner.id);
    }
    expect(await readableIds(asUser(famMember.jwt), 'meals', both())).toEqual([mealIds.visible]);
  });
});

// ================================================================
// B: recipes
// ================================================================

describe('#1101 B: 隠されたレシピ (recipes)', () => {
  const ownerRecipes = () => [recipeIds.publicVisible, recipeIds.publicHidden, recipeIds.privateHidden];
  const allRecipes = () => [...ownerRecipes(), recipeIds.systemVisible, recipeIds.systemHidden];

  it('B1: 本人は、隠された自分のレシピ (公開・非公開とも) も読める', async () => {
    expect(await readableIds(asUser(owner.jwt), 'recipes', ownerRecipes())).toEqual(sorted(ownerRecipes()));
  });

  it('B2: ほかのログインユーザーは、隠された公開レシピを読めない。隠されていない公開レシピは読める', async () => {
    const ids = await readableIds(asUser(stranger.jwt), 'recipes', allRecipes());
    expect(ids).toEqual(sorted([recipeIds.publicVisible, recipeIds.systemVisible]));
  });

  it('B3: 未ログイン (anon) も同じ。隠された公開レシピは読めず、隠されていない公開レシピは読める', async () => {
    const ids = await readableIds(anon(), 'recipes', allRecipes());
    expect(ids).toEqual(sorted([recipeIds.publicVisible, recipeIds.systemVisible]));
  });

  it('B4: GET /api/recipes と同じ条件の一覧 (公開、または自分のレシピ) に、隠されたものは本人以外に出ない', async () => {
    const names = [RECIPE_NAME('public-visible'), RECIPE_NAME('public-hidden'), RECIPE_NAME('private-hidden')];

    // ログイン済み: .or('is_public.eq.true,user_id.eq.<自分>')
    const strangerList = await asUser(stranger.jwt)
      .from('recipes')
      .select('name')
      .or(`is_public.eq.true,user_id.eq.${stranger.id}`)
      .in('name', names);
    expect(strangerList.error).toBeNull();
    expect((strangerList.data ?? []).map((r) => r.name)).toEqual([RECIPE_NAME('public-visible')]);

    // 未ログイン: .eq('is_public', true)
    const anonList = await anon().from('recipes').select('name').eq('is_public', true).in('name', names);
    expect(anonList.error).toBeNull();
    expect((anonList.data ?? []).map((r) => r.name)).toEqual([RECIPE_NAME('public-visible')]);

    // 本人: 自分のレシピは隠されたものも出る
    const ownerList = await asUser(owner.jwt)
      .from('recipes')
      .select('name')
      .or(`is_public.eq.true,user_id.eq.${owner.id}`)
      .in('name', names);
    expect(ownerList.error).toBeNull();
    expect((ownerList.data ?? []).map((r) => r.name).sort()).toEqual([...names].sort());
  });

  it('B5: user_id が NULL のシステムのレシピも、隠したものは誰にも見えない (本人がいないので運営だけ)', async () => {
    for (const c of [asUser(owner.jwt), asUser(stranger.jwt), anon()]) {
      expect(await readableIds(c, 'recipes', [recipeIds.systemHidden])).toEqual([]);
    }
    expect(await readableIds(srAdmin, 'recipes', [recipeIds.systemHidden])).toEqual([recipeIds.systemHidden]);
  });

  it('B6: 運営 (service_role) は、隠されたレシピも読める', async () => {
    expect(await readableIds(srAdmin, 'recipes', allRecipes())).toEqual(sorted(allRecipes()));
  });
});

// ================================================================
// C: 隠し状態の守り (hidden_at / hidden_by / hidden_reason)
// ================================================================

const TABLES = [
  { table: 'meals' as const, hiddenId: () => mealIds.hidden, visibleId: () => mealIds.visible },
  { table: 'recipes' as const, hiddenId: () => recipeIds.publicHidden, visibleId: () => recipeIds.publicVisible },
];

async function readHidden(table: 'meals' | 'recipes', id: string) {
  const { data, error } = await srAdmin.from(table).select('hidden_at, hidden_by, hidden_reason').eq('id', id).single();
  if (error || !data) throw new Error(`read ${table} ${id}: ${error?.message}`);
  return data as { hidden_at: string | null; hidden_by: string | null; hidden_reason: string | null };
}

describe.each(TABLES)('#1101 C: $table の隠し状態は本人でも書き換えられない', ({ table, hiddenId, visibleId }) => {
  it('C1: 本人は hidden_at を NULL に戻せない (42501。隠したまま)', async () => {
    const before = await readHidden(table, hiddenId());
    expect(before.hidden_at).not.toBeNull();

    const { error } = await asUser(owner.jwt).from(table).update({ hidden_at: null }).eq('id', hiddenId()).select('id');
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');

    expect(await readHidden(table, hiddenId())).toEqual(before);
  });

  it('C2: 本人は hidden_reason / hidden_by も書き換えられない (42501。値は変わらない)', async () => {
    const before = await readHidden(table, hiddenId());

    const reason = await asUser(owner.jwt).from(table).update({ hidden_reason: 'ok' }).eq('id', hiddenId()).select('id');
    expect(reason.error?.code).toBe('42501');

    const by = await asUser(owner.jwt).from(table).update({ hidden_by: owner.id }).eq('id', hiddenId()).select('id');
    expect(by.error?.code).toBe('42501');

    // 複数の列をまとめて送っても同じ
    const all = await asUser(owner.jwt)
      .from(table)
      .update({ hidden_at: null, hidden_by: null, hidden_reason: null })
      .eq('id', hiddenId())
      .select('id');
    expect(all.error?.code).toBe('42501');

    expect(await readHidden(table, hiddenId())).toEqual(before);
  });

  it('C3: 本人は、隠されていない自分の行を自分で隠すこともできない (隠すのは運営だけ)', async () => {
    const { error } = await asUser(owner.jwt)
      .from(table)
      .update({ hidden_at: new Date().toISOString() })
      .eq('id', visibleId())
      .select('id');
    expect(error?.code).toBe('42501');
    expect((await readHidden(table, visibleId())).hidden_at).toBeNull();
  });

  it('C4: 本人は、隠した状態の行を作れない (INSERT で hidden_* を入れると 42501)。普通の INSERT は通る', async () => {
    const base = table === 'meals'
      ? { user_id: owner.id, eaten_at: new Date().toISOString(), meal_type: 'lunch' }
      : { user_id: owner.id, name: RECIPE_NAME('insert-check') };

    for (const hidden of [
      { hidden_at: new Date().toISOString() },
      { hidden_by: moderator.id },
      { hidden_reason: 'moderation:delete_only' },
    ]) {
      const { error } = await asUser(owner.jwt).from(table).insert({ ...base, ...hidden });
      expect(error?.code, JSON.stringify(hidden)).toBe('42501');
    }

    // hidden_* を NULL で送るクライアント (行をまるごと送る書き方) は通る
    const { data, error } = await asUser(owner.jwt)
      .from(table)
      .insert({ ...base, hidden_at: null, hidden_by: null, hidden_reason: null })
      .select('id')
      .single();
    expect(error).toBeNull();
    (table === 'meals' ? createdMealIds : createdRecipeIds).push(data!.id as string);
    expect(await readHidden(table, data!.id as string)).toEqual({ hidden_at: null, hidden_by: null, hidden_reason: null });
  });

  it('C5: 本人は、隠された行のほかの列は今までどおり更新できる。隠し状態は変わらない', async () => {
    const before = await readHidden(table, hiddenId());
    const patch = table === 'meals' ? { memo: `#1101 edited ${TS}` } : { description: `#1101 edited ${TS}` };
    const { data, error } = await asUser(owner.jwt).from(table).update(patch).eq('id', hiddenId()).select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id as string)).toEqual([hiddenId()]);
    expect(await readHidden(table, hiddenId())).toEqual(before);
  });

  it('C6: 隠し状態の列を「今と同じ値」で送る更新は止めない (読んだ行をそのまま送り直すクライアントを壊さない)', async () => {
    const current = await asUser(owner.jwt)
      .from(table)
      .select('hidden_at, hidden_by, hidden_reason')
      .eq('id', hiddenId())
      .single();
    expect(current.error).toBeNull();

    const patch = table === 'meals' ? { memo: `#1101 resend ${TS}` } : { description: `#1101 resend ${TS}` };
    const { data, error } = await asUser(owner.jwt)
      .from(table)
      .update({ ...current.data, ...patch })
      .eq('id', hiddenId())
      .select('id');
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id as string)).toEqual([hiddenId()]);

    // 隠されていない行に NULL を送り直すのも同じ
    const visible = await asUser(owner.jwt)
      .from(table)
      .update({ hidden_at: null, hidden_by: null, hidden_reason: null, ...patch })
      .eq('id', visibleId())
      .select('id');
    expect(visible.error).toBeNull();
  });

  it('C7: 他人 (家族・ほかのログインユーザー) と anon は、行を更新できない (0 行。隠し状態も変わらない)', async () => {
    const before = await readHidden(table, hiddenId());
    for (const c of [asUser(famMember.jwt), asUser(stranger.jwt), anon()]) {
      const { data, error } = await c.from(table).update({ hidden_at: null }).eq('id', hiddenId()).select('id');
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    expect(await readHidden(table, hiddenId())).toEqual(before);
  });

  it('C8: 運営 (service_role) は、隠す・戻すことができる', async () => {
    const id = visibleId();
    // ほかのログインユーザーから見えるのは公開レシピだけ。食事は、家族でない人には隠す前から見えない
    const visibleToStranger = table === 'recipes' ? [id] : [];
    expect(await readableIds(asUser(stranger.jwt), table, [id])).toEqual(visibleToStranger);

    await hideAsOperator(table, id);
    expect((await readHidden(table, id)).hidden_at).not.toBeNull();
    expect(await readableIds(asUser(stranger.jwt), table, [id])).toEqual([]);

    const restore = await srAdmin
      .from(table)
      .update({ hidden_at: null, hidden_by: null, hidden_reason: null })
      .eq('id', id);
    expect(restore.error).toBeNull();
    expect(await readHidden(table, id)).toEqual({ hidden_at: null, hidden_by: null, hidden_reason: null });
    expect(await readableIds(asUser(stranger.jwt), table, [id])).toEqual(visibleToStranger);
  });
});

describe('#1101 C9: 運営ユーザーのアカウントを消したとき', () => {
  it('hidden_by だけ NULL に戻り (ON DELETE SET NULL)、隠した状態 (hidden_at) は残る。外部キーの動きがガードに止められない', async () => {
    const tempModerator = await createUser('temp-moderator', false);
    const mealId = await insertMeal(owner.id, `#1101 temp-moderator ${TS}`);
    const recipeId = await insertRecipe(owner.id, 'temp-moderator', true);
    await hideAsOperator('meals', mealId, tempModerator.id);
    await hideAsOperator('recipes', recipeId, tempModerator.id);
    expect((await readHidden('meals', mealId)).hidden_by).toBe(tempModerator.id);
    expect((await readHidden('recipes', recipeId)).hidden_by).toBe(tempModerator.id);

    const { error } = await srAdmin.auth.admin.deleteUser(tempModerator.id);
    expect(error).toBeNull();
    createdUserIds.splice(createdUserIds.indexOf(tempModerator.id), 1);

    for (const [table, id] of [['meals', mealId], ['recipes', recipeId]] as const) {
      const row = await readHidden(table, id);
      expect(row.hidden_by).toBeNull();
      expect(row.hidden_at).not.toBeNull();
      expect(row.hidden_reason).toBe('moderation:delete_only');
      expect(await readableIds(asUser(stranger.jwt), table, [id])).toEqual([]);
    }
  });
});

// ================================================================
// E: hideModeratedContent (運営のモデレーション API が使う関数) を実 DB で
// ================================================================

describe('#1101 E: hideModeratedContent を実 DB で', () => {
  const params = (hiddenBy: string) => ({ hiddenBy, reason: 'moderation:delete_only' });

  it('E1: 食事 (food) を隠す。hidden_* が入り、本人以外には見えなくなる。行は消えず、本人には見える', async () => {
    const mealId = await insertMeal(owner.id, `#1101 E1 ${TS}`);
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId])).toEqual([mealId]);

    // 戻り値は、この呼び出しで新しく隠した行の ID (監査ログの hidden_ids)
    expect(await hideModeratedContent(srAdmin, 'food', mealId, params(moderator.id))).toEqual([mealId]);

    const row = await readHidden('meals', mealId);
    expect(row.hidden_at).not.toBeNull();
    expect(Math.abs(Date.now() - Date.parse(row.hidden_at as string))).toBeLessThan(60_000);
    expect(row.hidden_by).toBe(moderator.id);
    expect(row.hidden_reason).toBe('moderation:delete_only');
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId])).toEqual([]);
    expect(await readableIds(anon(), 'meals', [mealId])).toEqual([]);
    expect(await readableIds(asUser(owner.jwt), 'meals', [mealId])).toEqual([mealId]);
    expect(await readableIds(srAdmin, 'meals', [mealId])).toEqual([mealId]);
  });

  it('E2: レシピ (recipe) も同じ。公開レシピが他のログインユーザーと anon に出なくなり、本人には残る', async () => {
    const recipeId = await insertRecipe(owner.id, 'E2', true);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([recipeId]);

    await hideModeratedContent(srAdmin, 'recipe', recipeId, params(moderator.id));

    expect((await readHidden('recipes', recipeId)).hidden_by).toBe(moderator.id);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([]);
    expect(await readableIds(anon(), 'recipes', [recipeId])).toEqual([]);
    expect(await readableIds(asUser(owner.jwt), 'recipes', [recipeId])).toEqual([recipeId]);
  });

  it('E3: すでに隠れている行は上書きしない (別の運営が別の理由でもう一度呼んでも、最初の hidden_at / hidden_by / hidden_reason のまま)', async () => {
    const secondModerator = await createUser('moderator-2', false);
    for (const [type, table, id] of [
      ['food', 'meals', await insertMeal(owner.id, `#1101 E3 ${TS}`)],
      ['recipe', 'recipes', await insertRecipe(owner.id, 'E3', true)],
    ] as const) {
      await hideModeratedContent(srAdmin, type, id, params(moderator.id));
      const first = await readHidden(table, id);

      await new Promise((resolve) => setTimeout(resolve, 20));
      // 2 回目は何も隠さない (戻り値は空)
      expect(
        await hideModeratedContent(srAdmin, type, id, { hiddenBy: secondModerator.id, reason: 'moderation:delete_and_warn' }),
      ).toEqual([]);

      expect(await readHidden(table, id), table).toEqual(first);
    }
  });

  it('E4: 行がもう無いとき (持ち主が先に消した等) は、何も更新せずに成功する', async () => {
    await expect(hideModeratedContent(srAdmin, 'food', randomUUID(), params(moderator.id))).resolves.toEqual([]);
    await expect(hideModeratedContent(srAdmin, 'recipe', randomUUID(), params(moderator.id))).resolves.toEqual([]);
  });

  it('E5: 運営の権限 (service_role) ではなく、本人のクライアントで呼ぶと隠せない (hidden_* の書き換えが 42501 で拒否され、例外になる)', async () => {
    const mealId = await insertMeal(owner.id, `#1101 E5 ${TS}`);

    await expect(hideModeratedContent(asUser(owner.jwt), 'food', mealId, params(owner.id))).rejects.toMatchObject({
      code: '42501',
    });
    expect((await readHidden('meals', mealId)).hidden_at).toBeNull();
  });
});

// ================================================================
// F: 家族への貼り付け (paste_meal_to_family) と隠した食事
// ================================================================

describe('#1101 F: 家族への貼り付け (paste_meal_to_family)', () => {
  // paste_meal_to_family は呼んだ人の user_profiles.family_id を見る。この describe の間だけ入れる
  beforeAll(async () => {
    const { error } = await srAdmin.from('user_profiles').update({ family_id: familyId }).in('id', [owner.id, famMember.id]);
    if (error) throw new Error(`user_profiles.family_id: ${error.message}`);
  }, LONG);
  afterAll(async () => {
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', [owner.id, famMember.id]);
  }, LONG);

  /** 本人の権限で貼り付ける (POST /api/meals/paste と同じ RPC) */
  async function pasteAs(user: TestUser, sourceMealId: string, targets: string[]) {
    return asUser(user.jwt).rpc('paste_meal_to_family', {
      p_source_meal_id: sourceMealId,
      p_target_user_ids: targets,
    });
  }

  /** 貼り付けで作られた複製 (同じ paste_group_id で、元の行ではないもの) */
  async function copiesOf(sourceMealId: string): Promise<Array<{ id: string; user_id: string }>> {
    const { data: source, error } = await srAdmin.from('meals').select('paste_group_id').eq('id', sourceMealId).single();
    if (error || !source?.paste_group_id) throw new Error(`paste_group_id: ${error?.message}`);
    const { data: rows, error: rowsError } = await srAdmin
      .from('meals')
      .select('id, user_id')
      .eq('paste_group_id', source.paste_group_id as string)
      .neq('id', sourceMealId);
    if (rowsError) throw new Error(`copies: ${rowsError.message}`);
    for (const row of rows ?? []) createdMealIds.push(row.id as string);
    return (rows ?? []) as Array<{ id: string; user_id: string }>;
  }

  it('F1: 持ち主は、隠された自分の食事を家族に貼り付けられない (MEAL_HIDDEN)。複製の行は作られない', async () => {
    const { error } = await pasteAs(owner, mealIds.hidden, [famMember.id]);

    expect(error?.message).toContain('MEAL_HIDDEN');
    const { data: rows } = await srAdmin.from('meals').select('id').eq('user_id', famMember.id).eq('memo', `#1101 hidden ${TS}`);
    expect(rows ?? []).toEqual([]);
  });

  it('F2: 持ち主でない人が隠された食事を指定しても NOT_MEAL_OWNER のまま (隠れているかどうかを教えない)', async () => {
    const { error } = await pasteAs(famMember, mealIds.hidden, [owner.id]);

    expect(error?.message).toContain('NOT_MEAL_OWNER');
    expect(error?.message).not.toContain('MEAL_HIDDEN');
  });

  it('F3: 隠されていない食事は、これまでどおり貼り付けられる', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F3 ${TS}`);

    const { data, error } = await pasteAs(owner, mealId, [famMember.id]);

    expect(error).toBeNull();
    expect(typeof data).toBe('string');
    const copies = await copiesOf(mealId);
    expect(copies.map((c) => c.user_id)).toEqual([famMember.id]);
  });

  it('F4: 運営が貼り付けた元の食事を隠すと、家族の持ち物になった複製もまとめて隠れる。複製の持ち主には自分の行として見え、ほかの人 (元の持ち主・家族の外・anon) には見えない', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F4 ${TS}`);
    const { error: pasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(pasteError).toBeNull();
    const [copy] = await copiesOf(mealId);
    expect(copy.user_id).toBe(famMember.id);
    // 隠す前: 元の持ち主は、家族の複製も読める
    expect(await readableIds(asUser(owner.jwt), 'meals', [copy.id])).toEqual([copy.id]);

    const hiddenIds = await hideModeratedContent(srAdmin, 'food', mealId, {
      hiddenBy: moderator.id,
      reason: 'moderation:delete_only',
    });

    expect(sorted(hiddenIds)).toEqual(sorted([mealId, copy.id]));
    expect((await readHidden('meals', copy.id)).hidden_reason).toBe('moderation:delete_only');
    // 複製の持ち主 (家族のメンバー) は、自分の行として読める。元の食事は読めない
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId, copy.id])).toEqual([copy.id]);
    // 元の持ち主は、自分の行は読めるが、家族の複製は読めない
    expect(await readableIds(asUser(owner.jwt), 'meals', [mealId, copy.id])).toEqual([mealId]);
    expect(await readableIds(asUser(stranger.jwt), 'meals', [mealId, copy.id])).toEqual([]);
    expect(await readableIds(anon(), 'meals', [mealId, copy.id])).toEqual([]);
  });

  it('F5: 通報されたのが複製の側でも、中身が同じなら、元の行を含む同じ paste_group_id の行がまとめて隠れる。隠れた複製は、貼り付けの元にもできない', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F5 ${TS}`);
    const { error: pasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(pasteError).toBeNull();
    const [copy] = await copiesOf(mealId);

    const hiddenIds = await hideModeratedContent(srAdmin, 'food', copy.id, {
      hiddenBy: moderator.id,
      reason: 'moderation:delete_only',
    });

    expect(sorted(hiddenIds)).toEqual(sorted([mealId, copy.id]));
    expect((await readHidden('meals', mealId)).hidden_at).not.toBeNull();
    // 複製の持ち主が、隠れた複製を貼り付け直して元の持ち主に見せることもできない
    const { error } = await pasteAs(famMember, copy.id, [owner.id]);
    expect(error?.message).toContain('MEAL_HIDDEN');
  });

  it('F6: 複製の持ち主が貼り付けのあとで中身 (メモ・写真) を書き換え、その複製が通報されたときは、複製だけが隠れる。元の持ち主の (違反していない) 元の行は隠れない', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F6 ${TS}`);
    const { error: pasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(pasteError).toBeNull();
    const [copy] = await copiesOf(mealId);
    // 複製の持ち主は、自分の行の中身を本人の権限 (meals_update_owner) で書き換えられる
    const { error: editError } = await asUser(famMember.jwt)
      .from('meals')
      .update({ memo: `#1101 F6 edited by copy owner ${TS}`, photo_url: 'https://example.com/f6-edited.jpg' })
      .eq('id', copy.id)
      .select('id');
    expect(editError).toBeNull();

    const hiddenIds = await hideModeratedContent(srAdmin, 'food', copy.id, {
      hiddenBy: moderator.id,
      reason: 'moderation:delete_only',
    });

    expect(hiddenIds).toEqual([copy.id]);
    expect((await readHidden('meals', mealId)).hidden_at).toBeNull();
    // 元の行は、家族のメンバー (複製を書き換えた人) からも、これまでどおり見える
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId, copy.id])).toEqual(sorted([mealId, copy.id]));
    expect(await readableIds(asUser(owner.jwt), 'meals', [mealId, copy.id])).toEqual([mealId]);
    // 元の行は、これまでどおり貼り付けの元にできる (MEAL_HIDDEN にならない)
    const { error: repasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(repasteError).toBeNull();
    await copiesOf(mealId); // 増えた複製を後片付けの対象に入れる
  });

  it('F7: 元の行が通報されたとき、メモだけを書き換えた複製は隠れない (中身が違う行は、まとまりが同じでも隠さない)。中身が同じ複製は隠れる', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F7 ${TS}`);
    const second = await createUser('f7-member', true);
    const { error: joinError } = await srAdmin
      .from('family_members')
      .insert({ family_id: familyId, user_id: second.id, role: 'adult', status: 'active', share_meals: true });
    expect(joinError).toBeNull();
    try {
      const { error: pasteError } = await pasteAs(owner, mealId, [famMember.id, second.id]);
      expect(pasteError).toBeNull();
      const copies = await copiesOf(mealId);
      const edited = copies.find((c) => c.user_id === famMember.id)!;
      const untouched = copies.find((c) => c.user_id === second.id)!;
      const { error: editError } = await asUser(famMember.jwt)
        .from('meals')
        .update({ memo: `#1101 F7 edited ${TS}` })
        .eq('id', edited.id)
        .select('id');
      expect(editError).toBeNull();

      const hiddenIds = await hideModeratedContent(srAdmin, 'food', mealId, {
        hiddenBy: moderator.id,
        reason: 'moderation:delete_only',
      });

      expect(sorted(hiddenIds)).toEqual(sorted([mealId, untouched.id]));
      expect((await readHidden('meals', edited.id)).hidden_at).toBeNull();
      expect(await readableIds(asUser(owner.jwt), 'meals', [edited.id, untouched.id])).toEqual([edited.id]);
    } finally {
      await srAdmin.from('meals').delete().eq('user_id', second.id);
      await srAdmin.from('family_members').delete().eq('family_id', familyId).eq('user_id', second.id);
    }
  });

  it('F8: 本人は paste_group_id を書き換えられない (他人のまとまりに自分の行を入れる・まとまりから外す・まとまりに入った行を作る は 42501)。同じ値を送り直すのは通る', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F8 ${TS}`);
    const { data: groupId, error: pasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(pasteError).toBeNull();
    const [copy] = await copiesOf(mealId);
    const ownMealId = await insertMeal(famMember.id, `#1101 F8 own ${TS}`);
    const readGroup = async (id: string) => {
      const { data, error } = await srAdmin.from('meals').select('paste_group_id').eq('id', id).single();
      if (error || !data) throw new Error(`read paste_group_id: ${error?.message}`);
      return data.paste_group_id as string | null;
    };

    // 自分の別の行を、他人のまとまりに入れる
    const join = await asUser(famMember.jwt).from('meals').update({ paste_group_id: groupId }).eq('id', ownMealId).select('id');
    expect(join.error?.code).toBe('42501');
    expect(await readGroup(ownMealId)).toBeNull();
    // まとまりに入った行を新しく作る
    const insert = await asUser(famMember.jwt)
      .from('meals')
      .insert({ user_id: famMember.id, eaten_at: new Date().toISOString(), meal_type: 'lunch', memo: `#1101 F8 insert ${TS}`, paste_group_id: groupId });
    expect(insert.error?.code).toBe('42501');
    // 自分の複製を、まとまりから外す・別のまとまりに付け替える
    for (const next of [null, randomUUID()]) {
      const leave = await asUser(famMember.jwt).from('meals').update({ paste_group_id: next }).eq('id', copy.id).select('id');
      expect(leave.error?.code, String(next)).toBe('42501');
    }
    expect(await readGroup(copy.id)).toBe(groupId);
    // 同じ値を送り直す (行をまるごと送り直すクライアント) のは止めない
    const resend = await asUser(famMember.jwt)
      .from('meals')
      .update({ paste_group_id: groupId, memo: `#1101 F8 resend ${TS}` })
      .eq('id', copy.id)
      .select('id');
    expect(resend.error).toBeNull();
    expect((resend.data ?? []).map((r) => r.id as string)).toEqual([copy.id]);
    // paste_group_id を NULL で送る INSERT (まとまりに入らない普通の行) も通る
    const plain = await asUser(famMember.jwt)
      .from('meals')
      .insert({ user_id: famMember.id, eaten_at: new Date().toISOString(), meal_type: 'lunch', memo: `#1101 F8 plain ${TS}`, paste_group_id: null })
      .select('id')
      .single();
    expect(plain.error).toBeNull();
    createdMealIds.push(plain.data!.id as string);
  });

  it('F9: 仮にまとまりに他人の行が入っていても (運営の権限で入れた場合)、中身が違えば、その行は隠れない', async () => {
    const mealId = await insertMeal(owner.id, `#1101 F9 ${TS}`);
    const { data: groupId, error: pasteError } = await pasteAs(owner, mealId, [famMember.id]);
    expect(pasteError).toBeNull();
    const copies = await copiesOf(mealId);
    // 家族のメンバーの、中身が違う行を、同じまとまりに入れる (本人の権限では F8 のとおり入れられないので、service_role で入れる)
    const { data: intruder, error: intruderError } = await srAdmin
      .from('meals')
      .insert({ user_id: famMember.id, eaten_at: new Date().toISOString(), meal_type: 'dinner', memo: `#1101 F9 violating ${TS}`, paste_group_id: groupId })
      .select('id')
      .single();
    expect(intruderError).toBeNull();
    createdMealIds.push(intruder!.id as string);

    const hiddenIds = await hideModeratedContent(srAdmin, 'food', intruder!.id as string, {
      hiddenBy: moderator.id,
      reason: 'moderation:delete_only',
    });

    expect(hiddenIds).toEqual([intruder!.id]);
    expect((await readHidden('meals', mealId)).hidden_at).toBeNull();
    for (const c of copies) expect((await readHidden('meals', c.id)).hidden_at, c.id).toBeNull();
  });
});

// ================================================================
// D: 定義 (カタログ)
// ================================================================

describe('#1101 D: 定義', () => {
  it('D1: meals の SELECT ポリシーは authenticated 限定のまま。隠し状態の条件と can_view_user_meals を両方持つ', async () => {
    const rows = await pgQuery<{ roles: string; cmd: string; qual: string }>(`
      SELECT array_to_string(roles, ',') AS roles, cmd, qual
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'meals' AND policyname = 'meals_select_owner_or_family'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].cmd).toBe('SELECT');
    expect(rows[0].roles).toBe('authenticated');
    expect(rows[0].qual).toContain('hidden_at IS NULL');
    expect(rows[0].qual).toContain('can_view_user_meals(user_id)');
  });

  it('D2: recipes の公開 SELECT ポリシーは TO public (anon を含む) のまま。隠し状態の条件を持ち、従来の条件も残っている', async () => {
    const rows = await pgQuery<{ roles: string; cmd: string; qual: string }>(`
      SELECT array_to_string(roles, ',') AS roles, cmd, qual
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'recipes' AND policyname = 'Users can view public recipes'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].cmd).toBe('SELECT');
    expect(rows[0].roles).toBe('public');
    expect(rows[0].qual).toContain('hidden_at IS NULL');
    expect(rows[0].qual).toContain('is_public = true');
    expect(rows[0].qual).toContain('user_id IS NULL');
  });

  it('D3: 3 つの列は meals / recipes とも、NULL を許し、既定値が無い (既存の行は隠れていない)', async () => {
    const rows = await pgQuery<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('meals', 'recipes')
        AND column_name IN ('hidden_at', 'hidden_by', 'hidden_reason')
      ORDER BY table_name, column_name
    `);
    expect(rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}:${r.is_nullable}:${r.column_default}`)).toEqual([
      'meals.hidden_at:timestamp with time zone:YES:null',
      'meals.hidden_by:uuid:YES:null',
      'meals.hidden_reason:text:YES:null',
      'recipes.hidden_at:timestamp with time zone:YES:null',
      'recipes.hidden_by:uuid:YES:null',
      'recipes.hidden_reason:text:YES:null',
    ]);
  });

  it('D4: hidden_by は auth.users への外部キーで、相手が消えたら NULL に戻す (ON DELETE SET NULL)', async () => {
    const rows = await pgQuery<{ rel: string; deltype: string; ref: string }>(`
      SELECT c.conrelid::regclass::text AS rel, c.confdeltype AS deltype, c.confrelid::regclass::text AS ref
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND a.attname = 'hidden_by' AND c.conrelid IN ('public.meals'::regclass, 'public.recipes'::regclass)
      ORDER BY 1
    `);
    expect(rows).toEqual([
      { rel: 'meals', deltype: 'n', ref: 'auth.users' },
      { rel: 'recipes', deltype: 'n', ref: 'auth.users' },
    ]);
  });

  it('D5: 完全削除のジョブと外部キーの確認のための、隠した行だけの小さい索引がある', async () => {
    const rows = await pgQuery<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('meals', 'recipes')
        AND indexname IN ('idx_meals_hidden_at', 'idx_meals_hidden_by', 'idx_recipes_hidden_at', 'idx_recipes_hidden_by')
      ORDER BY indexname
    `);
    expect(rows.map((r) => r.indexname)).toEqual([
      'idx_meals_hidden_at',
      'idx_meals_hidden_by',
      'idx_recipes_hidden_at',
      'idx_recipes_hidden_by',
    ]);
    for (const r of rows) expect(r.indexdef, r.indexname).toMatch(/WHERE \(hidden_(at|by) IS NOT NULL\)/);
  });

  it('D6: 守りのトリガーは meals / recipes の INSERT と hidden_* の UPDATE だけで動く。関数は SECURITY INVOKER で search_path が空', async () => {
    const triggers = await pgQuery<{ tgname: string; rel: string; def: string }>(`
      SELECT t.tgname, t.tgrelid::regclass::text AS rel, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname IN ('trg_meals_guard_hidden_columns', 'trg_recipes_guard_hidden_columns')
      ORDER BY 1
    `);
    expect(triggers.map((t) => `${t.tgname}@${t.rel}`)).toEqual([
      'trg_meals_guard_hidden_columns@meals',
      'trg_recipes_guard_hidden_columns@recipes',
    ]);
    for (const t of triggers) {
      expect(t.def).toContain('BEFORE INSERT OR UPDATE OF hidden_at, hidden_by, hidden_reason');
      expect(t.def).toContain('FOR EACH ROW');
    }

    const fn = await pgQuery<{ secdef: boolean; config: string[] | null }>(`
      SELECT p.prosecdef AS secdef, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'guard_hidden_content_columns'
    `);
    expect(fn).toHaveLength(1);
    expect(fn[0].secdef).toBe(false);
    expect(fn[0].config).toEqual(['search_path=""']);
  });

  it('D7: paste_group_id の守りのトリガーは meals の INSERT と paste_group_id の UPDATE だけで動く。関数は SECURITY INVOKER で search_path が空', async () => {
    const triggers = await pgQuery<{ rel: string; def: string }>(`
      SELECT t.tgrelid::regclass::text AS rel, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname = 'trg_meals_guard_paste_group_id'
    `);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].rel).toBe('meals');
    expect(triggers[0].def).toContain('BEFORE INSERT OR UPDATE OF paste_group_id');
    expect(triggers[0].def).toContain('FOR EACH ROW');
    expect(triggers[0].def).toContain('guard_meal_paste_group_id()');

    const fn = await pgQuery<{ secdef: boolean; config: string[] | null }>(`
      SELECT p.prosecdef AS secdef, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'guard_meal_paste_group_id'
    `);
    expect(fn).toHaveLength(1);
    expect(fn[0].secdef).toBe(false);
    expect(fn[0].config).toEqual(['search_path=""']);
  });
});
