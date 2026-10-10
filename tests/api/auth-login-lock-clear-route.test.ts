/**
 * #1165 POST /api/auth/login-lock/clear (src/app/api/auth/login-lock/clear/route.ts) の route テスト
 *
 * 設計 §8「ロック中は正しいパスワードでも拒否。メール経由のリセットのみ解除可能」:
 *
 * | セッション                                   | 応答 | 記録                       |
 * |----------------------------------------------|------|----------------------------|
 * | 無い                                         | 401  | 触らない                   |
 * | ふつうのログイン (amr に recovery が無い)    | 403  | 触らない                   |
 * | 再設定のメールのリンク (amr に recovery)     | 200  | 登録アドレスの記録を消す   |
 * | 再設定のセッションだが記録を消せない         | 500  | (失敗)                     |
 *
 * amr は { method } の配列 (Supabase Auth の現行の形) と、文字列の配列の両方を受け付ける。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLoginLockStore, type FakeLoginLockStore } from '../helpers/fake-login-lock-store';

const mocks = vi.hoisted(() => ({
  getClaims: vi.fn(),
  getUser: vi.fn(),
  adminRpc: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getClaims: mocks.getClaims, getUser: mocks.getUser } }),
  getSupabaseAdmin: () => ({ rpc: mocks.adminRpc }),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/auth/login-lock/clear/route';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const EMAIL = 'user@example.com';
let store: FakeLoginLockStore;

function session(amr: unknown) {
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, amr } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'User@Example.com' } }, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = createFakeLoginLockStore();
  store.rows.set(EMAIL, { failure_count: 12, locked_until: new Date(Date.now() + 3_600_000).toISOString() });
  mocks.adminRpc.mockImplementation((fn: string, args: Record<string, unknown>) => store.client.rpc(fn, args));
});

describe('POST /api/auth/login-lock/clear', () => {
  it('セッションが無ければ 401 で、記録に触れない', async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: null });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(store.row(EMAIL)?.failure_count).toBe(12);
  });

  it('ふつうのログインのセッション (password) では 403 で、外さない', async () => {
    session([{ method: 'password', timestamp: 1 }]);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(store.row(EMAIL)?.failure_count).toBe(12);
  });

  it.each([
    ['{ method } の配列', [{ method: 'recovery', timestamp: 1 }]],
    ['文字列の配列', ['recovery']],
  ])('再設定のメールのリンクのセッション (%s) なら、登録アドレスの記録を消して 200', async (_label, amr) => {
    session(amr);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(store.calls).toEqual([{ fn: 'auth_login_clear_failures', args: { p_email: EMAIL } }]);
    expect(store.row(EMAIL)).toBeUndefined();
  });

  it('記録を消せなければ 500 (本文は汎用の文言)', async () => {
    session([{ method: 'recovery', timestamp: 1 }]);
    store.failNext('auth_login_clear_failures');
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('INTERNAL_ERROR');
  });

  it('登録アドレスを引けなければ 401', async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: USER_ID, amr: ['recovery'] } }, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'User not found' } });
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
});
