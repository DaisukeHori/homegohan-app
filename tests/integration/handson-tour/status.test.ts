/**
 * Integration test: GET /api/handson-tour/status
 *
 * Tests 6 status patterns:
 *   1. 新規 (eligible) — onboarding 完了 & sandbox activity のみ
 *   2. 完了済み (already_completed)
 *   3. スキップ済み (already_skipped)
 *   4. admin ロール (admin_role)
 *   5. 既存活動ユーザー (existing_user_auto_skip) — non-sandbox meal あり
 *   6. onboarding 未完 (onboarding_not_completed)
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_BASE_URL
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

async function getStatus(accessToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/handson-tour/status`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `sb-access-token=${accessToken}`,
    },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe.skipIf(!shouldRunIntegration())(
  'GET /api/handson-tour/status (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 新規ユーザー (eligible) — should_show=true, reason=eligible', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(true);
      expect(body.reason).toBe('eligible');
      expect(body.completed_at).toBeNull();
      expect(body.skipped_at).toBeNull();
    });

    it('2. 完了済みユーザー (already_completed) — should_show=false', async () => {
      const completedAt = new Date().toISOString();
      user = await createTestUser({
        onboardingCompleted: true,
        handsonTourCompletedAt: completedAt,
      });
      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(false);
      expect(body.reason).toBe('already_completed');
      expect(body.completed_at).toBeTruthy();
    });

    it('3. スキップ済みユーザー (already_skipped) — should_show=false', async () => {
      const skippedAt = new Date().toISOString();
      user = await createTestUser({
        onboardingCompleted: true,
        handsonTourSkippedAt: skippedAt,
      });
      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(false);
      expect(body.reason).toBe('already_skipped');
      expect(body.skipped_at).toBeTruthy();
    });

    it('4. admin ロールユーザー — reason=admin_role, should_show=false', async () => {
      user = await createTestUser({
        onboardingCompleted: true,
        roles: ['admin'],
      });
      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(false);
      expect(body.reason).toBe('admin_role');
    });

    it('5. 既存活動ユーザー (existing_user_auto_skip) — non-sandbox meal あり', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // Insert a non-sandbox meal for this user
      const { error: mealError } = await client.from('meals').insert({
        user_id: user.id,
        eaten_at: new Date().toISOString().split('T')[0],
        meal_type: 'lunch',
        dish_name: 'テスト食事',
        is_sandbox: false,
      });
      if (mealError) {
        console.warn('meal insert error (may be missing columns):', mealError.message);
      }

      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(false);
      expect(body.reason).toBe('existing_user_auto_skip');
      expect(body.skipped_at).toBeTruthy();

      // Cleanup meal
      await client.from('meals').delete().eq('user_id', user.id);
    });

    it('6. onboarding 未完ユーザー — reason=onboarding_not_completed', async () => {
      user = await createTestUser({ onboardingCompleted: false });
      const { status, body } = await getStatus(user.accessToken);
      expect(status).toBe(200);
      expect(body.should_show).toBe(false);
      expect(body.reason).toBe('onboarding_not_completed');
    });

    it('401 — 認証なしリクエスト', async () => {
      const res = await fetch(`${BASE_URL}/api/handson-tour/status`);
      expect(res.status).toBe(401);
    });
  },
);
