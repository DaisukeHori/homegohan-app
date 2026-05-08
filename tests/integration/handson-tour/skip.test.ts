/**
 * Integration test: POST /api/handson-tour/skip
 *
 * Test patterns:
 *   1. 200 — 正常スキップ
 *   2. 401 — 認証なし
 *   3. 400 (validation_error) — 不正なリクエストボディ
 *
 * Requires: SUPABASE_INTEGRATION_TEST=1
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  shouldRunIntegration,
  createTestUser,
  cleanupTestUser,
  type TestUser,
} from '../helpers/supabase';

const BASE_URL =
  process.env.API_BASE_URL ??
  process.env.PLAYWRIGHT_BASE_URL ??
  'http://localhost:3000';

async function postSkip(
  accessToken: string,
  body: unknown = { step: 1, reason: 'user_action' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/api/handson-tour/skip`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `sb-access-token=${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe.skipIf(!shouldRunIntegration())(
  'POST /api/handson-tour/skip (integration)',
  () => {
    let user: TestUser;

    afterEach(async () => {
      if (user) await cleanupTestUser(user.id);
    });

    it('1. 200 — 正常スキップ', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const { status, body } = await postSkip(user.accessToken);
      expect(status).toBe(200);
      expect(body.skipped_at).toBeTruthy();
      // should be a valid ISO datetime
      const skippedAt = body.skipped_at as string;
      expect(() => new Date(skippedAt)).not.toThrow();
      expect(new Date(skippedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    });

    it('2. 401 — 認証なし', async () => {
      const res = await fetch(`${BASE_URL}/api/handson-tour/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 0, reason: 'user_action' }),
      });
      expect(res.status).toBe(401);
    });

    it('3. 400 (validation_error) — step が範囲外', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const { status, body } = await postSkip(user.accessToken, {
        step: 99,
        reason: 'user_action',
      });
      expect(status).toBe(400);
      expect((body.error as Record<string, unknown>).code).toBe('validation_error');
    });

    it('3b. 400 (validation_error) — reason が不正値', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const { status, body } = await postSkip(user.accessToken, {
        step: 0,
        reason: 'invalid_reason',
      });
      expect(status).toBe(400);
      expect((body.error as Record<string, unknown>).code).toBe('validation_error');
    });

    it('3c. 400 (validation_error) — 空ボディ', async () => {
      user = await createTestUser({ onboardingCompleted: true });
      const res = await fetch(`${BASE_URL}/api/handson-tour/skip`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Cookie: `sb-access-token=${user.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const data = await res.json() as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect((data.error as Record<string, unknown>).code).toBe('validation_error');
    });
  },
);
