/**
 * #1165 ログイン失敗のロック (src/lib/auth/login-lock.ts) の単体テスト
 *
 * 設計 docs/design/cross/01-auth-session.md §8 の表:
 *   3 回 → ボットの確認 / 5 回 → 15 分ロック / 10 回 → 1 時間ロック + 本人へメール / 20 回 → 24 時間ロック + 運営へ通知
 *
 * 確かめること:
 *   - 回数ごとの段・通知の決定表 (0〜25 回)。通知は段にちょうど届いた 1 回だけ
 *   - 失敗の記録: 段に届いていなければ期限を書かない。届いたら「いま + 段の長さ」を書く。今の期限より短くはしない
 *   - 状況の読み取り: 期限が未来ならロック中、過ぎていればロックなし。残り秒数は切り上げ
 *   - 記録の読み書きに失敗した・応答の形が違うときは LoginLockStoreError (ログインは通さない側に倒す)
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_REQUIRED_FAILURE_COUNT,
  LOGIN_LOCK_TIERS,
  LoginLockStoreError,
  clearLoginFailures,
  findAccountUserId,
  lockTierFor,
  noticeFor,
  readLoginLockState,
  recordLoginFailure,
  retryAfterSeconds,
} from '@/lib/auth/login-lock';
import { createFakeLoginLockStore } from '../helpers/fake-login-lock-store';

const MINUTE_SEC = 60;
const HOUR_SEC = 60 * MINUTE_SEC;
const DAY_SEC = 24 * HOUR_SEC;
const NOW = new Date('2026-10-10T03:00:00.000Z');
const EMAIL = 'user@example.com';

const plusSec = (sec: number) => new Date(NOW.getTime() + sec * 1000).toISOString();

describe('設計 §8 の表 (決定表)', () => {
  it('表の値が設計どおり: 3 回でボットの確認、5 / 10 / 20 回で 15 分 / 1 時間 / 24 時間', () => {
    expect(CAPTCHA_REQUIRED_FAILURE_COUNT).toBe(3);
    expect(LOGIN_LOCK_TIERS).toEqual([
      { failures: 5, lockSeconds: 15 * MINUTE_SEC, notice: 'none' },
      { failures: 10, lockSeconds: HOUR_SEC, notice: 'account-owner' },
      { failures: 20, lockSeconds: DAY_SEC, notice: 'admin' },
    ]);
  });

  // [回数, ロックの長さ (秒、null はロックなし), 通知]
  const TABLE: Array<[number, number | null, 'none' | 'account-owner' | 'admin']> = [
    [0, null, 'none'],
    [1, null, 'none'],
    [2, null, 'none'],
    [3, null, 'none'],
    [4, null, 'none'],
    [5, 15 * MINUTE_SEC, 'none'],
    [6, 15 * MINUTE_SEC, 'none'],
    [9, 15 * MINUTE_SEC, 'none'],
    [10, HOUR_SEC, 'account-owner'],
    [11, HOUR_SEC, 'none'],
    [19, HOUR_SEC, 'none'],
    [20, DAY_SEC, 'admin'],
    [21, DAY_SEC, 'none'],
    [25, DAY_SEC, 'none'],
  ];

  it.each(TABLE)('%i 回: ロック %s 秒・通知 %s', (count, lockSeconds, notice) => {
    expect(lockTierFor(count)?.lockSeconds ?? null).toBe(lockSeconds);
    expect(noticeFor(count)).toBe(notice);
  });
});

describe('retryAfterSeconds', () => {
  it('期限が無い・過ぎていれば 0、未来なら秒数を切り上げる (最低 1 秒)', () => {
    expect(retryAfterSeconds(null, NOW)).toBe(0);
    expect(retryAfterSeconds(new Date(NOW.getTime() - 1), NOW)).toBe(0);
    expect(retryAfterSeconds(NOW, NOW)).toBe(0);
    expect(retryAfterSeconds(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(retryAfterSeconds(new Date(NOW.getTime() + 1500), NOW)).toBe(2);
    expect(retryAfterSeconds(new Date(NOW.getTime() + 900_000), NOW)).toBe(900);
  });
});

describe('readLoginLockState', () => {
  it('記録が無ければ 0 回・ロックなし・確認なし', async () => {
    const store = createFakeLoginLockStore();
    expect(await readLoginLockState(store.client, EMAIL, NOW)).toEqual({
      failureCount: 0,
      lockedUntil: null,
      locked: false,
      retryAfterSec: 0,
      captchaRequired: false,
    });
    expect(store.calls).toEqual([{ fn: 'auth_login_lock_status', args: { p_email: EMAIL } }]);
  });

  it('期限が未来ならロック中で残り秒数を返す。3 回以上なら確認を求める', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 5, locked_until: plusSec(600) });
    const state = await readLoginLockState(store.client, EMAIL, NOW);
    expect(state.locked).toBe(true);
    expect(state.retryAfterSec).toBe(600);
    expect(state.captchaRequired).toBe(true);
    expect(state.failureCount).toBe(5);
  });

  it('期限が過ぎていればロックなし (回数は残る)', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 7, locked_until: plusSec(-1) });
    const state = await readLoginLockState(store.client, EMAIL, NOW);
    expect(state.locked).toBe(false);
    expect(state.retryAfterSec).toBe(0);
    expect(state.failureCount).toBe(7);
    expect(state.captchaRequired).toBe(true);
  });

  it('2 回までは確認を求めず、3 回目から求める', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 2, locked_until: null });
    expect((await readLoginLockState(store.client, EMAIL, NOW)).captchaRequired).toBe(false);
    store.rows.set(EMAIL, { failure_count: 3, locked_until: null });
    expect((await readLoginLockState(store.client, EMAIL, NOW)).captchaRequired).toBe(true);
  });

  it('記録を読めない (RPC のエラー) ときは LoginLockStoreError', async () => {
    const store = createFakeLoginLockStore();
    store.failNext('auth_login_lock_status');
    await expect(readLoginLockState(store.client, EMAIL, NOW)).rejects.toBeInstanceOf(LoginLockStoreError);
  });

  it('応答の形が違う (関数の定義が変わった) ときも LoginLockStoreError', async () => {
    const client = { rpc: async () => ({ data: [{ failure_count: 'x', locked_until: null }], error: null }) };
    await expect(readLoginLockState(client, EMAIL, NOW)).rejects.toBeInstanceOf(LoginLockStoreError);
  });

  it('RPC が例外を投げたときも LoginLockStoreError', async () => {
    const client = {
      rpc: async () => {
        throw new Error('fetch failed');
      },
    };
    await expect(readLoginLockState(client, EMAIL, NOW)).rejects.toBeInstanceOf(LoginLockStoreError);
  });
});

describe('recordLoginFailure', () => {
  it('1〜4 回目は期限を書かない (auth_login_apply_lock を呼ばない)', async () => {
    const store = createFakeLoginLockStore();
    for (let i = 1; i <= 4; i += 1) {
      const record = await recordLoginFailure(store.client, EMAIL, NOW);
      expect(record.failureCount).toBe(i);
      expect(record.locked).toBe(false);
      expect(record.notice).toBe('none');
      expect(record.captchaRequired).toBe(i >= 3);
    }
    expect(store.calls.filter((c) => c.fn === 'auth_login_apply_lock')).toHaveLength(0);
    expect(store.row(EMAIL)?.locked_until).toBeNull();
  });

  it('5 回目で 15 分ロック (いま + 900 秒)。通知はしない', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 4, locked_until: null });
    const record = await recordLoginFailure(store.client, EMAIL, NOW);
    expect(record.failureCount).toBe(5);
    expect(record.locked).toBe(true);
    expect(record.retryAfterSec).toBe(15 * MINUTE_SEC);
    expect(record.notice).toBe('none');
    expect(store.calls.at(-1)).toEqual({
      fn: 'auth_login_apply_lock',
      args: { p_email: EMAIL, p_locked_until: plusSec(15 * MINUTE_SEC) },
    });
    expect(store.row(EMAIL)?.locked_until).toBe(plusSec(15 * MINUTE_SEC));
  });

  it('10 回目で 1 時間ロック + 本人へ通知、20 回目で 24 時間ロック + 運営へ通知', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 9, locked_until: plusSec(-10) });
    const tenth = await recordLoginFailure(store.client, EMAIL, NOW);
    expect(tenth.failureCount).toBe(10);
    expect(tenth.retryAfterSec).toBe(HOUR_SEC);
    expect(tenth.notice).toBe('account-owner');
    expect(tenth.lockedUntil?.toISOString()).toBe(plusSec(HOUR_SEC));

    store.rows.set(EMAIL, { failure_count: 19, locked_until: plusSec(-10) });
    const twentieth = await recordLoginFailure(store.client, EMAIL, NOW);
    expect(twentieth.failureCount).toBe(20);
    expect(twentieth.retryAfterSec).toBe(DAY_SEC);
    expect(twentieth.notice).toBe('admin');

    const after = await recordLoginFailure(store.client, EMAIL, NOW);
    expect(after.failureCount).toBe(21);
    expect(after.notice).toBe('none');
    expect(after.retryAfterSec).toBe(DAY_SEC);
  });

  it('今の期限より短くはしない (24 時間ロックの残りがある間に 15 分の段の失敗が来ても縮めない)', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 5, locked_until: plusSec(DAY_SEC) });
    const record = await recordLoginFailure(store.client, EMAIL, NOW);
    expect(record.retryAfterSec).toBe(DAY_SEC);
    expect(store.row(EMAIL)?.locked_until).toBe(plusSec(DAY_SEC));
  });

  it('メールアドレスの大文字・前後の空白は同じアドレスとして数える', async () => {
    const store = createFakeLoginLockStore();
    await recordLoginFailure(store.client, ' User@Example.com ', NOW);
    await recordLoginFailure(store.client, EMAIL, NOW);
    expect(store.row(EMAIL)?.failure_count).toBe(2);
  });

  it('期限を書けないときは LoginLockStoreError', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 4, locked_until: null });
    store.failNext('auth_login_apply_lock');
    await expect(recordLoginFailure(store.client, EMAIL, NOW)).rejects.toBeInstanceOf(LoginLockStoreError);
  });
});

describe('clearLoginFailures / findAccountUserId', () => {
  it('記録を消すと 0 回に戻る', async () => {
    const store = createFakeLoginLockStore();
    store.rows.set(EMAIL, { failure_count: 12, locked_until: plusSec(HOUR_SEC) });
    await clearLoginFailures(store.client, EMAIL);
    expect(store.row(EMAIL)).toBeUndefined();
    expect((await readLoginLockState(store.client, EMAIL, NOW)).locked).toBe(false);
  });

  it('アカウントがあれば user_id、無ければ null。形が違えば LoginLockStoreError', async () => {
    const store = createFakeLoginLockStore();
    store.accounts.set(EMAIL, '00000000-0000-4000-8000-000000000001');
    expect(await findAccountUserId(store.client, EMAIL)).toBe('00000000-0000-4000-8000-000000000001');
    expect(await findAccountUserId(store.client, 'nobody@example.com')).toBeNull();
    const broken = { rpc: async () => ({ data: 42, error: null }) };
    await expect(findAccountUserId(broken, EMAIL)).rejects.toBeInstanceOf(LoginLockStoreError);
  });
});
