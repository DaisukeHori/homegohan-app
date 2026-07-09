/**
 * Integration test: POST /api/menu-plans/add
 *
 * #1025: weekly_menus の実スキーマ (content/request_id/start_date/user_id NOT NULL) と
 * 不一致な payload (week_start_date/menu_data/status/generation_id/is_sandbox という
 * 存在しない列) を INSERT していたため常時 500 だった回帰防止テスト。
 *
 * #1025 round-2: eligibility クエリが user_profiles.user_id (存在しない列) を引いていたため
 * fail-open で admin_role / already_finished ゲートが無条件素通りしていた。fail-closed 化した
 * ことで初めて拒否パス (403/409) が実効化するので、その分岐も併せて固定する。
 *
 * Test patterns:
 *   1. 200 — sandbox 適格ユーザーが献立追加 → weekly_menus に実データが INSERT され、
 *            weekly_menu_requests は 'completed'、planner バッジが実際に付与される
 *   2. 401 — 認証なし
 *   3. 403 — admin ロールは sandbox_not_eligible (admin_role) で拒否される (round-2 固定)
 *   4. 409 — ツアー完了済みユーザーは sandbox_not_eligible (already_finished) で拒否される (round-2 固定)
 *   5. 409 — 既存 (non-sandbox) activity があるユーザーは sandbox_not_eligible (existing_user) で拒否される (round-2 固定)
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MOCK_MENU_RESPONSE } from '@homegohan/handson-tour-shared';
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

async function postMenuAdd(
  accessToken: string,
  body: Record<string, unknown>,
  source = 'handson_tour',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/menu-plans/add?source=${source}`, {
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

describe.skipIf(!shouldRunIntegration())(
  'POST /api/menu-plans/add (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 200 — sandbox 献立追加で weekly_menus に実データが INSERT され、request completed・badge 付与される (#1025)', async () => {
      // 非 admin・ツアー未完了・既存 activity なし = sandbox 適格な fixture であること
      // (round-2 で eligibility が実効化されたため、この前提が崩れると happy path が壊れる)
      user = await createTestUser({ onboardingCompleted: true });

      const { status, body } = await postMenuAdd(user.accessToken, {
        ...MOCK_MENU_RESPONSE,
        sandbox: true,
        source: 'handson_tour',
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.menu_id).toBeTruthy();

      const client = adminClient();
      const { data: row, error } = await client
        .from('weekly_menus')
        .select('id, user_id, request_id, start_date, content')
        .eq('id', body.menu_id as string)
        .single();

      expect(error).toBeNull();
      expect(row?.user_id).toBe(user.id);
      expect(row?.request_id).toBeTruthy();
      expect(row?.start_date).toBeTruthy();
      expect((row?.content as Record<string, unknown> | null)?.dish_name).toBe(
        MOCK_MENU_RESPONSE.dish_name,
      );

      // weekly_menu_requests は孤児 'pending' のまま残らず 'completed' に確定していること (round-2)
      const { data: requestRow } = await client
        .from('weekly_menu_requests')
        .select('status')
        .eq('id', row!.request_id as string)
        .single();
      expect(requestRow?.status).toBe('completed');

      // planner バッジが実際に付与されていること (round-2: service_role 経由で 42501 を回避)
      const badge = body.badge_awarded as Record<string, unknown> | null;
      expect(badge).not.toBeNull();
      expect(badge?.code).toBe('planner');

      const { data: userBadge } = await client
        .from('user_badges')
        .select('user_id, badge_id')
        .eq('user_id', user.id)
        .single();
      expect(userBadge?.user_id).toBe(user.id);
    });

    it('2. 401 — 認証なしリクエスト', async () => {
      const res = await fetch(`${BASE_URL}/api/menu-plans/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...MOCK_MENU_RESPONSE, sandbox: true }),
      });
      expect(res.status).toBe(401);
    });

    it('3. 403 — admin ロールは sandbox_not_eligible/admin_role で拒否される (round-2)', async () => {
      user = await createTestUser({ onboardingCompleted: true, roles: ['admin'] });

      const { status, body } = await postMenuAdd(user.accessToken, {
        ...MOCK_MENU_RESPONSE,
        sandbox: true,
        source: 'handson_tour',
      });

      expect(status).toBe(403);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('admin_role');
    });

    it('4. 409 — ツアー完了済みユーザーは sandbox_not_eligible/already_finished で拒否される (round-2)', async () => {
      user = await createTestUser({
        onboardingCompleted: true,
        handsonTourCompletedAt: new Date().toISOString(),
      });

      const { status, body } = await postMenuAdd(user.accessToken, {
        ...MOCK_MENU_RESPONSE,
        sandbox: true,
        source: 'handson_tour',
      });

      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('already_finished');
    });

    it('5. 409 — 既存 (non-sandbox) activity があるユーザーは sandbox_not_eligible/existing_user で拒否される (round-2)', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const client = adminClient();

      await client.from('meals').insert({
        user_id: user.id,
        eaten_at: new Date().toISOString().split('T')[0],
        meal_type: 'dinner',
        dish_name: 'テスト夕食',
        is_sandbox: false,
      });

      const { status, body } = await postMenuAdd(user.accessToken, {
        ...MOCK_MENU_RESPONSE,
        sandbox: true,
        source: 'handson_tour',
      });

      expect(status).toBe(409);
      const err = body.error as Record<string, unknown>;
      expect(err.code).toBe('sandbox_not_eligible');
      expect(err.reason).toBe('existing_user');

      await client.from('meals').delete().eq('user_id', user.id);
    });
  },
);
