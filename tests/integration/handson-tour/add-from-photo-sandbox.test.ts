/**
 * Integration test: POST /api/meal-plans/add-from-photo (sandbox)
 *
 * #1109: sandbox 適格性チェックが user_profiles を .eq('user_id', ...) で引いていた
 * (user_profiles の主キーは id で user_id 列は無い)。PostgREST は 42703 を返すが error を
 * 見ていなかったため profile が常に null になり、「ツアー完了/スキップ済み」「管理者ロール」の
 * 2 ゲートが無条件で素通りしていた (fail-open)。menu-plans/add と共通のヘルパー
 * (src/lib/handson-tour/sandbox-eligibility.ts) に集約して直したので、拒否パスが実効化することを固定する。
 *
 * #1604: お試しの記録は meals (is_sandbox = true) の 1 行に入れ、user_daily_meals / planned_meals には書かない
 * (設計書 09-onboarding-handson-tour 13-integration §2.7)。以前は今日の user_daily_meals をお試しで作っていて、
 *   - 同じ日に本物の記録をすると、UNIQUE(user_id, day_date) でお試しの日にぶら下がり、集計から外れた
 *   - 別の日にやり直すと uniq_user_sandbox_daily_meal (利用者ごとに 1 行) で insert が一意違反になり 500 だった
 *
 * Test patterns:
 *   1. 200 — sandbox 適格ユーザーが写真から食事を追加 → meals に is_sandbox=true の行が 1 行入り、
 *            user_daily_meals は作られない
 *   1b. 200 — 前の日のお試しの行が残っていても (中断して別の日にやり直し)、行を増やさずに使い回す (#1604)
 *   1c. お試しの保存のあと同じ日に本物の記録をすると、is_sandbox=false の日に入る (#1604)
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
  process.env.INTEGRATION_BASE_URL ??
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

/** 前の日にお試しの記録をした時刻 (中断して別の日にやり直す場合の模擬。日付は比べず、更新後の時刻より前であることだけを見る) */
const PREVIOUS_DAY_EATEN_AT = '2020-01-01T12:00:00.000Z';

type SandboxMealRow = { id: string; meal_type: string; memo: string | null; photo_url: string | null; eaten_at: string };

/** 対象ユーザーの meals のお試しの行 (is_sandbox = true) */
async function sandboxMeals(userId: string): Promise<SandboxMealRow[]> {
  const { data, error } = await adminClient()
    .from('meals')
    .select('id, meal_type, memo, photo_url, eaten_at')
    .eq('user_id', userId)
    .eq('is_sandbox', true);
  expect(error).toBeNull();
  return (data ?? []) as SandboxMealRow[];
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
      // meals / user_daily_meals / planned_meals は auth user の削除で cascade される
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 200 — sandbox 適格ユーザーの保存で meals に is_sandbox=true の行が入り、user_daily_meals は作られない (#1109 / #1604)', async () => {
      // 非 admin・ツアー未完了・既存 activity なし = sandbox 適格な fixture であること
      user = await createTestUser({ onboardingCompleted: true });

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sandbox).toBe(true);
      expect(body.mealId).toBeTruthy();

      const rows = await sandboxMeals(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(body.mealId);
      expect(rows[0].meal_type).toBe('dinner');
      expect(rows[0].memo).toBe('鶏の唐揚げ');
      expect(rows[0].photo_url).toBeNull();
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('1b. 200 — 前の日のお試しの行が残っていてもやり直しの保存は成功し、行は 1 行のまま食べた時刻が更新される (#1604)', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();
      const { error: seedError } = await client.from('meals').insert({
        user_id: user.id,
        eaten_at: PREVIOUS_DAY_EATEN_AT,
        meal_type: 'lunch',
        is_sandbox: true,
      });
      expect(seedError).toBeNull();
      const [seeded] = await sandboxMeals(user.id);

      const { status, body } = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });

      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.mealId).toBe(seeded.id);
      const rows = await sandboxMeals(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].meal_type).toBe('dinner');
      expect(Date.parse(rows[0].eaten_at)).toBeGreaterThan(Date.parse(PREVIOUS_DAY_EATEN_AT));
      expect(await countDailyMeals(user.id)).toBe(0);
    });

    it('1c. お試しの保存のあと同じ日に本物の記録をすると、is_sandbox=false の日に入る (お試しの日にぶら下がらない。#1604)', async () => {
      user = await createTestUser({ onboardingCompleted: true });

      const sandboxSaved = await postAddFromPhoto(user.accessToken, { ...PHOTO_BODY, sandbox: true });
      expect(sandboxSaved.status).toBe(200);

      const { status, body } = await postAddFromPhoto(user.accessToken, PHOTO_BODY, 'normal');

      expect(status, JSON.stringify(body)).toBe(200);
      const { data: days, error } = await adminClient()
        .from('user_daily_meals')
        .select('id, day_date, is_sandbox')
        .eq('user_id', user.id);
      expect(error).toBeNull();
      expect(days).toEqual([{ id: body.dailyMealId, day_date: DAY_DATE, is_sandbox: false }]);
      // お試しの行は meals に残ったまま (本物の記録とは別の行)
      expect(await sandboxMeals(user.id)).toHaveLength(1);
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
