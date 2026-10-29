/**
 * #2086 V3: getUser の結果を「ログインしている / していない / 確かめられなかった」に分ける (src/lib/auth/signed-in-user.ts)。
 * getUser は通信の失敗を投げずに { user: null, error } で返し、ログインしていないときも AuthSessionMissingError を返す。
 */
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { classifyGetUserResult, readSignedInUser, type AuthUserReader } from '@/lib/auth/signed-in-user';

const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' } as User;

describe('classifyGetUserResult', () => {
  it('user があり error が無ければ signed-in', () => {
    expect(classifyGetUserResult(USER, null)).toEqual({ kind: 'signed-in', user: USER });
    expect(classifyGetUserResult(USER, undefined)).toEqual({ kind: 'signed-in', user: USER });
  });

  it('user も error も無ければ signed-out', () => {
    expect(classifyGetUserResult(null, null)).toEqual({ kind: 'signed-out' });
    expect(classifyGetUserResult(null, undefined)).toEqual({ kind: 'signed-out' });
  });

  it.each([
    ['AuthSessionMissingError', { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' }],
    ['401', { name: 'AuthApiError', status: 401, message: 'invalid claim: missing sub claim' }],
    ['session_not_found', { name: 'AuthApiError', status: 403, code: 'session_not_found', message: 'Session not found' }],
    ['bad_jwt', { name: 'AuthApiError', status: 403, code: 'bad_jwt', message: 'invalid JWT' }],
  ])('ログインが切れていることを示す error (%s) は signed-out (ログインの画面へ移してよい)', (_label, error) => {
    expect(classifyGetUserResult(null, error)).toEqual({ kind: 'signed-out' });
  });

  it.each([
    ['AuthRetryableFetchError (オフライン)', { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }],
    ['5xx', { name: 'AuthRetryableFetchError', status: 503, message: 'Service Unavailable' }],
    ['不明な error', { name: 'AuthUnknownError', message: 'Unexpected token <' }],
  ])('通信の失敗・サーバーの障害 (%s) は load-failed (ログインの画面へ移さない)', (_label, error) => {
    expect(classifyGetUserResult(null, error)).toEqual({ kind: 'load-failed' });
  });
});

describe('readSignedInUser', () => {
  function clientReturning(getUser: AuthUserReader['auth']['getUser']): AuthUserReader {
    return { auth: { getUser } };
  }

  it('getUser の結果を分ける', async () => {
    await expect(
      readSignedInUser(clientReturning(async () => ({ data: { user: USER }, error: null }))),
    ).resolves.toEqual({ kind: 'signed-in', user: USER });
    await expect(
      readSignedInUser(
        clientReturning(async () => ({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } })),
      ),
    ).resolves.toEqual({ kind: 'load-failed' });
  });

  it('getUser が投げたら load-failed (例外を外へ出さない)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      readSignedInUser(clientReturning(async () => Promise.reject(new TypeError('Failed to fetch')))),
    ).resolves.toEqual({ kind: 'load-failed' });
    spy.mockRestore();
  });
});
