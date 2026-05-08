/**
 * Integration test: POST /api/handson-tour/complete
 *
 * Test patterns:
 *   1. 200 (新規) — 新規ユーザーが完了 → completed_at + badge_awarded
 *   2. 200 (already_completed=true, 冪等) — 2回目呼び出し
 *   3. 403 (admin) — admin ロールは対象外
 *   4. 409 (existing_user) — non-sandbox activity あり & 未完了
 *   5. 401 (unauth) — 認証なし
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

async function postComplete(accessToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/handson-tour/complete`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `sb-access-token=${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe.skipIf(!shouldRunIntegration())(
  'POST /api/handson-tour/complete (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 200 — 新規ユーザーが完了', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const { status, body } = await postComplete(user.accessToken);
      expect(status).toBe(200);
      expect(body.completed_at).toBeTruthy();
      expect(body.already_completed).toBe(false);
      expect(body.badge_awarded).toBeDefined();
      const badge = body.badge_awarded as Record<string, unknown>;
      expect(badge.code).toBe('tutorial_complete');
      expect(badge.obtained_at).toBeTruthy();
    });

    it('2. 200 (already_completed=true) — 冪等: 2回目呼び出し', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      // First call
      await postComplete(user.accessToken);
      // Second call — should be idempotent
      const { status, body } = await postComplete(user.accessToken);
      expect(status).toBe(200);
      expect(body.already_completed).toBe(true);
      expect(body.badge_awarded).toBeDefined();
    });

    it('3. 403 — admin ロールは not_eligible', async () => {
      user = await createTestUser({ onboardingCompleted: true, roles: ['admin'] });
      const { status, body } = await postComplete(user.accessToken);
      expect(status).toBe(403);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('not_eligible');
      expect(err.reason).toBe('admin_role');
    });

    it('4. 409 — existing_user (non-sandbox activity あり)', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      // Insert a non-sandbox meal
      const { error: mealError } = await client.from('meals').insert({
        user_id: user.id,
        eaten_at: new Date().toISOString().split('T')[0],
        meal_type: 'dinner',
        dish_name: 'テスト夕食',
        is_sandbox: false,
      });
      if (mealError) {
        console.warn('meal insert error:', mealError.message);
      }

      const { status, body } = await postComplete(user.accessToken);
      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('not_eligible');
      expect(err.reason).toBe('existing_user');

      // Cleanup
      await client.from('meals').delete().eq('user_id', user.id);
    });

    it('5. 401 — 認証なしリクエスト', async () => {
      const res = await fetch(`${BASE_URL}/api/handson-tour/complete`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  },
);
