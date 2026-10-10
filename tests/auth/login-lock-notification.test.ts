/**
 * #1165 ログイン失敗のロックの通知 (src/lib/auth/login-lock-notification.ts) の単体テスト
 *
 * | notice          | アカウント | ADMIN_NOTIFICATION_EMAIL | 送るメール                  | ログ         |
 * |-----------------|------------|--------------------------|-----------------------------|--------------|
 * | none            | -          | -                        | なし (宛先も引かない)       | なし         |
 * | account-owner   | あり       | -                        | 本人の登録アドレスへ 1 通   | なし         |
 * | account-owner   | なし       | -                        | なし (登録していない人へ送らない) | なし   |
 * | admin           | あり/なし  | あり                     | 運営へ 1 通 (伏せ字・user_id) | warn       |
 * | admin           | あり/なし  | なし                     | なし                        | warn         |
 * | (宛先を引けない)| -          | -                        | なし                        | error・例外は投げない |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLoginLockStore, type FakeLoginLockStore } from '../helpers/fake-login-lock-store';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/emails/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/send')>();
  return { ...actual, sendEmail: mocks.sendEmail };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
}));

import { sendLoginLockNotice } from '@/lib/auth/login-lock-notification';

const EMAIL = 'taro@example.com';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const LOCKED_UNTIL = new Date('2026-10-10T04:00:00.000Z');
let store: FakeLoginLockStore;

beforeEach(() => {
  vi.clearAllMocks();
  store = createFakeLoginLockStore();
  mocks.sendEmail.mockResolvedValue({ ok: true, id: 'email_1', attempts: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sendLoginLockNotice', () => {
  it('none なら何もしない (宛先も引かない)', async () => {
    await sendLoginLockNotice(store.client, { email: EMAIL, notice: 'none', failureCount: 5, lockedUntil: LOCKED_UNTIL });
    expect(store.calls).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('10 回目 (account-owner): アカウントがあれば、本人の登録アドレスへ 1 通 (回数・期限・再設定の案内)', async () => {
    store.accounts.set(EMAIL, USER_ID);
    await sendLoginLockNotice(store.client, { email: EMAIL, notice: 'account-owner', failureCount: 10, lockedUntil: LOCKED_UNTIL });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [envelope] = mocks.sendEmail.mock.calls[0];
    expect(envelope.to).toBe(EMAIL);
    expect(envelope.template).toBe('login_locked');
    expect(envelope.text).toContain('10 回続けて失敗');
    // 期限は日本時間で書く (UTC 04:00 = 日本時間 13:00)
    expect(envelope.text).toContain('2026年10月10日 13:00 (日本時間)');
    expect(envelope.text).toContain('/auth/forgot-password');
  });

  it('10 回目でも、アカウントが無いメールアドレスには送らない', async () => {
    await sendLoginLockNotice(store.client, { email: EMAIL, notice: 'account-owner', failureCount: 10, lockedUntil: LOCKED_UNTIL });
    expect(store.calls.map((c) => c.fn)).toEqual(['auth_login_account_user_id']);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('20 回目 (admin): ログに warn を残し、ADMIN_NOTIFICATION_EMAIL へ伏せ字と user_id で 1 通 (生のアドレスは書かない)', async () => {
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', 'ops@example.com');
    store.accounts.set(EMAIL, USER_ID);
    await sendLoginLockNotice(store.client, { email: EMAIL, notice: 'admin', failureCount: 20, lockedUntil: LOCKED_UNTIL });

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('24 時間ロック'),
      expect.objectContaining({ account_user_id: USER_ID, masked_email: 't***@example.com', failure_count: 20 }),
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(EMAIL);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [envelope] = mocks.sendEmail.mock.calls[0];
    expect(envelope.to).toBe('ops@example.com');
    expect(envelope.template).toBe('login_lock_admin');
    expect(envelope.text).toContain(USER_ID);
    expect(envelope.text).toContain('t***@example.com');
    expect(envelope.text).not.toContain(EMAIL);
  });

  it('20 回目で ADMIN_NOTIFICATION_EMAIL が無ければ、ログだけ', async () => {
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', '');
    await sendLoginLockNotice(store.client, { email: EMAIL, notice: 'admin', failureCount: 20, lockedUntil: LOCKED_UNTIL });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('24 時間ロック'),
      expect.objectContaining({ account_user_id: null }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('宛先を引けない・送信が例外を投げても、例外を外へ出さない (ログに残す)', async () => {
    store.failNext('auth_login_account_user_id');
    await expect(
      sendLoginLockNotice(store.client, { email: EMAIL, notice: 'account-owner', failureCount: 10, lockedUntil: LOCKED_UNTIL }),
    ).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    store.accounts.set(EMAIL, USER_ID);
    mocks.sendEmail.mockRejectedValueOnce(new Error('boom'));
    await expect(
      sendLoginLockNotice(store.client, { email: EMAIL, notice: 'account-owner', failureCount: 10, lockedUntil: LOCKED_UNTIL }),
    ).resolves.toBeUndefined();
    expect(mocks.logger.error).toHaveBeenCalledTimes(2);
  });
});
