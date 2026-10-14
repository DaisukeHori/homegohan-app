/**
 * #1165 ログインの連続失敗の回数 (src/lib/auth/login-failures.ts) の単体テスト
 *
 * ログインに続けて失敗しても、アカウントはロックしない (docs/operations/auth-protection.md §1)。
 * 回数は、ボットの確認を求めるかどうか (3 回以上) にだけ使う。
 *
 * 確かめること:
 *   - 決定表: 回数 → ボットの確認を求めるか (0〜25 回)。どの回数でも「ロック」に当たる状態を持たない
 *   - 回数が 0 に戻る: 成功 (記録を消す) と、最後の失敗から一定の時間 (既定 24 時間) が経ったとき。境目はちょうど補集合
 *   - 戻すまでの時間は環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES で上書きでき、不正な値は既定値に戻す
 *   - 記録の読み書きに失敗した・応答の形が違うときは LoginFailureStoreError (ログインは通さない側に倒す)
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_REQUIRED_FAILURE_COUNT,
  LOGIN_FAILURE_RESET_MINUTES,
  LOGIN_FAILURE_RESET_MINUTES_MAX,
  LOGIN_FAILURE_RESET_MINUTES_MIN,
  LoginFailureStoreError,
  clearLoginFailures,
  readLoginFailureState,
  recordLoginFailure,
  resolveLoginFailureResetMinutes,
} from '@/lib/auth/login-failures';
import * as loginFailures from '@/lib/auth/login-failures';
import { createFakeLoginFailureStore } from '../helpers/fake-login-failure-store';

const EMAIL = 'user@example.com';
const RESET = LOGIN_FAILURE_RESET_MINUTES;

describe('決定表 (回数 → ボットの確認)', () => {
  it('3 回以上でボットの確認を求める。戻すまでの時間の既定は 24 時間 (1440 分)、上書きは 1〜10080 分', () => {
    expect(CAPTCHA_REQUIRED_FAILURE_COUNT).toBe(3);
    expect(LOGIN_FAILURE_RESET_MINUTES).toBe(1440);
    expect(LOGIN_FAILURE_RESET_MINUTES_MIN).toBe(1);
    expect(LOGIN_FAILURE_RESET_MINUTES_MAX).toBe(10080);
  });

  // [回数, ボットの確認を求めるか]
  const TABLE: Array<[number, boolean]> = [
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [5, true],
    [9, true],
    [10, true],
    [19, true],
    [20, true],
    [25, true],
  ];

  it.each(TABLE)('%i 回: 確認 %s。状態は回数と確認の 2 つだけ (ロック・残り時間を持たない)', async (count, captchaRequired) => {
    const store = createFakeLoginFailureStore();
    if (count > 0) store.setFailures(EMAIL, count);
    const state = await readLoginFailureState(store.client, EMAIL, RESET);
    expect(state).toEqual({ failureCount: count, captchaRequired });
  });

  it('ロックの段・期限・通知を決める部品を公開していない (ロックの仕組みが戻ってきたら気づく)', () => {
    const exported = Object.keys(loginFailures);
    for (const name of exported) {
      expect(name, `${name} はロックの部品に見える`).not.toMatch(/lock|retryAfter|notice/i);
    }
  });
});

describe('readLoginFailureState', () => {
  it('記録が無ければ 0 回・確認なし。DB の関数へは戻すまでの時間 (分) を渡す', async () => {
    const store = createFakeLoginFailureStore();
    expect(await readLoginFailureState(store.client, EMAIL, RESET)).toEqual({ failureCount: 0, captchaRequired: false });
    expect(store.calls).toEqual([{ fn: 'auth_login_failure_count', args: { p_email: EMAIL, p_reset_after_minutes: RESET } }]);
  });

  it('最後の失敗から戻すまでの時間が経つと 0 回 (確認なし)。ちょうど経った時点で 0、1 分手前ではまだ数える', async () => {
    const store = createFakeLoginFailureStore();
    store.setFailures(EMAIL, 7, RESET - 1);
    expect(await readLoginFailureState(store.client, EMAIL, RESET)).toEqual({ failureCount: 7, captchaRequired: true });
    store.setFailures(EMAIL, 7, RESET);
    expect(await readLoginFailureState(store.client, EMAIL, RESET)).toEqual({ failureCount: 0, captchaRequired: false });
  });

  it('記録を読めない (RPC のエラー) ときは LoginFailureStoreError', async () => {
    const store = createFakeLoginFailureStore();
    store.failNext('auth_login_failure_count');
    await expect(readLoginFailureState(store.client, EMAIL, RESET)).rejects.toBeInstanceOf(LoginFailureStoreError);
  });

  it.each([
    ['文字列', 'x'],
    ['負の数', -1],
    ['小数', 1.5],
    ['null', null],
    ['行の配列 (古い関数の形)', [{ failure_count: 1, locked_until: null }]],
  ])('応答の形が違う (%s) ときも LoginFailureStoreError', async (_label, data) => {
    const client = { rpc: async () => ({ data, error: null }) };
    await expect(readLoginFailureState(client, EMAIL, RESET)).rejects.toBeInstanceOf(LoginFailureStoreError);
  });

  it('RPC が例外を投げたときも LoginFailureStoreError', async () => {
    const client = {
      rpc: async () => {
        throw new Error('fetch failed');
      },
    };
    await expect(readLoginFailureState(client, EMAIL, RESET)).rejects.toBeInstanceOf(LoginFailureStoreError);
  });
});

describe('recordLoginFailure', () => {
  it('1 回ずつ数え、3 回目から確認を求める。何回目でもロックに当たる状態は返さない (25 回まで)', async () => {
    const store = createFakeLoginFailureStore();
    for (let i = 1; i <= 25; i += 1) {
      const record = await recordLoginFailure(store.client, EMAIL, RESET);
      expect(record).toEqual({ failureCount: i, captchaRequired: i >= CAPTCHA_REQUIRED_FAILURE_COUNT });
    }
    expect(new Set(store.calls.map((c) => c.fn))).toEqual(new Set(['auth_login_count_failure']));
  });

  it('最後の失敗から戻すまでの時間が経っていれば 1 からやり直す (確認は求めない)', async () => {
    const store = createFakeLoginFailureStore();
    store.setFailures(EMAIL, 12, RESET);
    expect(await recordLoginFailure(store.client, EMAIL, RESET)).toEqual({ failureCount: 1, captchaRequired: false });
  });

  it('戻すまでの時間の手前なら数え続ける', async () => {
    const store = createFakeLoginFailureStore();
    store.setFailures(EMAIL, 12, RESET - 1);
    expect(await recordLoginFailure(store.client, EMAIL, RESET)).toEqual({ failureCount: 13, captchaRequired: true });
  });

  it('メールアドレスの大文字・前後の空白は同じアドレスとして数える', async () => {
    const store = createFakeLoginFailureStore();
    await recordLoginFailure(store.client, ' User@Example.com ', RESET);
    await recordLoginFailure(store.client, EMAIL, RESET);
    expect(store.row(EMAIL)?.failure_count).toBe(2);
  });

  it('数えられないときは LoginFailureStoreError', async () => {
    const store = createFakeLoginFailureStore();
    store.failNext('auth_login_count_failure');
    await expect(recordLoginFailure(store.client, EMAIL, RESET)).rejects.toBeInstanceOf(LoginFailureStoreError);
  });
});

describe('clearLoginFailures', () => {
  it('記録を消すと 0 回に戻る', async () => {
    const store = createFakeLoginFailureStore();
    store.setFailures(EMAIL, 12);
    await clearLoginFailures(store.client, EMAIL);
    expect(store.row(EMAIL)).toBeUndefined();
    expect(await readLoginFailureState(store.client, EMAIL, RESET)).toEqual({ failureCount: 0, captchaRequired: false });
  });

  it('消せないときは LoginFailureStoreError', async () => {
    const store = createFakeLoginFailureStore();
    store.failNext('auth_login_clear_failures');
    await expect(clearLoginFailures(store.client, EMAIL)).rejects.toBeInstanceOf(LoginFailureStoreError);
  });
});

describe('resolveLoginFailureResetMinutes (環境変数 AUTH_LOGIN_FAILURE_RESET_MINUTES)', () => {
  it.each([
    [undefined, 1440, false],
    ['', 1440, false],
    ['   ', 1440, false],
    ['60', 60, false],
    [' 90 ', 90, false],
    ['1', 1, false],
    ['10080', 10080, false],
    ['0', 1440, true],
    ['10081', 1440, true],
    ['-5', 1440, true],
    ['1.5', 1440, true],
    ['1e3', 1440, true],
    ['0x10', 1440, true],
    ['abc', 1440, true],
  ])('%j → %i 分 (無視: %s)', (raw, minutes, ignored) => {
    expect(resolveLoginFailureResetMinutes(raw)).toEqual({ minutes, ignored });
  });
});
