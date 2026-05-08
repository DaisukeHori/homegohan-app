/**
 * Integration test: RPC complete_handson_tour(uuid)
 *
 * Test patterns:
 *   1. profile UPDATE + badge INSERT が atomic に実行される
 *   2. already_completed 判定 (2回目呼び出しで already_completed=true)
 *   3. profile_not_found — 存在しない UUID でエラー
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 * Note: service_role キー必須 (RPC は service_role のみ EXECUTE 権限)
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  adminClient,
  type TestUser,
} from '../helpers/supabase';

describe.skipIf(!shouldRunIntegration())(
  'RPC complete_handson_tour(uuid) (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. profile UPDATE + badge INSERT が atomic に実行される', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      const { data: rawData, error } = await client.rpc('complete_handson_tour', {
        p_user_id: user.id,
      });
      const data = rawData as Record<string, unknown>;

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.completed_at).toBeTruthy();
      expect(data.already_completed).toBe(false);
      expect(data.badge_awarded).toBeDefined();
      const badge = data.badge_awarded as Record<string, unknown>;
      expect(badge.code).toBe('tutorial_complete');
      expect(badge.obtained_at).toBeTruthy();

      // Verify profile was actually updated in DB
      const { data: profile } = await client
        .from('user_profiles')
        .select('handson_tour_completed_at')
        .eq('id', user.id)
        .single();
      expect(profile?.handson_tour_completed_at).toBeTruthy();

      // Verify badge row was inserted
      const { data: badgeRow } = await client
        .from('badges')
        .select('id')
        .eq('code', 'tutorial_complete')
        .single();
      expect(badgeRow).toBeDefined();

      const { data: userBadge } = await client
        .from('user_badges')
        .select('obtained_at')
        .eq('user_id', user.id)
        .eq('badge_id', badgeRow!.id)
        .single();
      expect(userBadge?.obtained_at).toBeTruthy();
    });

    it('2. already_completed 判定 — 2回目呼び出しで already_completed=true', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // First call
      await client.rpc('complete_handson_tour', { p_user_id: user.id });

      // Second call
      const { data: rawData2, error } = await client.rpc('complete_handson_tour', {
        p_user_id: user.id,
      });
      const data2 = rawData2 as Record<string, unknown>;
      expect(error).toBeNull();
      expect(data2.already_completed).toBe(true);

      // completed_at should be same as first call (idempotent)
      expect(data2.completed_at).toBeTruthy();
    });

    it('3. profile_not_found — 存在しない UUID でエラー', async () => {
      const client = adminClient();
      const fakeUuid = '00000000-0000-0000-0000-000000000001';

      const { data, error } = await client.rpc('complete_handson_tour', {
        p_user_id: fakeUuid,
      });

      expect(error).toBeDefined();
      expect(error!.message).toContain('profile_not_found');
    });
  },
);
