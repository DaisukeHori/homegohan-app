/**
 * Integration test: POST /api/menu-plans/add
 *
 * #1025: weekly_menus の実スキーマ (content/request_id/start_date/user_id NOT NULL) と
 * 不一致な payload (week_start_date/menu_data/status/generation_id/is_sandbox という
 * 存在しない列) を INSERT していたため常時 500 だった回帰防止テスト。
 *
 * Test patterns:
 *   1. 200 — sandbox 適格ユーザーが献立追加 → weekly_menus に実データが INSERT される
 *   2. 401 — 認証なし
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

    it('1. 200 — sandbox 献立追加で weekly_menus に実データが INSERT される (#1025)', async () => {
      user = await createTestUser({ onboardingCompleted: true });

      const { status, body } = await postMenuAdd(user.accessToken, {
        ...MOCK_MENU_RESPONSE,
        sandbox: true,
        source: 'handson_tour',
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.menuId).toBeTruthy();

      const client = adminClient();
      const { data: row, error } = await client
        .from('weekly_menus')
        .select('id, user_id, request_id, start_date, content')
        .eq('id', body.menuId as string)
        .single();

      expect(error).toBeNull();
      expect(row?.user_id).toBe(user.id);
      expect(row?.request_id).toBeTruthy();
      expect(row?.start_date).toBeTruthy();
      expect((row?.content as Record<string, unknown> | null)?.dish_name).toBe(
        MOCK_MENU_RESPONSE.dish_name,
      );
    });

    it('2. 401 — 認証なしリクエスト', async () => {
      const res = await fetch(`${BASE_URL}/api/menu-plans/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...MOCK_MENU_RESPONSE, sandbox: true }),
      });
      expect(res.status).toBe(401);
    });
  },
);
