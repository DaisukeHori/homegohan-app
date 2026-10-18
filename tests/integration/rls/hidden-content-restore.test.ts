/**
 * #1538 運営が隠したコンテンツを戻す (src/lib/admin/hidden-content-restore.ts) を実 DB で確かめる結合テスト (段 A)
 * 設計: docs/design/operator/13-hidden-content-restore.md §13.3 (I-1〜I-11)
 *
 * 本物のローカル Supabase (PostgREST・Storage) に対して、service_role の client で hideModeratedContent (隠す側) と
 * restoreModeratedContent ほか (戻す側) を直接呼ぶ。Next の開発サーバーは要らない。
 *   I-1  戻すと 3 列が NULL になり、家族のメンバーに再び見える
 *   I-2  同じ操作で隠した複製をまとめて戻す (PostgREST が返す hidden_at の文字列を eq に戻して同じ行に当たる)。別の時刻に隠した複製は残る
 *   I-10 元を隠したとき中身が違って隠れなかった複製を、書き戻したあと 2 件目の判定で別の時刻に隠す → 元から両方戻る (S-24)
 *   I-3  隠した公開レシピを戻すと、anon にもほかのログインユーザーにも再び見える
 *   I-4  本人の client では戻せない (ガードのトリガー 42501)
 *   I-5  戻した行は完全削除の対象にならず、画像も残る
 *   I-6  戻したあと paste_meal_to_family が通る
 *   I-7  hidden_at が 90 日前の行は戻らず、89 日前の行は戻る
 *   I-8  rejected の通報は approved に、pending はそのまま
 *   I-11 起点の食事が消えると通報は CASCADE で消え、同じ操作で隠した複製は隠れたまま残る (S-25 の前提の DB の事実)
 *   I-9  user_id が NULL の公開レシピ (退会で外れたもの: S-23) も戻る
 *
 * 前提: ローカル Supabase (bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local)。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/hidden-content-restore.test.ts
 * 作った行・ユーザー・ファイルは afterAll で消す。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { hideModeratedContent } from '@/lib/admin/moderation-backend';
import {
  HIDDEN_CONTENT_RESTORE_WINDOW_DAYS,
  restoreHiddenContentRows,
  restoreModeratedContent,
  type HiddenContentRestoreAdmin,
} from '@/lib/admin/hidden-content-restore';
import { purgeExpiredHiddenContent } from '../../../supabase/functions/_shared/hidden-content-purge';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LONG = 120_000;
/** 隠すときの時刻 (ミリ秒) を確実に分けるための待ち */
const DISTINCT_MS_WAIT = 15;
/** 完全削除の確認で、戻した行の hidden_at をこの日数前に置く (戻せる期間の中で、削除の期限 (90 日) に近い) */
const PURGE_CHECK_HIDDEN_DAYS_AGO = 80;
/** 完全削除の「今」を、隠した日時からこの日数あとに置く (保管期間 90 日を過ぎた時刻) */
const PURGE_CHECK_DAYS_AFTER_HIDDEN = 91;
const BUCKET = 'fridge-images';

const TS = Date.now();
const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdMealIds: string[] = [];
const createdRecipeIds: string[] = [];
const uploadedPaths: string[] = [];

interface TestUser {
  id: string;
  jwt: string;
}

async function createUser(label: string, withSession: boolean): Promise<TestUser> {
  const email = `hidden-restore-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `hidden-restore-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  if (!withSession) return { id: data.user.id, jwt: '' };
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let owner: TestUser; // 食事・レシピの持ち主 (家族の代表者)
let famMember: TestUser; // 同じ家族のメンバー (複製の持ち主)
let stranger: TestUser; // 家族の外のログインユーザー
let moderator: TestUser; // 隠した運営ユーザー (hidden_by と resolved_by の外部キーの相手。JWT は使わない)
let familyId = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sorted = (ids: string[]) => [...ids].sort();

interface MealSeed {
  userId: string;
  memo: string;
  photoUrl?: string | null;
  pasteGroupId?: string | null;
  hiddenAt?: string | null;
}

/** 食事を作る (service_role。hidden_* と paste_group_id は service_role だけが書ける) */
async function insertMeal(seed: MealSeed): Promise<string> {
  const { data, error } = await srAdmin
    .from('meals')
    .insert({
      user_id: seed.userId,
      eaten_at: new Date().toISOString(),
      meal_type: 'dinner',
      memo: seed.memo,
      photo_url: seed.photoUrl ?? null,
      paste_group_id: seed.pasteGroupId ?? null,
      hidden_at: seed.hiddenAt ?? null,
      hidden_by: seed.hiddenAt ? moderator.id : null,
      hidden_reason: seed.hiddenAt ? 'moderation:delete_only' : null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert meal: ${error?.message}`);
  createdMealIds.push(data.id as string);
  return data.id as string;
}

async function insertRecipe(userId: string | null, key: string, imageUrl: string | null = null): Promise<string> {
  const { data, error } = await srAdmin
    .from('recipes')
    .insert({ user_id: userId, name: `#1538 restore ${key} ${TS}`, is_public: true, image_url: imageUrl })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert recipe ${key}: ${error?.message}`);
  createdRecipeIds.push(data.id as string);
  return data.id as string;
}

interface HiddenColumns {
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
}

async function readHidden(table: 'meals' | 'recipes', id: string): Promise<HiddenColumns> {
  const { data, error } = await srAdmin.from(table).select('hidden_at, hidden_by, hidden_reason').eq('id', id).single();
  if (error || !data) throw new Error(`readHidden ${table} ${id}: ${error?.message}`);
  return data as HiddenColumns;
}

async function readableIds(c: SupabaseClient, table: 'meals' | 'recipes', ids: string[]): Promise<string[]> {
  const { data, error } = await c.from(table).select('id').in('id', ids);
  expect(error, `${table} の読み取りがエラーになった`).toBeNull();
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

const hideAsOperator = (type: 'food' | 'recipe', contentId: string) =>
  hideModeratedContent(srAdmin, type, contentId, { hiddenBy: moderator.id, reason: 'moderation:delete_only' });

const restoreAsOperator = (type: 'food' | 'recipe', contentId: string, now = new Date()) =>
  restoreModeratedContent(srAdmin, type, contentId, { restoredBy: moderator.id, restoreNote: '#1538 結合テストで戻す', now });

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function putObject(path: string): Promise<string> {
  const { error } = await srAdmin.storage.from(BUCKET).upload(path, tinyPng(), { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`upload ${path}: ${error.message}`);
  uploadedPaths.push(path);
  return srAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function objectExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const { data, error } = await srAdmin.storage.from(BUCKET).list(path.slice(0, slash), { limit: 1000, search: path.slice(slash + 1) });
  if (error) throw new Error(`exists ${path}: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === path.slice(slash + 1) && entry.id != null);
}

beforeAll(async () => {
  [owner, famMember, stranger, moderator] = await Promise.all([
    createUser('owner', true),
    createUser('fam-member', true),
    createUser('stranger', true),
    createUser('moderator', false),
  ]);

  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `#1538 restore family ${TS}`, representative_id: owner.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  const { error: memberError } = await srAdmin.from('family_members').insert([
    { family_id: familyId, user_id: owner.id, role: 'representative', status: 'active', share_meals: true },
    { family_id: familyId, user_id: famMember.id, role: 'adult', status: 'active', share_meals: true },
  ]);
  if (memberError) throw new Error(`family_members: ${memberError.message}`);
}, LONG);

afterAll(async () => {
  if (createdRecipeIds.length > 0) await srAdmin.from('recipes').delete().in('id', createdRecipeIds);
  await srAdmin.from('recipes').delete().like('name', `#1538 restore % ${TS}`);
  if (createdMealIds.length > 0) await srAdmin.from('meals').delete().in('id', createdMealIds);
  if (createdUserIds.length > 0) await srAdmin.from('meals').delete().in('user_id', createdUserIds);
  if (uploadedPaths.length > 0) await srAdmin.storage.from(BUCKET).remove(uploadedPaths);
  if (familyId) {
    await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
    await srAdmin.from('family_groups').delete().eq('id', familyId);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, LONG);

describe('#1538 戻す (部品を実 DB で)', () => {
  it('I-1: 隠した食事を戻すと、3 列が NULL になり、家族のメンバーに再び見える。本人には隠れている間もあとも見える', async () => {
    const mealId = await insertMeal({ userId: owner.id, memo: `#1538 I-1 ${TS}` });
    await hideAsOperator('food', mealId);
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId])).toEqual([]);
    expect(await readableIds(asUser(owner.jwt), 'meals', [mealId])).toEqual([mealId]);

    const outcome = await restoreAsOperator('food', mealId);

    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') {
      expect(outcome.restoredIds).toEqual([mealId]);
      expect(outcome.before.hidden_by).toBe(moderator.id);
      expect(outcome.before.hidden_reason).toBe('moderation:delete_only');
    }
    expect(await readHidden('meals', mealId)).toEqual({ hidden_at: null, hidden_by: null, hidden_reason: null });
    expect(await readableIds(asUser(famMember.jwt), 'meals', [mealId])).toEqual([mealId]);
    expect(await readableIds(asUser(owner.jwt), 'meals', [mealId])).toEqual([mealId]);
  });

  it('I-2: 貼り付けの元と複製 (同じ中身) をまとめて隠したあと戻すと、まとめて戻る (PostgREST が返す hidden_at の文字列を eq に戻して同じ行に当たる)。別の時刻に隠した複製 (中身を書き換えてから通報したもの) は残る', async () => {
    const groupId = crypto.randomUUID();
    const photo = 'https://example.com/i-2.jpg';
    const memo = `#1538 I-2 ${TS}`;
    const sourceId = await insertMeal({ userId: owner.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const copy1 = await insertMeal({ userId: famMember.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const copy2 = await insertMeal({ userId: stranger.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const edited = await insertMeal({ userId: famMember.id, memo: `${memo} 書き換え`, photoUrl: photo, pasteGroupId: groupId });

    const { hiddenIds } = await hideAsOperator('food', sourceId);
    expect(sorted(hiddenIds)).toEqual(sorted([sourceId, copy1, copy2]));
    await sleep(DISTINCT_MS_WAIT);
    // 書き換えた複製は、あとで別の通報の判定で隠れる (別の時刻・中身が元と違う)
    const later = await hideAsOperator('food', edited);
    expect(later.hiddenIds).toEqual([edited]);

    const outcome = await restoreAsOperator('food', sourceId);

    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') {
      expect(sorted(outcome.restoredIds)).toEqual(sorted([sourceId, copy1, copy2]));
      expect(sorted(outcome.targetIds)).toEqual(sorted([sourceId, copy1, copy2]));
    }
    for (const id of [sourceId, copy1, copy2]) {
      expect((await readHidden('meals', id)).hidden_at, id).toBeNull();
    }
    expect((await readHidden('meals', edited)).hidden_at).not.toBeNull();
  });

  it('I-10: 元を隠したとき中身が違って隠れなかった複製を、あとで中身を書き戻し、元への 2 件目の delete_only (hideModeratedContent) で別の時刻に隠す。元の通報から戻すと、元と、その複製の両方が戻る (S-24)', async () => {
    const groupId = crypto.randomUUID();
    const photo = 'https://example.com/i-10.jpg';
    const memo = `#1538 I-10 ${TS}`;
    const sourceId = await insertMeal({ userId: owner.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const copyId = await insertMeal({ userId: famMember.id, memo: `${memo} 書き換え`, photoUrl: photo, pasteGroupId: groupId });

    const first = await hideAsOperator('food', sourceId);
    expect(first.hiddenIds).toEqual([sourceId]);
    await sleep(DISTINCT_MS_WAIT);
    const { error: backError } = await srAdmin.from('meals').update({ memo }).eq('id', copyId);
    expect(backError).toBeNull();
    const second = await hideAsOperator('food', sourceId);
    expect(second.hiddenIds).toEqual([copyId]);
    const sourceHidden = await readHidden('meals', sourceId);
    const copyHidden = await readHidden('meals', copyId);
    expect(Date.parse(copyHidden.hidden_at!)).toBeGreaterThan(Date.parse(sourceHidden.hidden_at!));

    const outcome = await restoreAsOperator('food', sourceId);

    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') {
      expect(sorted(outcome.targetIds)).toEqual(sorted([sourceId, copyId]));
      // (b) の組 (あとの時刻) を先に、通報された行の組を最後に書く
      expect(outcome.restoredIds).toEqual([copyId, sourceId]);
    }
    expect((await readHidden('meals', sourceId)).hidden_at).toBeNull();
    expect((await readHidden('meals', copyId)).hidden_at).toBeNull();
  });

  it('I-3: 隠した公開レシピを戻すと、未ログイン (anon) とほかのログインユーザーに再び見える', async () => {
    const recipeId = await insertRecipe(owner.id, 'I-3');
    await hideAsOperator('recipe', recipeId);
    expect(await readableIds(anon(), 'recipes', [recipeId])).toEqual([]);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([]);

    const outcome = await restoreAsOperator('recipe', recipeId);

    expect(outcome.kind).toBe('restored');
    expect(await readHidden('recipes', recipeId)).toEqual({ hidden_at: null, hidden_by: null, hidden_reason: null });
    expect(await readableIds(anon(), 'recipes', [recipeId])).toEqual([recipeId]);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([recipeId]);
  });

  it('I-4: 本人の client で restoreHiddenContentRows を呼ぶと 42501 で例外になり、隠れたまま (ガードのトリガー)', async () => {
    const mealId = await insertMeal({ userId: owner.id, memo: `#1538 I-4 ${TS}` });
    await hideAsOperator('food', mealId);
    const hiddenAt = (await readHidden('meals', mealId)).hidden_at!;

    const asOwner = asUser(owner.jwt) as unknown as HiddenContentRestoreAdmin;
    await expect(restoreHiddenContentRows(asOwner, 'food', [mealId], hiddenAt, new Date())).rejects.toMatchObject({ code: '42501' });

    expect((await readHidden('meals', mealId)).hidden_at).not.toBeNull();
  });

  it('I-5: 戻した行は purgeExpiredHiddenContent (now = 隠した日時 + 91 日) の対象にならず、画像も hidden_content_purge_referenced_needles が「使っている」と答えて残る', async () => {
    const photoPath = `${owner.id}/i1538-restore-${RUN}.png`;
    const photoUrl = await putObject(photoPath);
    const hiddenAt = new Date(Date.now() - PURGE_CHECK_HIDDEN_DAYS_AGO * MS_PER_DAY).toISOString();
    const restoredId = await insertMeal({ userId: owner.id, memo: `#1538 I-5 restored ${TS}`, photoUrl, hiddenAt });
    // 同じ画像を指す、戻さない隠した行 (完全削除の対象になる)
    const expiredId = await insertMeal({ userId: owner.id, memo: `#1538 I-5 expired ${TS}`, photoUrl, hiddenAt });
    expect((await restoreAsOperator('food', restoredId)).kind).toBe('restored');
    // 戻していない行 expiredId だけが残る状態では、画像はジョブが消す対象 (対照)
    const purgeNow = new Date(Date.parse(hiddenAt) + PURGE_CHECK_DAYS_AFTER_HIDDEN * MS_PER_DAY);

    const result = await purgeExpiredHiddenContent(srAdmin, { now: purgeNow });

    expect(result.completed).toBe(true);
    const { data: restoredRow } = await srAdmin.from('meals').select('id').eq('id', restoredId).maybeSingle();
    expect(restoredRow?.id).toBe(restoredId);
    const { data: expiredRow } = await srAdmin.from('meals').select('id').eq('id', expiredId).maybeSingle();
    expect(expiredRow).toBeNull();
    // 画像は、戻した行 (hidden_at NULL) が使っているので残る
    expect(await objectExists(photoPath)).toBe(true);
    const { data: referenced, error } = await srAdmin.rpc('hidden_content_purge_referenced_needles', {
      p_needles: [`/${BUCKET}/${photoPath}`],
      p_cutoff: new Date(purgeNow.getTime() - 90 * MS_PER_DAY).toISOString(),
    });
    expect(error).toBeNull();
    expect(referenced).toEqual([`/${BUCKET}/${photoPath}`]);
  });

  it('I-6: 戻したあと paste_meal_to_family が通る (MEAL_HIDDEN にならない)', async () => {
    const { error: familyError } = await srAdmin.from('user_profiles').update({ family_id: familyId }).in('id', [owner.id, famMember.id]);
    if (familyError) throw new Error(`user_profiles.family_id: ${familyError.message}`);
    try {
      const mealId = await insertMeal({ userId: owner.id, memo: `#1538 I-6 ${TS}` });
      await hideAsOperator('food', mealId);
      const hiddenPaste = await asUser(owner.jwt).rpc('paste_meal_to_family', { p_source_meal_id: mealId, p_target_user_ids: [famMember.id] });
      expect(hiddenPaste.error?.message).toContain('MEAL_HIDDEN');

      expect((await restoreAsOperator('food', mealId)).kind).toBe('restored');

      const pasted = await asUser(owner.jwt).rpc('paste_meal_to_family', { p_source_meal_id: mealId, p_target_user_ids: [famMember.id] });
      expect(pasted.error).toBeNull();
    } finally {
      await srAdmin.from('user_profiles').update({ family_id: null }).in('id', [owner.id, famMember.id]);
    }
  });

  it('I-7: hidden_at を 90 日前にした行は restoreHiddenContentRows で 0 行 (期限の gte が効く)。89 日前の行は戻る', async () => {
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * MS_PER_DAY).toISOString();
    const withinWindow = new Date(now.getTime() - HIDDEN_CONTENT_RESTORE_WINDOW_DAYS * MS_PER_DAY).toISOString();
    const oldId = await insertMeal({ userId: owner.id, memo: `#1538 I-7 old ${TS}`, hiddenAt: ninetyDaysAgo });
    const edgeId = await insertMeal({ userId: owner.id, memo: `#1538 I-7 edge ${TS}`, hiddenAt: withinWindow });

    expect(await restoreHiddenContentRows(srAdmin, 'food', [oldId], ninetyDaysAgo, now)).toEqual([]);
    expect((await readHidden('meals', oldId)).hidden_at).not.toBeNull();

    expect(await restoreHiddenContentRows(srAdmin, 'food', [edgeId], withinWindow, now)).toEqual([edgeId]);
    expect((await readHidden('meals', edgeId)).hidden_at).toBeNull();

    // 判定の関数でも、90 日前は window_expired・書き込みは 0 行
    const expired = await restoreAsOperator('food', oldId, now);
    expect(expired.kind).toBe('window_expired');
  });

  it('I-8: 戻すと、その行を指す rejected の通報は approved に、pending の通報はそのまま', async () => {
    const mealId = await insertMeal({ userId: owner.id, memo: `#1538 I-8 ${TS}` });
    await hideAsOperator('food', mealId);
    const { data: flags, error: flagError } = await srAdmin
      .from('moderation_flags')
      .insert([
        { meal_id: mealId, user_id: stranger.id, reason: `#1538 I-8 rejected ${RUN}`, status: 'rejected' },
        { meal_id: mealId, user_id: famMember.id, reason: `#1538 I-8 pending ${RUN}`, status: 'pending' },
      ])
      .select('id, status');
    if (flagError || !flags) throw new Error(`insert flags: ${flagError?.message}`);
    const rejectedId = flags.find((f) => f.status === 'rejected')!.id as string;
    const pendingId = flags.find((f) => f.status === 'pending')!.id as string;

    const outcome = await restoreAsOperator('food', mealId);

    expect(outcome.kind).toBe('restored');
    if (outcome.kind === 'restored') expect(outcome.approvedFlagIds).toEqual([rejectedId]);
    const { data: after, error } = await srAdmin
      .from('moderation_flags')
      .select('id, status, resolved_by, resolution_note')
      .in('id', [rejectedId, pendingId]);
    expect(error).toBeNull();
    const byId = new Map((after ?? []).map((row) => [row.id as string, row]));
    expect(byId.get(rejectedId)).toMatchObject({ status: 'approved', resolved_by: moderator.id, resolution_note: '#1538 結合テストで戻す' });
    expect(byId.get(pendingId)).toMatchObject({ status: 'pending', resolved_by: null });
  });

  it('I-11: 貼り付けの元と複製を同じ操作で隠し (同じ hidden_at)、元を持ち主の client で消すと、元を指す通報は CASCADE で消え、複製は hidden_at がそのまま (隠れたまま) 残り、複製を meal_id に持つ通報は無い (§19 の「起点を失った複製」の前提の DB の事実: S-25)', async () => {
    const groupId = crypto.randomUUID();
    const photo = 'https://example.com/i-11.jpg';
    const memo = `#1538 I-11 ${TS}`;
    const sourceId = await insertMeal({ userId: owner.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const copyId = await insertMeal({ userId: famMember.id, memo, photoUrl: photo, pasteGroupId: groupId });
    const { hiddenIds } = await hideAsOperator('food', sourceId);
    expect(sorted(hiddenIds)).toEqual(sorted([sourceId, copyId]));
    const { error: flagError } = await srAdmin
      .from('moderation_flags')
      .insert({ meal_id: sourceId, user_id: stranger.id, reason: `#1538 I-11 ${RUN}`, status: 'rejected' });
    expect(flagError).toBeNull();

    const { error: deleteError } = await asUser(owner.jwt).from('meals').delete().eq('id', sourceId);
    expect(deleteError).toBeNull();

    const { data: sourceFlags } = await srAdmin.from('moderation_flags').select('id').eq('meal_id', sourceId);
    expect(sourceFlags ?? []).toEqual([]);
    const { data: copyFlags } = await srAdmin.from('moderation_flags').select('id').eq('meal_id', copyId);
    expect(copyFlags ?? []).toEqual([]);
    expect((await readHidden('meals', copyId)).hidden_at).not.toBeNull();
  });

  it('I-9: user_id が NULL の公開レシピ (退会で外れたもの: S-23) を service_role で隠すと、未ログイン (anon) にもほかのログインユーザーにも見えない。restoreModeratedContent で戻すと、両方に再び見える', async () => {
    const recipeId = await insertRecipe(null, 'I-9');
    const hideResult = await hideAsOperator('recipe', recipeId);
    expect(hideResult.hiddenIds).toEqual([recipeId]);
    expect(await readableIds(anon(), 'recipes', [recipeId])).toEqual([]);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([]);

    const outcome = await restoreAsOperator('recipe', recipeId);

    expect(outcome.kind).toBe('restored');
    expect(await readableIds(anon(), 'recipes', [recipeId])).toEqual([recipeId]);
    expect(await readableIds(asUser(stranger.jwt), 'recipes', [recipeId])).toEqual([recipeId]);
  });
});
