/**
 * Integration test: POST /api/meal-plans/add-from-photo (sandbox)
 *
 * #1109: sandbox 適格性チェックが user_profiles を .eq('user_id', ...) で引いていた
 * (user_profiles の主キーは id で user_id 列は無い)。PostgREST は 42703 を返すが error を
 * 見ていなかったため profile が常に null になり、「ツアー完了/スキップ済み」「管理者ロール」の
 * 2 ゲートが無条件で素通りしていた (fail-open)。menu-plans/add と共通のヘルパー
 * (src/lib/handson-tour/sandbox-eligibility.ts) に集約して直したので、拒否パスが実効化することを固定する。
 *
 * Test patterns:
 *   1. 200 — sandbox 適格ユーザーが写真から食事を追加 → user_daily_meals は is_sandbox=true、
 *            planned_meals は source_type='handson_tour' で実際に INSERT される
 *   2. 401 — 認証なし
 *   3. 403 — admin ロールは sandbox_not_eligible (admin_role) で拒否され、何も書き込まれない
 *   4. 409 — ツアー完了済みユーザーは sandbox_not_eligible (already_finished) で拒否され、何も書き込まれない
 *   5. 409 — ツアースキップ済みユーザーも sandbox_not_eligible (already_finished) で拒否される
 *   6. 409 — 既存 (non-sandbox) activity があるユーザーは sandbox_not_eligible (existing_user) で拒否される
 *   7. 404 — user_profiles の行が無いユーザーは profile_not_found で拒否され、何も書き込まれない (fail-closed)
 *   8. 200 — sandbox でない通常の保存は admin でも従来どおり使える (適格性チェックの対象外)
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  adminClient,
  type TestUser,
} from '../helpers/supabase';

const BASE_URL =
  process.env.API_BASE_URL ??
  process.env.PLAYWRIGHT_BASE_URL ??
  'http://localhost:3000';

const DAY_DATE = new Date().toISOString().split('T')[0];

// add-from-photo が実際に受け取る形 (dayDate / mealType / dishes などが必須)
const PHOTO_BODY = {
  dayDate: DAY_DATE,
  mealType: 'dinner',
  dishes: [{ name: '鶏の唐揚げ', cal: 400, role: 'main', ingredient: '鶏もも肉' }],
  totalCalories: 780,
  imageUrl: null,
  nutritionalAdvice: 'バランスのよい和食です',
};

async function postAddFromPhoto(
  accessToken: string,
  body: Record<string, unknown>,
  source = 'handson_tour',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/meal-plans/add-from-photo?source=${source}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `sb-access-token=${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 対象ユーザーの user_daily_meals の件数 (拒否されたリクエストでは 0 のままのはず) */
async function countDailyMeals(userId: string): Promise<number> {
  const { count, error } = await adminClient()
    .from('user_daily_meals')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  expect(error).toBeNull();
  return count ?? 0;
}

describe.skipIf(!shouldRunIntegration())(
  'POST /api/meal-plans/add-from-photo (sandbox) (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      // user_daily_meals / planned_meals は auth user の削除で cascade される
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 200 — sandbox 適格ユーザーの保存で user_daily_meals (is_sandbox=true) と planned_meals が INSERT される (#1109)', async () => {
      // 非 admin・ツアー未完了・既存 activity なし = sandbox 適格な fixture であること
      user = await createTestUser({ onboardingCompleted: true });

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.dailyMealId).toBeTruthy();
      expect(body.mealId).toBeTruthy();

      const client = adminClient();
      const { data: day, error: dayError } = await client
        .from('user_daily_meals')
        .select('id, user_id, day_date, is_sandbox')
        .eq('id', body.dailyMealId as string)
        .single();
      expect(dayError).toBeNull();
      expect(day?.user_id).toBe(user.id);
      expect(day?.day_date).toBe(DAY_DATE);
      expect(day?.is_sandbox).toBe(true);

      const { data: meal, error: mealError } = await client
        .from('planned_meals')
        .select('id, daily_meal_id, meal_type, source_type')
        .eq('id', body.mealId as string)
        .single();
      expect(mealError).toBeNull();
      expect(meal?.daily_meal_id).toBe(body.dailyMealId);
      expect(meal?.meal_type).toBe('dinner');
      expect(meal?.source_type).toBe('handson_tour');
    });

    it('2. 401 — 認証なしリクエスト', async () => {
      const res = await fetch(`${BASE_URL}/api/meal-plans/add-from-photo?source=handson_tour`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...PHOTO_BODY, sandbox: true }),
      });
      expect(res.status).toBe(401);
    });

    it('3. 403 — admin ロールは sandbox_not_eligible/admin_role で拒否され、何も書き込まれない (#1109)', async () => {
      user = await createTestUser({ onboardingCompleted: true, roles: ['admin'] });

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(403);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('admin_role');
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('4. 409 — ツアー完了済みユーザーは sandbox_not_eligible/already_finished で拒否され、何も書き込まれない (#1109)', async () => {
      user = await createTestUser({
        onboardingCompleted: true,
        handsonTourCompletedAt: new Date().toISOString(),
      });

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('already_finished');
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('5. 409 — ツアースキップ済みユーザーも sandbox_not_eligible/already_finished で拒否される (#1109)', async () => {
      user = await createTestUser({
        onboardingCompleted: true,
        handsonTourSkippedAt: new Date().toISOString(),
      });

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('already_finished');
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('6. 409 — 既存 (non-sandbox) activity があるユーザーは sandbox_not_eligible/existing_user で拒否される', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // meals に dish_name 列は無い。存在しない列を入れると INSERT が失敗して既存データが作れず、
      // 判定が素通りして 200 になってしまうので、INSERT の成否も必ず確認する。
      const { error: seedError } = await client.from('meals').insert({
        user_id: user.id,
        eaten_at: new Date().toISOString(),
        meal_type: 'dinner',
        is_sandbox: false,
      });
      expect(seedError).toBeNull();

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('existing_user');
      expect(await countDailyMeals(user.id)).toBe(0);

      await client.from('meals').delete().eq('user_id', user.id);
    });

    it('7. 404 — user_profiles の行が無いユーザーは profile_not_found で拒否され、何も書き込まれない (fail-closed) (#1109)', async () => {
      user = await createTestUser({ onboardingCompleted: true });

      // user_profiles の行だけを消す (auth ユーザーは残るので、ログイン状態は有効なまま)
      const { error: deleteError } = await adminClient().from('user_profiles').delete().eq('id', user.id);
      expect(deleteError).toBeNull();

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(404);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('profile_not_found');
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('8. 200 — sandbox でない通常の保存は admin でも従来どおり使える (適格性チェックの対象外)', async () => {
      user = await createTestUser({ onboardingCompleted: true, roles: ['admin'] });

      const { status, body } = await postAddFromPhoto(user.accessToken, PHOTO_BODY, 'normal');

      expect(status).toBe(200);
      expect(body.success).toBe(true);

      const { data: day } = await adminClient()
        .from('user_daily_meals')
        .select('is_sandbox')
        .eq('id', body.dailyMealId as string)
        .single();
      expect(day?.is_sandbox).toBe(false);
    });
  },
);
