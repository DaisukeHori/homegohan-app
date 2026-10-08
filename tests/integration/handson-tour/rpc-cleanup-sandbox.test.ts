/**
 * Integration test: RPC cleanup_handson_tour_sandbox_rows()
 *
 * Test patterns:
 *   1. 90日超の sandbox 行 (meals / user_daily_meals) を削除し、削除件数 (meals_deleted /
 *      daily_meals_deleted) を戻り値と admin_audit_logs の両方に同じ値で記録する
 *   2. 90日以内の sandbox 行は削除されない
 *   3. 90日超でも non-sandbox の行 (実ユーザーのデータ) は削除されない
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 * Note: service_role キー必須
 *
 * Implementation detail:
 *   テスト用に created_at を90日以上前に偽装した行を直接 INSERT し、RPC 実行後に
 *   「その行が消えたか / 残ったか」を id で確認する。Supabase では INSERT 時に created_at を
 *   指定できる (DEFAULT now() だが上書き可。meals / user_daily_meals に created_at を書き換える
 *   トリガーは無い)。
 *
 *   この RPC は全ユーザーの 90 日超 sandbox 行をまとめて消すため、戻り値の件数は他のテストが
 *   残した行も含みうる。件数は「1 以上」までしか言えないので、自分が入れた行の有無を主な判定にする。
 *
 *   本番スキーマの制約 (これを知らないと INSERT が失敗する):
 *   - meals に dish_name 列は無い (必須列は user_id / eaten_at / meal_type)。存在しない列を渡すと
 *     INSERT が失敗し、行が入らないままテストが空振りする (#857)
 *   - user_daily_meals の日付列は day_date (date ではない)。(user_id, day_date) が UNIQUE
 *   - is_sandbox=true の行は meals / user_daily_meals とも 1 ユーザーにつき 1 件まで
 *     (uniq_user_sandbox_meal / uniq_user_sandbox_daily_meal)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  adminClient,
  type TestUser,
} from '../helpers/supabase';

const AUDIT_ACTION_TYPE = 'handson_tour_sandbox_cleanup';

/** Returns an ISO timestamp N days ago */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** Returns a YYYY-MM-DD string N days ago (user_daily_meals.day_date 用) */
function dateOnlyDaysAgo(n: number): string {
  return daysAgo(n).split('T')[0];
}

interface CleanupResult {
  meals_deleted: number;
  daily_meals_deleted: number;
}

/**
 * meals に 1 行 INSERT して id を返す。
 * INSERT の失敗 (列名の誤りなど) を握りつぶすと「行が無いまま RPC を呼んで 0 件」になり
 * テストが空振りするため、失敗したらここで落とす。
 */
async function insertMeal(
  client: SupabaseClient,
  userId: string,
  opts: { isSandbox: boolean; createdAt: string },
): Promise<string> {
  const { data, error } = await client
    .from('meals')
    .insert({
      user_id: userId,
      eaten_at: opts.createdAt,
      meal_type: 'breakfast',
      is_sandbox: opts.isSandbox,
      created_at: opts.createdAt,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** user_daily_meals に 1 行 INSERT して id を返す (失敗したらその場で落とす) */
async function insertDailyMeal(
  client: SupabaseClient,
  userId: string,
  opts: { isSandbox: boolean; createdAt: string; dayDate: string },
): Promise<string> {
  const { data, error } = await client
    .from('user_daily_meals')
    .insert({
      user_id: userId,
      day_date: opts.dayDate,
      is_sandbox: opts.isSandbox,
      created_at: opts.createdAt,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return data!.id as string;
}

/** 指定 id の行が残っているか */
async function rowExists(
  client: SupabaseClient,
  table: 'meals' | 'user_daily_meals',
  id: string,
): Promise<boolean> {
  const { data, error } = await client.from(table).select('id').eq('id', id).maybeSingle();
  expect(error).toBeNull();
  return data !== null;
}

/** cleanup RPC を実行して戻り値を返す */
async function runCleanup(client: SupabaseClient): Promise<CleanupResult> {
  const { data, error } = await client.rpc('cleanup_handson_tour_sandbox_rows');
  expect(error).toBeNull();
  expect(data).toBeDefined();
  return data as CleanupResult;
}

describe.skipIf(!shouldRunIntegration())(
  'RPC cleanup_handson_tour_sandbox_rows() (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) {
        const client = adminClient();
        await client.from('meals').delete().eq('user_id', user.id);
        await client.from('user_daily_meals').delete().eq('user_id', user.id);
        await cleanupTestUser(user.id);
      }
    });

    it('1. 90日超 sandbox 行 (meals / user_daily_meals) を削除し、件数を戻り値と admin_audit_logs に記録する', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // Insert OLD sandbox rows (91 days ago) into both tables.
      // We bypass RLS via service_role and set created_at explicitly.
      const oldDate = daysAgo(91);
      const oldMealId = await insertMeal(client, user.id, { isSandbox: true, createdAt: oldDate });
      const oldDailyMealId = await insertDailyMeal(client, user.id, {
        isSandbox: true,
        createdAt: oldDate,
        dayDate: dateOnlyDaysAgo(91),
      });

      // Count audit logs before
      const { count: auditCountBefore } = await client
        .from('admin_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action_type', AUDIT_ACTION_TYPE);

      // Execute cleanup RPC
      const result = await runCleanup(client);

      // 戻り値の件数: 自分が入れた各 1 行ぶんは最低でも数えられている
      // (他のテストが残した 90 日超 sandbox 行も同時に消えるため「以上」で見る)
      expect(result.meals_deleted).toBeGreaterThanOrEqual(1);
      expect(result.daily_meals_deleted).toBeGreaterThanOrEqual(1);

      // 実際に自分の行が両テーブルから消えている (件数だけでなく行の有無で確認する)
      expect(await rowExists(client, 'meals', oldMealId)).toBe(false);
      expect(await rowExists(client, 'user_daily_meals', oldDailyMealId)).toBe(false);

      // Verify audit log was inserted
      const { count: auditCountAfter } = await client
        .from('admin_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action_type', AUDIT_ACTION_TYPE);

      expect(auditCountAfter!).toBeGreaterThan(auditCountBefore ?? 0);

      // 監査ログの details は、戻り値と同じ件数 (meals_deleted / daily_meals_deleted) を持つ
      const { data: latestLog } = await client
        .from('admin_audit_logs')
        .select('details')
        .eq('action_type', AUDIT_ACTION_TYPE)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      expect(latestLog?.details).toEqual({
        meals_deleted: result.meals_deleted,
        daily_meals_deleted: result.daily_meals_deleted,
      });
    });

    it('2. 90日以内 (89日前) の sandbox 行は削除されない', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // 境界の内側 (89 日前 = 90 日の期限まであと 1 日) の sandbox 行を両テーブルに入れる
      const recentDate = daysAgo(89);
      const recentMealId = await insertMeal(client, user.id, {
        isSandbox: true,
        createdAt: recentDate,
      });
      const recentDailyMealId = await insertDailyMeal(client, user.id, {
        isSandbox: true,
        createdAt: recentDate,
        dayDate: dateOnlyDaysAgo(89),
      });

      // Execute cleanup
      const result = await runCleanup(client);
      expect(typeof result.meals_deleted).toBe('number');
      expect(typeof result.daily_meals_deleted).toBe('number');

      // Verify the recent rows still exist
      expect(await rowExists(client, 'meals', recentMealId)).toBe(true);
      expect(await rowExists(client, 'user_daily_meals', recentDailyMealId)).toBe(true);
    });

    it('3. 90日超でも non-sandbox の行 (実ユーザーのデータ) は削除されない', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // 91 日前でも is_sandbox=false の行は対象外。WHERE 句の is_sandbox 条件が外れると
      // 実ユーザーの 90 日超の食事記録が全件消えるため、その回帰を防ぐ。
      const oldDate = daysAgo(91);
      const oldMealId = await insertMeal(client, user.id, { isSandbox: false, createdAt: oldDate });
      const oldDailyMealId = await insertDailyMeal(client, user.id, {
        isSandbox: false,
        createdAt: oldDate,
        dayDate: dateOnlyDaysAgo(91),
      });

      await runCleanup(client);

      expect(await rowExists(client, 'meals', oldMealId)).toBe(true);
      expect(await rowExists(client, 'user_daily_meals', oldDailyMealId)).toBe(true);
    });
  },
);
