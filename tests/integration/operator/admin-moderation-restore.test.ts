/**
 * Integration tests: 運営が隠したコンテンツを戻す API (#1538 段 A)
 *   POST /api/admin/moderation/[type]/[id]/restore
 *   GET  /api/admin/moderation/queue・GET /api/admin/moderation/[type]/[id] の hidden_at
 * 設計: docs/design/operator/13-hidden-content-restore.md §8・§13.3 (A-1〜A-9)
 *
 * 権限は隠す操作 (POST /api/admin/moderation/[type]/[id]) と同じ admin / super_admin / content_moderator。support と一般ユーザーは 403、未認証は 401。
 * 隠すのは本物の API (delete_only) で行い、戻すのも本物の API で行う。通報・コンテンツ・監査ログは service_role で読む。
 * 期限切れの行 (A-4) と、コンテンツが紐づかない通報 (A-5) だけは、前提を service_role で作る。
 *
 * 実行: CONTRIBUTING.md の「インテグレーションテスト」(ローカル Supabase + Next dev サーバ) を参照。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { TestUserPool, dataOf, expectError, latestAuditLog } from '../helpers/admin-test-utils';

const TS = Date.now();
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 隠してからこの日数たった行は戻せない (保管期間 90 日。戻せる期間は 89 日) */
const EXPIRED_AFTER_DAYS = 90;
/** 同時に戻す 2 人のうち、1 人が 200・もう 1 人が 409 になる */
const RESTORE_ACTION = 'admin.moderation.restore';
/** next dev は route を最初のリクエストでコンパイルする。初回でも収まるよう余裕を持たせる */
const FIRST_COMPILE_TIMEOUT_MS = 90_000;
const NOTE = '#1538 結合テスト: 申し立てを確認した';
const pool = new TestUserPool(TS, 'mrest');

let adminUser: TestUser;
let moderatorUser: TestUser; // content_moderator
let supportUser: TestUser; // 運営だが moderation の権限は無い
let generalUser: TestUser; // 権限なし (role=user)
let reporterUser: TestUser; // 通報者
let ownerUser: TestUser; // 通報されたコンテンツの所有者

const createdMealIds: string[] = [];
const createdRecipeIds: string[] = [];
const createdFlagIds: string[] = [];
let seq = 0;

interface RestoreData {
  success: boolean;
  content_hidden: boolean;
  restored_ids: string[];
  approved_flag_ids: string[];
}

interface HiddenColumns {
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
}

const NOT_HIDDEN: HiddenColumns = { hidden_at: null, hidden_by: null, hidden_reason: null };

async function seedFoodFlag(options: { reporterId?: string; mealId?: string } = {}) {
  seq += 1;
  let mealId = options.mealId;
  if (!mealId) {
    const { data: meal, error: mealError } = await supabaseAdmin
      .from('meals')
      .insert({
        user_id: ownerUser.userId,
        eaten_at: new Date().toISOString(),
        meal_type: 'dinner',
        photo_url: `https://test.example.com/t1538/meal-${TS}-${seq}.jpg`,
        memo: 'T1538 restore seed',
      })
      .select('id')
      .single();
    if (mealError || !meal) throw new Error(`seed meal failed: ${mealError?.message}`);
    mealId = meal.id as string;
    createdMealIds.push(mealId);
  }
  const { data: flag, error: flagError } = await supabaseAdmin
    .from('moderation_flags')
    .insert({
      meal_id: mealId,
      user_id: options.reporterId ?? reporterUser.userId,
      reason: `T1538 food flag ${TS}-${seq}`,
      status: 'pending',
      flag_type: 'inappropriate',
    })
    .select('id')
    .single();
  if (flagError || !flag) throw new Error(`seed moderation_flags failed: ${flagError?.message}`);
  return { flagId: flag.id as string, mealId };
}

async function seedRecipeFlag(name: string) {
  seq += 1;
  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .insert({ user_id: ownerUser.userId, name, is_public: true })
    .select('id')
    .single();
  if (recipeError || !recipe) throw new Error(`seed recipe failed: ${recipeError?.message}`);
  createdRecipeIds.push(recipe.id as string);
  const { data: flag, error: flagError } = await supabaseAdmin
    .from('recipe_flags')
    .insert({
      recipe_id: recipe.id,
      reporter_id: reporterUser.userId,
      flag_type: 'other',
      reason: `T1538 recipe flag ${TS}-${seq}`,
      status: 'pending',
    })
    .select('id')
    .single();
  if (flagError || !flag) throw new Error(`seed recipe_flags failed: ${flagError?.message}`);
  return { flagId: flag.id as string, recipeId: recipe.id as string };
}

async function readHidden(table: 'meals' | 'recipes', id: string): Promise<HiddenColumns> {
  const { data, error } = await supabaseAdmin.from(table).select('hidden_at, hidden_by, hidden_reason').eq('id', id).single();
  if (error || !data) throw new Error(`readHidden ${table} failed: ${error?.message}`);
  return data as HiddenColumns;
}

async function readFoodFlag(flagId: string) {
  const { data, error } = await supabaseAdmin
    .from('moderation_flags')
    .select('status, resolved_by, resolved_at, resolution_note')
    .eq('id', flagId)
    .single();
  if (error || !data) throw new Error(`readFoodFlag failed: ${error?.message}`);
  return data as { status: string; resolved_by: string | null; resolved_at: string | null; resolution_note: string | null };
}

/** 運営の API で隠す (delete_only)。通報は rejected になり、コンテンツが隠れる */
async function hideViaApi(type: 'food' | 'recipe', flagId: string) {
  const res = await apiCall('POST', `/api/admin/moderation/${type}/${flagId}`, adminUser.jwt, {
    action: 'delete_only',
    resolution_note: 'T1538 hide before restore',
  });
  expect(dataOf<{ status: string }>(res).status).toBe('rejected');
}

const restoreVia = (jwt: string | null, type: string, flagId: string, body: unknown = { restore_note: NOTE }) =>
  apiCall('POST', `/api/admin/moderation/${type}/${flagId}/restore`, jwt, body);

/** この通報を target_id にする戻す操作の監査ログ (古い順) */
async function restoreAuditLogs(flagId: string) {
  const { data, error } = await supabaseAdmin
    .from('admin_audit_logs')
    .select('actor_id, severity, details')
    .eq('action_type', RESTORE_ACTION)
    .eq('target_id', flagId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`restoreAuditLogs failed: ${error.message}`);
  return (data ?? []) as Array<{ actor_id: string; severity: string; details: Record<string, unknown> }>;
}

beforeAll(async () => {
  ({ adminUser, moderatorUser, supportUser, generalUser, reporterUser, ownerUser } = await pool.createMany({
    adminUser: ['admin'],
    moderatorUser: ['content_moderator'],
    supportUser: ['support'],
    generalUser: ['user'],
    reporterUser: ['user'],
    ownerUser: ['user'],
  }));
}, 60_000);

afterAll(async () => {
  // moderation_flags.resolved_by / recipe_flags.reviewed_by は auth.users への外部キー (NO ACTION)。ユーザーより先に通報を消す
  if (createdFlagIds.length > 0) await supabaseAdmin.from('moderation_flags').delete().in('id', createdFlagIds);
  if (createdMealIds.length > 0) await supabaseAdmin.from('meals').delete().in('id', createdMealIds);
  if (createdRecipeIds.length > 0) await supabaseAdmin.from('recipes').delete().in('id', createdRecipeIds);
  await pool.cleanup();
}, 60_000);

describe('POST /api/admin/moderation/[type]/[id]/restore', () => {
  it('A-1: admin: delete_only で隠した公開レシピを restore で戻すと 200。未ログインの GET /api/recipes に再び出る。recipe_flags は approved (reviewed_by = admin)。監査ログ admin.moderation.restore (info) に restore_note と restored_ids', async () => {
    const name = `t1538restore${TS}x${seq + 1}`;
    const { flagId, recipeId } = await seedRecipeFlag(name);
    const listNames = async () => {
      const res = await apiCallNoAuth<{ recipes: Array<{ name: string }> }>('GET', `/api/recipes?q=${encodeURIComponent(name)}&limit=100`);
      expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body.recipes.map((r) => r.name);
    };
    expect(await listNames()).toEqual([name]);
    await hideViaApi('recipe', flagId);
    expect(await listNames()).toEqual([]);

    const res = await restoreVia(adminUser.jwt, 'recipe', flagId);

    expect(dataOf<RestoreData>(res)).toEqual({ success: true, content_hidden: false, restored_ids: [recipeId], approved_flag_ids: [flagId] });
    expect(await readHidden('recipes', recipeId)).toEqual(NOT_HIDDEN);
    expect(await listNames()).toEqual([name]);
    const { data: flag } = await supabaseAdmin.from('recipe_flags').select('status, reviewed_by').eq('id', flagId).single();
    expect(flag).toMatchObject({ status: 'approved', reviewed_by: adminUser.userId });
    const log = await latestAuditLog({ actorId: adminUser.userId, actionType: RESTORE_ACTION, targetId: flagId });
    expect(log).not.toBeNull();
    expect(log).toMatchObject({ severity: 'info', target_type: 'moderation_item:recipe' });
    expect(log!.details).toMatchObject({ restore_note: NOTE, restored_ids: [recipeId], content_id: recipeId, restored: true, approved_flag_ids: [flagId] });
  }, FIRST_COMPILE_TIMEOUT_MS);

  it('A-2: content_moderator は 200。support と一般ユーザーは 403 (何も変わらない)。未認証は 401', async () => {
    const { flagId, mealId } = await seedFoodFlag();
    await hideViaApi('food', flagId);
    const hiddenBefore = await readHidden('meals', mealId);

    expectError(await restoreVia(supportUser.jwt, 'food', flagId), 403, 'OP_PERMISSION_DENIED');
    expectError(await restoreVia(generalUser.jwt, 'food', flagId), 403, 'OP_PERMISSION_DENIED');
    expectError(await restoreVia(null, 'food', flagId), 401, 'AUTH_UNAUTHENTICATED');
    expect(await readHidden('meals', mealId)).toEqual(hiddenBefore);
    expect((await readFoodFlag(flagId)).status).toBe('rejected');
    expect(await restoreAuditLogs(flagId)).toEqual([]);

    const res = await restoreVia(moderatorUser.jwt, 'food', flagId);
    expect(dataOf<RestoreData>(res).restored_ids).toEqual([mealId]);
    expect(await readHidden('meals', mealId)).toEqual(NOT_HIDDEN);
    expect((await restoreAuditLogs(flagId)).map((l) => l.actor_id)).toEqual([moderatorUser.userId]);
  });

  it('A-3: 2 回目は 409 OP_CONTENT_NOT_HIDDEN (何も変わらない・監査ログは増えない)', async () => {
    const { flagId, mealId } = await seedFoodFlag();
    await hideViaApi('food', flagId);
    expect(dataOf<RestoreData>(await restoreVia(adminUser.jwt, 'food', flagId)).success).toBe(true);
    const flagAfterFirst = await readFoodFlag(flagId);
    expect(await restoreAuditLogs(flagId)).toHaveLength(1);

    const second = await restoreVia(adminUser.jwt, 'food', flagId);

    expectError(second, 409, 'OP_CONTENT_NOT_HIDDEN');
    expect(await readHidden('meals', mealId)).toEqual(NOT_HIDDEN);
    expect(await readFoodFlag(flagId)).toEqual(flagAfterFirst);
    expect(await restoreAuditLogs(flagId)).toHaveLength(1);
  });

  it('A-4: hidden_at を 90 日前に書き換えた行は 409 OP_CONTENT_RESTORE_WINDOW_EXPIRED (hidden_at はそのまま)', async () => {
    const { flagId, mealId } = await seedFoodFlag();
    await hideViaApi('food', flagId);
    const expiredAt = new Date(Date.now() - EXPIRED_AFTER_DAYS * MS_PER_DAY).toISOString();
    const { error } = await supabaseAdmin.from('meals').update({ hidden_at: expiredAt }).eq('id', mealId);
    expect(error).toBeNull();
    const hiddenBefore = await readHidden('meals', mealId);

    const res = await restoreVia(adminUser.jwt, 'food', flagId);

    expectError(res, 409, 'OP_CONTENT_RESTORE_WINDOW_EXPIRED');
    expect((res.body as { data: { hidden_at: string } }).data.hidden_at).toBe(hiddenBefore.hidden_at);
    expect(await readHidden('meals', mealId)).toEqual(hiddenBefore);
    expect((await readFoodFlag(flagId)).status).toBe('rejected');
    expect(await restoreAuditLogs(flagId)).toEqual([]);
  });

  it('A-5: meal_id が NULL の通報 (service_role で NULL のまま INSERT したもの。行を消すと通報も CASCADE で消えるので、行を消して作ることはできない) は 410 OP_CONTENT_GONE。何も変わらず監査ログも増えない (S-10)', async () => {
    seq += 1;
    const { data: flag, error } = await supabaseAdmin
      .from('moderation_flags')
      .insert({ meal_id: null, user_id: reporterUser.userId, reason: `T1538 orphan ${TS}-${seq}`, status: 'rejected', flag_type: 'inappropriate' })
      .select('id')
      .single();
    if (error || !flag) throw new Error(`seed orphan flag failed: ${error?.message}`);
    createdFlagIds.push(flag.id as string);

    const res = await restoreVia(adminUser.jwt, 'food', flag.id as string);

    expectError(res, 410, 'OP_CONTENT_GONE');
    expect((await readFoodFlag(flag.id as string)).status).toBe('rejected');
    expect(await restoreAuditLogs(flag.id as string)).toEqual([]);
  });

  it('A-6: 同じ食事に rejected の通報が 2 件あるとき、片方から戻すと両方 approved (approved_flag_ids に 2 つ)', async () => {
    const first = await seedFoodFlag();
    const second = await seedFoodFlag({ mealId: first.mealId, reporterId: generalUser.userId });
    await hideViaApi('food', first.flagId);
    await hideViaApi('food', second.flagId);

    const res = await restoreVia(adminUser.jwt, 'food', second.flagId);

    const data = dataOf<RestoreData>(res);
    expect([...data.approved_flag_ids].sort()).toEqual([first.flagId, second.flagId].sort());
    expect(data.restored_ids).toEqual([first.mealId]);
    for (const id of [first.flagId, second.flagId]) {
      expect(await readFoodFlag(id)).toMatchObject({ status: 'approved', resolved_by: adminUser.userId, resolution_note: NOTE });
    }
  });

  it('A-7: GET /queue と GET /{type}/{id} が hidden_at を返す (隠す前は null・隠したあとは ISO・戻したあと null)', async () => {
    const { flagId } = await seedFoodFlag();
    type Item = { id: string; hidden_at: string | null };
    const detail = async () => dataOf<Item>(await apiCall('GET', `/api/admin/moderation/food/${flagId}`, adminUser.jwt)).hidden_at;
    const inQueue = async (status: string) => {
      for (let page = 1; page <= 20; page += 1) {
        const res = await apiCall<{ data: Item[]; meta: { total: number } }>('GET', `/api/admin/moderation/queue?status=${status}&per_page=100&page=${page}`, adminUser.jwt);
        expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
        const hit = res.body.data.find((item) => item.id === flagId);
        if (hit) return hit.hidden_at;
        if (page * 100 >= res.body.meta.total) return undefined;
      }
      return undefined;
    };
    expect(await detail()).toBeNull();
    expect(await inQueue('pending')).toBeNull();

    await hideViaApi('food', flagId);
    const hiddenAt = await detail();
    expect(typeof hiddenAt).toBe('string');
    expect(Number.isNaN(Date.parse(hiddenAt!))).toBe(false);
    expect(await inQueue('rejected')).toBe(hiddenAt);

    expect(dataOf<RestoreData>(await restoreVia(adminUser.jwt, 'food', flagId)).success).toBe(true);
    expect(await detail()).toBeNull();
    expect(await inQueue('approved')).toBeNull();
  });

  it('A-8: restore_note が空白だけなら 400 VALIDATION_ERROR。NULL 文字は 400 INVALID_CHARACTER', async () => {
    const { flagId, mealId } = await seedFoodFlag();
    await hideViaApi('food', flagId);

    expectError(await restoreVia(adminUser.jwt, 'food', flagId, { restore_note: '   ' }), 400, 'VALIDATION_ERROR');
    expectError(await restoreVia(adminUser.jwt, 'food', flagId, {}), 400, 'VALIDATION_ERROR');
    const nullChar = await restoreVia(adminUser.jwt, 'food', flagId, { restore_note: 'a\u0000b' });
    expect(nullChar.status).toBe(400);
    expect((nullChar.body as { code?: string }).code).toBe('INVALID_CHARACTER');
    expect((await readHidden('meals', mealId)).hidden_at).not.toBeNull();
    expect(await restoreAuditLogs(flagId)).toEqual([]);
  });

  it('A-9: admin と content_moderator が同じ通報を同時に (Promise.all) restore すると、応答は 200 と 409 OP_CONTENT_NOT_HIDDEN が 1 つずつ。行の 3 列は NULL・通報は approved。その通報を target_id とする admin.moderation.restore の監査ログは 1 行か 2 行増え (交差の順による)、そのうち restored: true は 200 を返した人の 1 行だけ。approved_flag_ids の和は [その通報]で、通報の resolved_by の人の監査ログの approved_flag_ids にその通報がある (S-16・R-10・R-20)', async () => {
    const { flagId, mealId } = await seedFoodFlag();
    await hideViaApi('food', flagId);

    const [adminRes, moderatorRes] = await Promise.all([
      restoreVia(adminUser.jwt, 'food', flagId),
      restoreVia(moderatorUser.jwt, 'food', flagId),
    ]);

    const results = [
      { actor: adminUser.userId, res: adminRes },
      { actor: moderatorUser.userId, res: moderatorRes },
    ];
    expect(results.map((r) => r.res.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.res.status === 200)!;
    const loser = results.find((r) => r.res.status === 409)!;
    expectError(loser.res, 409, 'OP_CONTENT_NOT_HIDDEN');
    expect(await readHidden('meals', mealId)).toEqual(NOT_HIDDEN);
    const flag = await readFoodFlag(flagId);
    expect(flag.status).toBe('approved');

    const logs = await restoreAuditLogs(flagId);
    expect(logs.length === 1 || logs.length === 2, `監査ログの行数: ${logs.length}`).toBe(true);
    const restoredLogs = logs.filter((l) => l.details.restored === true);
    expect(restoredLogs.map((l) => l.actor_id)).toEqual([winner.actor]);
    const approvedUnion = [...new Set(logs.flatMap((l) => l.details.approved_flag_ids as string[]))];
    expect(approvedUnion).toEqual([flagId]);
    // 通報の resolved_by の人の監査ログに、この通報が approved_flag_ids として残る
    const resolverLog = logs.find((l) => l.actor_id === flag.resolved_by);
    expect(resolverLog, `resolved_by=${flag.resolved_by} の監査ログが無い`).toBeDefined();
    expect(resolverLog!.details.approved_flag_ids).toContain(flagId);
    // 負けた側が何も書いていなければ、その人の行は無い。書いていれば warn
    for (const log of logs.filter((l) => l.actor_id === loser.actor)) expect(log.severity).toBe('warn');
  });
});
