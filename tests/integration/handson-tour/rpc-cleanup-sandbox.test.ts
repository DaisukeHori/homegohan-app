/**
 * Integration test: RPC cleanup_handson_tour_sandbox_rows()
 *
 * Test patterns:
 *   1. 90日超 sandbox 行を削除し admin_audit_logs に記録する
 *   2. 90日以内の sandbox 行は削除されない
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 * Note: service_role キー必須
 *
 * Implementation detail:
 *   テスト用に created_at を90日以上前に偽装した行を直接 INSERT し、
 *   RPC を実行後に削除されたことを確認する。
 *   Supabase では INSERT 時に created_at を指定できる (DEFAULT now() だが上書き可)。
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  adminClient,
  type TestUser,
} from '../helpers/supabase';

/** Returns an ISO timestamp N days ago */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
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

    it('1. 90日超 sandbox 行を削除し admin_audit_logs に件数を記録する', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // Count audit logs before
      const { count: auditCountBefore } = await client
        .from('admin_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action_type', 'handson_tour_sandbox_cleanup');

      // Insert an OLD sandbox meal (91 days ago)
      // We bypass RLS via service_role and set created_at explicitly
      const oldDate = daysAgo(91);
      const { data: insertedMeal, error: mealInsertError } = await client
        .from('meals')
        .insert({
          user_id: user.id,
          eaten_at: new Date().toISOString().split('T')[0],
          meal_type: 'breakfast',
          dish_name: '古いサンドボックス食事',
          is_sandbox: true,
          created_at: oldDate,
        })
        .select('id')
        .single();

      if (mealInsertError) {
        console.warn(
          'Cannot override created_at on insert (may require DB trigger bypass):',
          mealInsertError.message,
        );
        // Directly update created_at after insert as workaround
        const { data: inserted } = await client
          .from('meals')
          .insert({
            user_id: user.id,
            eaten_at: new Date().toISOString().split('T')[0],
            meal_type: 'breakfast',
            dish_name: '古いサンドボックス食事',
            is_sandbox: true,
          })
          .select('id')
          .single();

        if (inserted) {
          await client
            .from('meals')
            .update({ created_at: oldDate })
            .eq('id', inserted.id);
        }
      }

      // Execute cleanup RPC
      const { data: rawResult, error } = await client.rpc('cleanup_handson_tour_sandbox_rows');
      const result = rawResult as Record<string, unknown>;
      expect(error).toBeNull();
      expect(result).toBeDefined();
      // meals_deleted should be at least 1
      expect(result.meals_deleted as number).toBeGreaterThanOrEqual(1);
      // daily_meals_deleted should be a non-negative number
      expect(typeof result.daily_meals_deleted).toBe('number');
      expect(result.daily_meals_deleted as number).toBeGreaterThanOrEqual(0);

      // Verify audit log was inserted
      const { count: auditCountAfter } = await client
        .from('admin_audit_logs')
        .select('*', { count: 'exact', head: true })
        .eq('action_type', 'handson_tour_sandbox_cleanup');

      expect(auditCountAfter!).toBeGreaterThan(auditCountBefore ?? 0);

      // Verify the audit log details
      const { data: latestLog } = await client
        .from('admin_audit_logs')
        .select('details')
        .eq('action_type', 'handson_tour_sandbox_cleanup')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const logDetails = latestLog?.details as Record<string, unknown> | null;
      expect((logDetails?.meals_deleted as number) ?? 0).toBeGreaterThanOrEqual(1);
      expect(typeof logDetails?.daily_meals_deleted).toBe('number');
      expect((logDetails?.daily_meals_deleted as number) ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('2. 90日以内の sandbox 行は削除されない', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // Insert a RECENT sandbox meal (1 day ago — well within 90 days)
      await client.from('meals').insert({
        user_id: user.id,
        eaten_at: new Date().toISOString().split('T')[0],
        meal_type: 'lunch',
        dish_name: '新しいサンドボックス食事',
        is_sandbox: true,
      });

      // Execute cleanup
      const { data: rawResult2 } = await client.rpc('cleanup_handson_tour_sandbox_rows');
      const result2 = rawResult2 as Record<string, unknown>;

      // meals_deleted and daily_meals_deleted should both be 0 for this user's recent rows
      expect(typeof result2.meals_deleted).toBe('number');
      expect(typeof result2.daily_meals_deleted).toBe('number');

      // Verify the recent row still exists
      const { data: remaining } = await client
        .from('meals')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_sandbox', true);

      expect(remaining).toHaveLength(1);
    });
  },
);
