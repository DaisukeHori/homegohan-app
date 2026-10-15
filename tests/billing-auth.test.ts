// @vitest-environment node
/**
 * 凍結 (BAN) 中も通す課金の route の認証 requireUserAllowingFrozen (src/lib/billing/auth.ts) のテスト (billing/01 §14.1 のテスト 119)。
 * ログインのセッションだけを確かめ、凍結の列 (user_profiles.frozen_at) を読まないことを見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(() => {
    throw new Error('requireUserAllowingFrozen must not read any table (frozen_at)');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}));

import { requireUserAllowingFrozen } from '@/lib/billing/auth';
import { AuthError } from '@/lib/auth/errors';

const USER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireUserAllowingFrozen (billing/01 §9.8)', () => {
  it('requireUserAllowingFrozen returns the session user id and email without reading user_profiles, and throws AuthError AUTH_UNAUTHENTICATED when getUser returns no user or an error', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: { id: USER_ID, email: 'person@example.com' } }, error: null });
    expect(await requireUserAllowingFrozen()).toEqual({ id: USER_ID, email: 'person@example.com' });

    // メールが無い利用者は null
    mocks.getUser.mockResolvedValueOnce({ data: { user: { id: USER_ID } }, error: null });
    expect(await requireUserAllowingFrozen()).toEqual({ id: USER_ID, email: null });

    for (const result of [
      { data: { user: null }, error: null },
      { data: { user: null }, error: { message: 'jwt expired', status: 401 } },
      { data: { user: { id: USER_ID } }, error: { message: 'session missing', status: 400 } },
    ]) {
      mocks.getUser.mockResolvedValueOnce(result);
      const error = await requireUserAllowingFrozen().catch((caught: unknown) => caught);
      expect(error, JSON.stringify(result)).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_UNAUTHENTICATED');
    }
    // 凍結の列を読まない (偽の client の from は呼ばれたら失敗する)
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
