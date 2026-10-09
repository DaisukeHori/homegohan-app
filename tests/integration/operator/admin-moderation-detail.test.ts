/**
 * Integration tests: 運営のモデレーション API とユーザー凍結解除 (#849 / T07)
 *   GET    /api/admin/moderation/queue
 *   POST   /api/admin/moderation/[type]/[id]
 *   DELETE /api/admin/users/[id]/freeze  (BAN 解除)
 *
 * 権限: モデレーションは admin / super_admin / content_moderator (永久 BAN だけ super_admin)、
 * 凍結解除は admin / super_admin。ほかのロール (support など) と一般ユーザーは 403、未認証は 401。
 * 入力エラーは 400 + code=VALIDATION_ERROR または INVALID_JSON (AC の「422 相当」はこの 400)。
 * BAN 対象を特定できないときだけ 422 (OP_BAN_TARGET_UNRESOLVED)。
 *
 * #1041 (#1081) で実テーブル moderation_flags / recipe_flags を使う実装に書き換わっている。
 * このテストは、通報フラグ・通報された食事 (meals)・レシピ (recipes) を service_role で seed し、
 * 承認 / 却下 / エスカレーション / BAN の 200・403・404・422・500 を決定的に検証する。
 * BAN の対象は「通報者」ではなく「コンテンツの所有者」であることも確かめる。
 * 凍結解除は #1074 以降 service_role で動くため、200 だけを期待する。
 *
 * #1101: delete_* アクション (delete_only / delete_and_warn / delete_and_temp_ban / delete_and_perm_ban) は、通報された食事・レシピを
 * 消さずに隠す (hidden_at / hidden_by / hidden_reason)。approve / escalate は隠さない。隠したレシピは、公開レシピでも
 * 未ログインの GET /api/recipes に出なくなる (ログイン中の見え方は tests/integration/rls/hidden-content-visibility.test.ts)。
 * 同じコンテンツへの 2 件目の通報では、隠した日時を延ばさない。監査ログに content_id と hidden が残る。
 *
 * 実行: CONTRIBUTING.md の「インテグレーションテスト」(ローカル Supabase + Next dev サーバ) を参照。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { TestUser } from '../helpers/users';
import { supabaseAdmin } from '../helpers/supabase';
import { apiCall, apiCallNoAuth, apiCallRaw } from '../helpers/api';
import {
  TestUserPool,
  dataOf,
  expectError,
  latestAuditLog,
  randomUuid,
} from '../helpers/admin-test-utils';

const TS = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const pool = new TestUserPool(TS, 'mod');

let adminUser: TestUser;
let superAdminUser: TestUser;
let moderatorUser: TestUser; // content_moderator
let generalUser: TestUser; // 権限なし (role=user)
let supportUser: TestUser; // 運営だが moderation / 凍結操作の権限は無い
let reporterUser: TestUser; // 通報者 (BAN されてはいけない)
let ownerUser: TestUser; // 通報されたコンテンツの所有者 (BAN の対象)
let targetUser: TestUser; // 凍結解除の対象

const createdMealIds: string[] = [];
const createdRecipeIds: string[] = [];
const createdFlagIds: string[] = []; // 親 (meals) を消しても消えないフラグ (meal_id = null)
let seq = 0;

interface QueueItem {
  id: string;
  type: 'food' | 'recipe';
  content_url: string | null;
  reporter_count: number;
  user_id: string | null;
  status: string;
  reason: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string | null;
}

interface QueueBody {
  data: QueueItem[];
  meta: { total: number; page: number; per_page: number; capped: boolean };
}

interface FrozenState {
  frozen_at: string | null;
  frozen_reason: string | null;
  frozen_by: string | null;
  unban_at: string | null;
}

// ─── seed / read helpers ──────────────────────────────────────────────────────

/** 通報された食事 + 通報フラグ (moderation_flags) を作る。所有者 = ownerId、通報者 = reporterUser */
async function seedFoodFlag(ownerId: string) {
  seq += 1;
  const photoUrl = `https://test.example.com/t849/meal-${TS}-${seq}.jpg`;
  const reason = `T849 food flag ${TS}-${seq}`;
  const { data: meal, error: mealError } = await supabaseAdmin
    .from('meals')
    .insert({
      user_id: ownerId,
      eaten_at: new Date().toISOString(),
      meal_type: 'dinner',
      photo_url: photoUrl,
      memo: 'T849 moderation seed',
    })
    .select('id')
    .single();
  if (mealError || !meal) throw new Error(`seed meal failed: ${mealError?.message}`);
  createdMealIds.push(meal.id as string);

  const { data: flag, error: flagError } = await supabaseAdmin
    .from('moderation_flags')
    .insert({
      meal_id: meal.id,
      user_id: reporterUser.userId,
      reason,
      status: 'pending',
      flag_type: 'inappropriate',
    })
    .select('id')
    .single();
  if (flagError || !flag) throw new Error(`seed moderation_flags failed: ${flagError?.message}`);
  return { flagId: flag.id as string, mealId: meal.id as string, photoUrl, reason };
}

/** 通報されたレシピ + 通報フラグ (recipe_flags) を作る。所有者 = ownerId、通報者 = reporterUser */
async function seedRecipeFlag(ownerId: string, options: { isPublic?: boolean; name?: string } = {}) {
  seq += 1;
  const imageUrl = `https://test.example.com/t849/recipe-${TS}-${seq}.jpg`;
  const reason = `T849 recipe flag ${TS}-${seq}`;
  const name = options.name ?? `T849 recipe ${TS}-${seq}`;
  const { data: recipe, error: recipeError } = await supabaseAdmin
    .from('recipes')
    .insert({
      user_id: ownerId,
      name,
      image_url: imageUrl,
      is_public: options.isPublic ?? false,
    })
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
      reason,
      status: 'pending',
    })
    .select('id')
    .single();
  if (flagError || !flag) throw new Error(`seed recipe_flags failed: ${flagError?.message}`);
  return { flagId: flag.id as string, recipeId: recipe.id as string, imageUrl, reason, name };
}

/** 食事が紐づかない (= コンテンツ所有者を特定できない) 通報フラグを作る */
async function seedOrphanFoodFlag(): Promise<string> {
  seq += 1;
  const { data: flag, error } = await supabaseAdmin
    .from('moderation_flags')
    .insert({
      meal_id: null,
      user_id: reporterUser.userId,
      reason: `T849 orphan flag ${TS}-${seq}`,
      status: 'pending',
      flag_type: 'inappropriate',
    })
    .select('id')
    .single();
  if (error || !flag) throw new Error(`seed orphan moderation_flags failed: ${error?.message}`);
  createdFlagIds.push(flag.id as string);
  return flag.id as string;
}

async function readFoodFlag(flagId: string) {
  const { data, error } = await supabaseAdmin
    .from('moderation_flags')
    .select('status, resolved_by, resolved_at, resolution_note')
    .eq('id', flagId)
    .single();
  if (error || !data) throw new Error(`readFoodFlag failed: ${error?.message}`);
  return data as {
    status: string;
    resolved_by: string | null;
    resolved_at: string | null;
    resolution_note: string | null;
  };
}

async function readRecipeFlag(flagId: string) {
  const { data, error } = await supabaseAdmin
    .from('recipe_flags')
    .select('status, reviewed_by, reviewed_at')
    .eq('id', flagId)
    .single();
  if (error || !data) throw new Error(`readRecipeFlag failed: ${error?.message}`);
  return data as { status: string; reviewed_by: string | null; reviewed_at: string | null };
}

/** 通報されたコンテンツ (meals / recipes) の隠し状態 (#1101) */
async function readHidden(table: 'meals' | 'recipes', id: string) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('hidden_at, hidden_by, hidden_reason')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`readHidden ${table} failed: ${error?.message}`);
  return data as { hidden_at: string | null; hidden_by: string | null; hidden_reason: string | null };
}

const NOT_HIDDEN = { hidden_at: null, hidden_by: null, hidden_reason: null };

async function readFrozen(userId: string): Promise<FrozenState> {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('frozen_at, frozen_reason, frozen_by, unban_at')
    .eq('id', userId)
    .single();
  if (error || !data) throw new Error(`readFrozen failed: ${error?.message}`);
  return data as FrozenState;
}

/** service_role で凍結状態にする (DELETE /freeze の前提を、POST /freeze に依存せず作る) */
async function freezeInDb(userId: string, frozenBy: string, unbanAt: string | null = null) {
  const { error } = await supabaseAdmin
    .from('user_profiles')
    .update({
      frozen_at: new Date().toISOString(),
      frozen_reason: '[spam] T849 integration freeze',
      frozen_by: frozenBy,
      unban_at: unbanAt,
    })
    .eq('id', userId);
  if (error) throw new Error(`freezeInDb failed: ${error.message}`);
}

/** service_role で凍結状態を解く (テスト間の持ち越しを防ぐ後始末) */
async function clearFrozenInDb(userId: string) {
  await supabaseAdmin
    .from('user_profiles')
    .update({ frozen_at: null, frozen_reason: null, frozen_by: null, unban_at: null })
    .eq('id', userId);
}

/** キューの全ページを辿って、指定 ID の項目を探す (共有 DB に他の行があっても見つかるように) */
async function findInQueue(jwt: string, id: string, query = ''): Promise<QueueItem | undefined> {
  for (let page = 1; page <= 20; page += 1) {
    const res = await apiCall<QueueBody>(
      'GET',
      `/api/admin/moderation/queue?per_page=100&page=${page}${query}`,
      jwt,
    );
    expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
    const hit = res.body.data.find((item) => item.id === id);
    if (hit) return hit;
    if (page * 100 >= res.body.meta.total) return undefined;
  }
  return undefined;
}

beforeAll(async () => {
  ({
    adminUser,
    superAdminUser,
    moderatorUser,
    generalUser,
    supportUser,
    reporterUser,
    ownerUser,
    targetUser,
  } = await pool.createMany({
    adminUser: ['admin'],
    superAdminUser: ['super_admin'],
    moderatorUser: ['content_moderator'],
    generalUser: ['user'],
    supportUser: ['support'],
    reporterUser: ['user'],
    ownerUser: ['user'],
    targetUser: ['user'],
  }));
}, 60000);

afterAll(async () => {
  // moderation_flags.resolved_by / recipe_flags.reviewed_by・reporter_id は auth.users への外部キー (NO ACTION)。
  // ユーザーより先にフラグを消す (食事・レシピを消すと ON DELETE CASCADE でフラグも消える)。
  if (createdFlagIds.length > 0) {
    await supabaseAdmin.from('moderation_flags').delete().in('id', createdFlagIds);
  }
  if (createdMealIds.length > 0) {
    await supabaseAdmin.from('meals').delete().in('id', createdMealIds);
  }
  if (createdRecipeIds.length > 0) {
    await supabaseAdmin.from('recipes').delete().in('id', createdRecipeIds);
  }
  await pool.cleanup();
}, 60000);

// ─── GET /api/admin/moderation/queue ──────────────────────────────────────────

describe('GET /api/admin/moderation/queue', () => {
  // 読み取り専用のテスト用に共有する seed (POST 系のテストは自分のフラグを作るので、これは変わらない)
  let sharedFood: Awaited<ReturnType<typeof seedFoodFlag>>;
  let sharedRecipe: Awaited<ReturnType<typeof seedRecipeFlag>>;

  beforeAll(async () => {
    sharedFood = await seedFoodFlag(ownerUser.userId);
    sharedRecipe = await seedRecipeFlag(ownerUser.userId);
  }, 30000);

  it('200 for admin role - lists the pending food flag with the content owner (not the reporter)', async () => {
    const item = await findInQueue(adminUser.jwt, sharedFood.flagId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      id: sharedFood.flagId,
      type: 'food',
      status: 'pending',
      reason: sharedFood.reason,
      content_url: sharedFood.photoUrl,
      reporter_count: 1,
      user_id: ownerUser.userId, // BAN 対象になるのはコンテンツ所有者
      resolved_by: null,
      resolved_at: null,
    });
    expect(item!.user_id).not.toBe(reporterUser.userId);
  });

  it('200 lists the pending recipe flag as type=recipe', async () => {
    const item = await findInQueue(adminUser.jwt, sharedRecipe.flagId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      type: 'recipe',
      status: 'pending',
      reason: sharedRecipe.reason,
      content_url: sharedRecipe.imageUrl,
      user_id: ownerUser.userId,
    });
  });

  it('200 for content_moderator role - can read the queue although the flag table RLS is admin-only', async () => {
    const item = await findInQueue(moderatorUser.jwt, sharedFood.flagId);
    expect(item).toBeDefined();
    expect(item!.user_id).toBe(ownerUser.userId);
  });

  it('200 for super_admin role', async () => {
    const item = await findInQueue(superAdminUser.jwt, sharedFood.flagId);
    expect(item).toBeDefined();
  });

  it('200 returns the list shape (data array + meta)', async () => {
    const res = await apiCall<QueueBody>('GET', '/api/admin/moderation/queue', adminUser.jwt);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toMatchObject({ page: 1, per_page: 30, capped: false });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(2); // shared の food + recipe
  });

  it('200 type=food returns only food flags, type=recipe only recipe flags', async () => {
    expect(await findInQueue(adminUser.jwt, sharedFood.flagId, '&type=food')).toBeDefined();
    expect(await findInQueue(adminUser.jwt, sharedRecipe.flagId, '&type=food')).toBeUndefined();
    expect(await findInQueue(adminUser.jwt, sharedRecipe.flagId, '&type=recipe')).toBeDefined();
    expect(await findInQueue(adminUser.jwt, sharedFood.flagId, '&type=recipe')).toBeUndefined();
  });

  it('200 status filter: a resolved flag leaves the pending list and shows up under its new status', async () => {
    const { flagId } = await seedFoodFlag(ownerUser.userId);
    expect(await findInQueue(adminUser.jwt, flagId)).toBeDefined();

    const { error } = await supabaseAdmin
      .from('moderation_flags')
      .update({ status: 'approved', resolved_by: adminUser.userId, resolved_at: new Date().toISOString() })
      .eq('id', flagId);
    expect(error).toBeNull();

    expect(await findInQueue(adminUser.jwt, flagId)).toBeUndefined();
    const approved = await findInQueue(adminUser.jwt, flagId, '&status=approved');
    expect(approved).toMatchObject({ id: flagId, status: 'approved', resolved_by: adminUser.userId });
    expect(await findInQueue(adminUser.jwt, flagId, '&status=rejected')).toBeUndefined();
  });

  it('200 per_page and page paginate the merged list', async () => {
    const res = await apiCall<QueueBody>('GET', '/api/admin/moderation/queue?per_page=1&page=1', adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, per_page: 1 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(2);

    const second = await apiCall<QueueBody>('GET', '/api/admin/moderation/queue?per_page=1&page=2', adminUser.jwt);
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(res.body.data[0].id);
  });

  it('200 type=ai_content returns an empty list (no backing table yet)', async () => {
    const res = await apiCall<QueueBody>('GET', '/api/admin/moderation/queue?type=ai_content', adminUser.jwt);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, capped: false });
  });

  describe('400 for invalid query parameters (validation error)', () => {
    const cases = [
      { name: 'status', query: 'status=INVALID_STATUS' },
      { name: 'type', query: 'type=INVALID_TYPE' },
      { name: 'per_page=0', query: 'per_page=0' },
      { name: 'per_page over 100', query: 'per_page=101' },
      { name: 'page=0', query: 'page=0' },
      { name: 'page that is not a number', query: 'page=abc' },
    ];

    it.each(cases)('$name', async ({ query }) => {
      const res = await apiCall('GET', `/api/admin/moderation/queue?${query}`, adminUser.jwt);
      expectError(res, 400, 'VALIDATION_ERROR');
    });
  });

  it('403 for general user', async () => {
    const res = await apiCall('GET', '/api/admin/moderation/queue', generalUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('403 for support role (staff of another domain)', async () => {
    const res = await apiCall('GET', '/api/admin/moderation/queue', supportUser.jwt);
    expectError(res, 403, 'OP_PERMISSION_DENIED');
  });

  it('401 for no auth', async () => {
    const res = await apiCallNoAuth('GET', '/api/admin/moderation/queue');
    expectError(res, 401);
  });
});

// ─── POST /api/admin/moderation/[type]/[id] ───────────────────────────────────

describe('POST /api/admin/moderation/[type]/[id]', () => {
  const resolveCases = [
    { action: 'approve', status: 'approved' },
    { action: 'delete_only', status: 'rejected' },
    { action: 'delete_and_warn', status: 'rejected' },
    { action: 'escalate', status: 'escalated' },
  ] as const;

  describe('resolving a food flag', () => {
    it.each(resolveCases)(
      '200 for admin role - $action -> $status (no ban), records the resolver and an audit log',
      async ({ action, status }) => {
        const { flagId, mealId } = await seedFoodFlag(ownerUser.userId);
        const note = `T849 ${action} note`;
        const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
          action,
          resolution_note: note,
        });
        expect(dataOf(res)).toEqual({ success: true, status, ban_applied: null });

        const flag = await readFoodFlag(flagId);
        expect(flag).toMatchObject({
          status,
          resolved_by: adminUser.userId,
          resolution_note: note,
        });
        expect(flag.resolved_at).not.toBeNull();
        // BAN を伴わないアクションでは、所有者も通報者も凍結されない
        expect((await readFrozen(ownerUser.userId)).frozen_at).toBeNull();
        expect((await readFrozen(reporterUser.userId)).frozen_at).toBeNull();

        // #1101: delete_* は通報された食事を隠す (消さない)。approve / escalate は隠さない
        const hides = action.startsWith('delete_');
        if (hides) {
          const hidden = await readHidden('meals', mealId);
          expect(hidden.hidden_at).not.toBeNull();
          expect(hidden.hidden_by).toBe(adminUser.userId);
          expect(hidden.hidden_reason).toBe(`moderation:${action}`);
        } else {
          expect(await readHidden('meals', mealId)).toEqual(NOT_HIDDEN);
        }

        const log = await latestAuditLog({
          actorId: adminUser.userId,
          actionType: `admin.moderation.${action}`,
          targetId: flagId,
        });
        expect(log).not.toBeNull();
        expect(log!.target_type).toBe('moderation_item:food');
        expect(log!.severity).toBe('info');
        expect(log!.details).toMatchObject({
          action,
          moderation_type: 'food',
          resolution_note: note,
          content_user_id: ownerUser.userId,
          content_id: mealId,
          hidden: hides,
          ban_applied: null,
        });
      },
    );

    it('200 for content_moderator role - approve (service-role path, RLS on the flag table is admin-only)', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, moderatorUser.jwt, {
        action: 'approve',
      });
      expect(dataOf<{ status: string }>(res).status).toBe('approved');
      expect(await readFoodFlag(flagId)).toMatchObject({
        status: 'approved',
        resolved_by: moderatorUser.userId,
        resolution_note: null, // resolution_note は任意
      });
    });

    it('200 for super_admin role - escalate', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, superAdminUser.jwt, {
        action: 'escalate',
        resolution_note: 'needs a closer look',
      });
      expect(dataOf<{ status: string }>(res).status).toBe('escalated');
    });
  });

  describe('resolving a recipe flag', () => {
    it.each(resolveCases)(
      '200 for admin role - $action -> $status, records the reviewer',
      async ({ action, status }) => {
        const { flagId, recipeId } = await seedRecipeFlag(ownerUser.userId);
        const res = await apiCall('POST', `/api/admin/moderation/recipe/${flagId}`, adminUser.jwt, {
          action,
          resolution_note: `T849 ${action} note`,
        });
        expect(dataOf(res)).toEqual({ success: true, status, ban_applied: null });

        // recipe_flags には resolution_note 列が無い (監査ログにだけ残る)
        const flag = await readRecipeFlag(flagId);
        expect(flag).toMatchObject({ status, reviewed_by: adminUser.userId });
        expect(flag.reviewed_at).not.toBeNull();

        // #1101: delete_* は通報されたレシピを隠す (消さない)。approve / escalate は隠さない
        const hides = action.startsWith('delete_');
        const hidden = await readHidden('recipes', recipeId);
        if (hides) {
          expect(hidden.hidden_at).not.toBeNull();
          expect(hidden.hidden_by).toBe(adminUser.userId);
          expect(hidden.hidden_reason).toBe(`moderation:${action}`);
        } else {
          expect(hidden).toEqual(NOT_HIDDEN);
        }

        const log = await latestAuditLog({
          actorId: adminUser.userId,
          actionType: `admin.moderation.${action}`,
          targetId: flagId,
        });
        expect(log!.target_type).toBe('moderation_item:recipe');
        expect(log!.details).toMatchObject({
          moderation_type: 'recipe',
          content_user_id: ownerUser.userId,
          content_id: recipeId,
          hidden: hides,
        });
      },
    );

    it('200 for content_moderator role', async () => {
      const { flagId } = await seedRecipeFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/recipe/${flagId}`, moderatorUser.jwt, {
        action: 'approve',
      });
      expect(dataOf<{ status: string }>(res).status).toBe('approved');
      expect((await readRecipeFlag(flagId)).reviewed_by).toBe(moderatorUser.userId);
    });
  });

  describe('BAN actions (the content owner is banned, never the reporter)', () => {
    afterEach(async () => {
      await clearFrozenInDb(ownerUser.userId);
      await clearFrozenInDb(superAdminUser.userId);
    });

    it('200 for admin role - delete_and_temp_ban freezes the owner until now + ban_duration_days', async () => {
      const { flagId, mealId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_and_temp_ban',
        ban_duration_days: 7,
        resolution_note: 'repeated violations',
      });
      expect(dataOf(res)).toEqual({ success: true, status: 'rejected', ban_applied: true });
      expect((await readFoodFlag(flagId)).status).toBe('rejected');
      // #1101: BAN と一緒に、通報された食事も隠される
      expect((await readHidden('meals', mealId)).hidden_reason).toBe('moderation:delete_and_temp_ban');

      const owner = await readFrozen(ownerUser.userId);
      expect(owner.frozen_at).not.toBeNull();
      expect(owner.frozen_by).toBe(adminUser.userId);
      expect(owner.frozen_reason).toContain('[moderation:food]');
      expect(owner.frozen_reason).toContain('repeated violations');
      const untilUnban = new Date(owner.unban_at!).getTime() - Date.now();
      expect(untilUnban).toBeGreaterThan(6.9 * DAY_MS);
      expect(untilUnban).toBeLessThan(7.1 * DAY_MS);
      // 通報者は凍結されない
      expect((await readFrozen(reporterUser.userId)).frozen_at).toBeNull();

      const log = await latestAuditLog({
        actorId: adminUser.userId,
        actionType: 'admin.moderation.delete_and_temp_ban',
        targetId: flagId,
      });
      expect(log!.severity).toBe('warn');
      expect(log!.details).toMatchObject({
        ban_duration_days: 7,
        content_user_id: ownerUser.userId,
        content_id: mealId,
        hidden: true,
        ban_applied: true,
        ban_error: null,
      });
      expect(log!.details!.unban_at).toBe(new Date(owner.unban_at!).toISOString());
    });

    it('200 for content_moderator role - a temporary ban is allowed', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, moderatorUser.jwt, {
        action: 'delete_and_temp_ban',
        ban_duration_days: 1,
      });
      expect(dataOf<{ ban_applied: boolean }>(res).ban_applied).toBe(true);
      expect((await readFrozen(ownerUser.userId)).frozen_by).toBe(moderatorUser.userId);
    });

    it('200 for super_admin role - delete_and_perm_ban freezes the owner without an unban date', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, superAdminUser.jwt, {
        action: 'delete_and_perm_ban',
        resolution_note: 'severe violation',
      });
      expect(dataOf(res)).toEqual({ success: true, status: 'rejected', ban_applied: true });

      const owner = await readFrozen(ownerUser.userId);
      expect(owner.frozen_at).not.toBeNull();
      expect(owner.frozen_by).toBe(superAdminUser.userId);
      expect(owner.unban_at).toBeNull();
      expect((await readFrozen(reporterUser.userId)).frozen_at).toBeNull();
    });

    it('200 for super_admin role - a recipe flag bans the recipe owner', async () => {
      const { flagId } = await seedRecipeFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/recipe/${flagId}`, superAdminUser.jwt, {
        action: 'delete_and_perm_ban',
      });
      expect(dataOf<{ ban_applied: boolean }>(res).ban_applied).toBe(true);
      const owner = await readFrozen(ownerUser.userId);
      expect(owner.frozen_at).not.toBeNull();
      expect(owner.frozen_reason).toContain('[moderation:recipe]');
    });

    it('403 for admin role - delete_and_perm_ban is super_admin only, and nothing changes', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_and_perm_ban',
      });
      expectError(res, 403, 'OP_PERMISSION_DENIED');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
      expect((await readFrozen(ownerUser.userId)).frozen_at).toBeNull();
    });

    it('403 for content_moderator role - delete_and_perm_ban is super_admin only, and nothing changes', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, moderatorUser.jwt, {
        action: 'delete_and_perm_ban',
      });
      expectError(res, 403, 'OP_PERMISSION_DENIED');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
      expect((await readFrozen(ownerUser.userId)).frozen_at).toBeNull();
    });

    it('400 for delete_and_temp_ban without ban_duration_days, and nothing changes', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_and_temp_ban',
      });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
      expect((await readFrozen(ownerUser.userId)).frozen_at).toBeNull();
    });

    it.each([
      { name: 'ban_duration_days=0', days: 0 },
      { name: 'ban_duration_days over 365', days: 366 },
      { name: 'ban_duration_days that is not an integer', days: 1.5 },
    ])('400 for $name', async ({ days }) => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_and_temp_ban',
        ban_duration_days: days,
      });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });

    it('500 OP_BAN_FAILED when the content owner is a protected super_admin (the verdict is saved, no false success)', async () => {
      const { flagId } = await seedFoodFlag(superAdminUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_and_temp_ban',
        ban_duration_days: 3,
      });
      expectError(res, 500, 'OP_BAN_FAILED');
      expect((res.body as { data: unknown }).data).toEqual({ status: 'rejected', ban_applied: false });
      expect((await readFoodFlag(flagId)).status).toBe('rejected');
      expect((await readFrozen(superAdminUser.userId)).frozen_at).toBeNull();

      const log = await latestAuditLog({
        actorId: adminUser.userId,
        actionType: 'admin.moderation.delete_and_temp_ban',
        targetId: flagId,
      });
      expect(log!.details).toMatchObject({ ban_applied: false });
      expect(log!.details!.ban_error).toEqual(expect.stringContaining('super_admin'));
    });

    it('422 OP_BAN_TARGET_UNRESOLVED when the content owner cannot be identified (the verdict is saved, no false success)', async () => {
      const flagId = await seedOrphanFoodFlag();
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, superAdminUser.jwt, {
        action: 'delete_and_perm_ban',
      });
      expectError(res, 422, 'OP_BAN_TARGET_UNRESOLVED');
      expect((res.body as { data: unknown }).data).toEqual({ status: 'rejected', ban_applied: null });
      expect((await readFoodFlag(flagId)).status).toBe('rejected');
      // 所有者が分からないので、誰も凍結されない (通報者を誤って凍結しない)
      expect((await readFrozen(reporterUser.userId)).frozen_at).toBeNull();

      const log = await latestAuditLog({
        actorId: superAdminUser.userId,
        actionType: 'admin.moderation.delete_and_perm_ban',
        targetId: flagId,
      });
      expect(log!.details).toMatchObject({ content_user_id: null, ban_applied: null });
      expect(log!.details!.ban_error).toEqual(expect.stringContaining('特定できませんでした'));
    });

    it('200 a non-ban action on a flag without an identifiable owner still succeeds', async () => {
      const flagId = await seedOrphanFoodFlag();
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'delete_only',
      });
      expect(dataOf(res)).toEqual({ success: true, status: 'rejected', ban_applied: null });

      // #1101: 通報にコンテンツが紐づかないので、隠す対象が無い (隠さずに続行する)
      const log = await latestAuditLog({
        actorId: adminUser.userId,
        actionType: 'admin.moderation.delete_only',
        targetId: flagId,
      });
      expect(log!.details).toMatchObject({ content_id: null, hidden: false });
    });
  });

  describe('hidden content (#1101): a hidden public recipe disappears from GET /api/recipes', () => {
    type RecipeListBody = { recipes: Array<{ id: string; name: string }> };

    /**
     * 未ログインの GET /api/recipes?q=<name> で見える、その名前のレシピ。
     * ログイン中の GET /api/recipes は、recipes と user_profiles の関係が無く (embed が失敗し、DB エラーを握りつぶして空の 200 を返す)、
     * 隠す・隠さないに関係なく常に空になる既存の不具合がある。そのため API 経由の確認は未ログインで行う。
     * ログイン中のユーザー・本人・家族の見え方は、PostgREST を直接叩く tests/integration/rls/hidden-content-visibility.test.ts で確かめている
     */
    const listNamesAsAnon = async (name: string) => {
      const res = await apiCallNoAuth<RecipeListBody>('GET', `/api/recipes?q=${encodeURIComponent(name)}&limit=100`);
      expect(res.status, `応答本文: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body.recipes.map((r) => r.name);
    };

    it('200 delete_only hides a public recipe from the public list (GET /api/recipes) without deleting the row', async () => {
      seq += 1;
      const name = `t1101hide${TS}x${seq}`;
      const { flagId, recipeId } = await seedRecipeFlag(ownerUser.userId, { isPublic: true, name });
      // 隠す前は、未ログインにも見える
      expect(await listNamesAsAnon(name)).toEqual([name]);

      const res = await apiCall('POST', `/api/admin/moderation/recipe/${flagId}`, adminUser.jwt, {
        action: 'delete_only',
        resolution_note: 'T1101 hide a public recipe',
      });
      expect(dataOf(res)).toEqual({ success: true, status: 'rejected', ban_applied: null });
      expect((await readHidden('recipes', recipeId)).hidden_at).not.toBeNull();

      expect(await listNamesAsAnon(name)).toEqual([]);
      // 行は消えていない (本人と運営には残る)
      const { data: row } = await supabaseAdmin.from('recipes').select('id').eq('id', recipeId).maybeSingle();
      expect(row?.id).toBe(recipeId);
      // next dev は GET /api/recipes を初回リクエスト時にコンパイルする。初回でも 30 秒の既定に収まるよう余裕を持たせる
    }, 60_000);

    it('200 approve keeps a public recipe in the public list', async () => {
      seq += 1;
      const name = `t1101keep${TS}x${seq}`;
      const { flagId } = await seedRecipeFlag(ownerUser.userId, { isPublic: true, name });

      const res = await apiCall('POST', `/api/admin/moderation/recipe/${flagId}`, adminUser.jwt, { action: 'approve' });
      expect(dataOf<{ status: string }>(res).status).toBe('approved');

      expect(await listNamesAsAnon(name)).toEqual([name]);
    });

    it('200 a second report on the same content does not move hidden_at forward (the retention starts at the first hide)', async () => {
      const first = await seedFoodFlag(ownerUser.userId);
      const firstRes = await apiCall('POST', `/api/admin/moderation/food/${first.flagId}`, adminUser.jwt, {
        action: 'delete_only',
      });
      expect(dataOf(firstRes)).toEqual({ success: true, status: 'rejected', ban_applied: null });
      const hiddenOnce = await readHidden('meals', first.mealId);
      expect(hiddenOnce.hidden_at).not.toBeNull();

      // 同じ食事への 2 件目の通報 (別の運営が処理する)
      const { data: flag, error } = await supabaseAdmin
        .from('moderation_flags')
        .insert({
          meal_id: first.mealId,
          user_id: reporterUser.userId,
          reason: 'T1101 second report',
          status: 'pending',
          flag_type: 'inappropriate',
        })
        .select('id')
        .single();
      expect(error).toBeNull();
      const secondRes = await apiCall('POST', `/api/admin/moderation/food/${flag!.id}`, moderatorUser.jwt, {
        action: 'delete_and_warn',
      });
      expect(dataOf(secondRes)).toEqual({ success: true, status: 'rejected', ban_applied: null });

      expect(await readHidden('meals', first.mealId)).toEqual(hiddenOnce);
    });
  });

  describe('400 / 404 for invalid requests', () => {
    it('400 for an invalid type in the URL', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/INVALID_TYPE/${flagId}`, adminUser.jwt, {
        action: 'approve',
      });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });

    it.each([
      { name: 'an invalid action', body: { action: 'INVALID_ACTION' } },
      { name: 'a missing action', body: { resolution_note: 'no action' } },
      { name: 'an empty resolution_note', body: { action: 'approve', resolution_note: '' } },
      {
        name: 'a resolution_note over 5000 characters',
        body: { action: 'approve', resolution_note: 'x'.repeat(5001) },
      },
    ])('400 for $name, and the flag stays pending', async ({ body }) => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, body);
      expectError(res, 400, 'VALIDATION_ERROR');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });

    it('400 INVALID_JSON for a malformed JSON body', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCallRaw(
        'POST',
        `/api/admin/moderation/food/${flagId}`,
        adminUser.jwt,
        '{"action": ',
      );
      expectError(res, 400, 'INVALID_JSON');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });

    it('404 for a food flag that does not exist', async () => {
      const res = await apiCall('POST', `/api/admin/moderation/food/${randomUuid()}`, adminUser.jwt, {
        action: 'approve',
      });
      expectError(res, 404, 'NOT_FOUND');
    });

    it('404 for a recipe flag that does not exist', async () => {
      const res = await apiCall('POST', `/api/admin/moderation/recipe/${randomUuid()}`, adminUser.jwt, {
        action: 'approve',
      });
      expectError(res, 404, 'NOT_FOUND');
    });

    // 既知の不具合: UUID でない id を DB にそのまま渡し、DB エラーが 500 INTERNAL_ERROR になる
    // (users/[id]/freeze は同じ入力で 404 を返す)。400 / 404 などの 4xx が期待。直ったら `.fails` を外すこと。
    it.fails('[既知の不具合] 4xx for an id that is not a UUID (現状は 500 INTERNAL_ERROR)', async () => {
      const res = await apiCall('POST', '/api/admin/moderation/food/not-a-uuid', adminUser.jwt, {
        action: 'approve',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('404 for type=ai_content (no backing table yet)', async () => {
      const res = await apiCall('POST', `/api/admin/moderation/ai_content/${randomUuid()}`, adminUser.jwt, {
        action: 'approve',
      });
      expectError(res, 404, 'NOT_FOUND');
    });

    it('404 when a recipe flag id is used with type=food (the types are separate tables)', async () => {
      const { flagId } = await seedRecipeFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, adminUser.jwt, {
        action: 'approve',
      });
      expectError(res, 404, 'NOT_FOUND');
      expect((await readRecipeFlag(flagId)).status).toBe('pending');
    });
  });

  describe('authorization', () => {
    it('403 for general user, and the flag stays pending', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, generalUser.jwt, {
        action: 'approve',
      });
      expectError(res, 403, 'OP_PERMISSION_DENIED');
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });

    it('403 for support role (staff of another domain)', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCall('POST', `/api/admin/moderation/food/${flagId}`, supportUser.jwt, {
        action: 'approve',
      });
      expectError(res, 403, 'OP_PERMISSION_DENIED');
    });

    it('401 for no auth, and the flag stays pending', async () => {
      const { flagId } = await seedFoodFlag(ownerUser.userId);
      const res = await apiCallNoAuth('POST', `/api/admin/moderation/food/${flagId}`, {
        action: 'approve',
      });
      expectError(res, 401);
      expect((await readFoodFlag(flagId)).status).toBe('pending');
    });
  });
});

// ─── DELETE /api/admin/users/[id]/freeze (BAN 解除) ───────────────────────────

describe('DELETE /api/admin/users/[id]/freeze (BAN 解除)', () => {
  afterEach(async () => {
    await clearFrozenInDb(targetUser.userId);
    await clearFrozenInDb(reporterUser.userId);
  });

  it('200 for admin role - clears every frozen_* column and writes an audit log; other users stay frozen', async () => {
    await freezeInDb(targetUser.userId, adminUser.userId, new Date(Date.now() + DAY_MS).toISOString());
    await freezeInDb(reporterUser.userId, adminUser.userId);

    const res = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, {
      reason: 'Integration test unfreeze',
    });
    expect(dataOf(res)).toEqual({ success: true });

    expect(await readFrozen(targetUser.userId)).toEqual({
      frozen_at: null,
      frozen_reason: null,
      frozen_by: null,
      unban_at: null,
    });
    // 別のユーザーの凍結は解除されない
    expect((await readFrozen(reporterUser.userId)).frozen_at).not.toBeNull();

    const log = await latestAuditLog({
      actorId: adminUser.userId,
      actionType: 'admin.user.unban',
      targetId: targetUser.userId,
    });
    expect(log).not.toBeNull();
    expect(log!.target_type).toBe('user');
    expect(log!.severity).toBe('warn');
    expect(log!.details).toMatchObject({ reason: 'Integration test unfreeze' });
  });

  it('200 for super_admin role - unfreezes a permanent ban', async () => {
    await freezeInDb(targetUser.userId, superAdminUser.userId);
    const res = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, superAdminUser.jwt, {
      reason: 'Super admin unfreeze test',
    });
    expect(dataOf(res)).toEqual({ success: true });
    expect((await readFrozen(targetUser.userId)).frozen_at).toBeNull();
  });

  it('200 round trip - POST freeze then DELETE freeze through the API', async () => {
    const freeze = await apiCall('POST', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, {
      ban_type: 'temporary',
      reason_category: 'spam',
      reason_detail: 'Integration test freeze for the round trip',
      duration_days: 1,
      notify_user: false,
    });
    expect(freeze.status, `応答本文: ${JSON.stringify(freeze.body)}`).toBe(200);
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();

    const unfreeze = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, {
      reason: 'Round trip unfreeze',
    });
    expect(dataOf(unfreeze)).toEqual({ success: true });
    expect(await readFrozen(targetUser.userId)).toEqual({
      frozen_at: null,
      frozen_reason: null,
      frozen_by: null,
      unban_at: null,
    });
  });

  it.each([
    { name: 'an empty reason', body: { reason: '' } },
    { name: 'a missing reason', body: {} },
    { name: 'a reason over 2000 characters', body: { reason: 'x'.repeat(2001) } },
  ])('400 for $name (validation error), and the user stays frozen', async ({ body }) => {
    await freezeInDb(targetUser.userId, adminUser.userId);
    const res = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, adminUser.jwt, body);
    expectError(res, 400, 'VALIDATION_ERROR');
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();
  });

  it('400 INVALID_JSON for a malformed JSON body, and the user stays frozen', async () => {
    await freezeInDb(targetUser.userId, adminUser.userId);
    const res = await apiCallRaw(
      'DELETE',
      `/api/admin/users/${targetUser.userId}/freeze`,
      adminUser.jwt,
      '{"reason": ',
    );
    expectError(res, 400, 'INVALID_JSON');
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();
  });

  it('404 for a user that does not exist', async () => {
    const res = await apiCall('DELETE', `/api/admin/users/${randomUuid()}/freeze`, adminUser.jwt, {
      reason: 'Non-existent user test',
    });
    expectError(res, 404, 'NOT_FOUND');
  });

  it('404 for an id that is not a UUID', async () => {
    const res = await apiCall('DELETE', '/api/admin/users/not-a-uuid/freeze', adminUser.jwt, {
      reason: 'Non-UUID id test',
    });
    expectError(res, 404, 'NOT_FOUND');
  });

  it('403 for general user, and the user stays frozen', async () => {
    await freezeInDb(targetUser.userId, adminUser.userId);
    const res = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, generalUser.jwt, {
      reason: 'Should fail',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();
  });

  it.each([
    { name: 'support', user: () => supportUser },
    { name: 'content_moderator', user: () => moderatorUser },
  ])('403 for $name role (only admin / super_admin may unfreeze)', async ({ user }) => {
    await freezeInDb(targetUser.userId, adminUser.userId);
    const res = await apiCall('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, user().jwt, {
      reason: 'Should fail',
    });
    expectError(res, 403, 'OP_PERMISSION_DENIED');
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();
  });

  it('401 for no auth, and the user stays frozen', async () => {
    await freezeInDb(targetUser.userId, adminUser.userId);
    const res = await apiCallNoAuth('DELETE', `/api/admin/users/${targetUser.userId}/freeze`, {
      reason: 'No auth test',
    });
    expectError(res, 401);
    expect((await readFrozen(targetUser.userId)).frozen_at).not.toBeNull();
  });
});
