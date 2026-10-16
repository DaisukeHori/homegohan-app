/**
 * src/lib/auth/password/gotrue-user.ts の単体テスト (#1198。設計 docs/design/cross/16-auth-history-sessions.md §13.7・§20.1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOTRUE_API_VERSION,
  GOTRUE_API_VERSION_HEADER,
  GOTRUE_USER_PATH,
  updatePasswordWithAccessToken,
  type FetchLike,
} from '../password/gotrue-user';

const SUPABASE_URL = 'https://project.example.supabase.co';
const ANON_KEY = 'anon-key-for-test';
const ACCESS_TOKEN = 'access.token.jwt';
const NEW_PASSWORD = 'NewPassword-1';
const CURRENT_PASSWORD = 'CurrentPassword-1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('updatePasswordWithAccessToken', () => {
  it('PUT <SUPABASE_URL>/auth/v1/user に Bearer の access token・apikey・X-Supabase-Api-Version: 2024-01-01 を付ける', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { id: 'user' }));
    await updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(GOTRUE_USER_PATH).toBe('/auth/v1/user');
    expect(GOTRUE_API_VERSION).toBe('2024-01-01');
    expect(url).toBe(`${SUPABASE_URL}/auth/v1/user`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      apikey: ANON_KEY,
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      [GOTRUE_API_VERSION_HEADER]: '2024-01-01',
    });
    expect(GOTRUE_API_VERSION_HEADER).toBe('X-Supabase-Api-Version');
  });

  it('currentPassword が null なら本文は { password } だけ、文字列なら { password, current_password }', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl);
    await updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, CURRENT_PASSWORD, fetchImpl);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({ password: NEW_PASSWORD });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).toEqual({ password: NEW_PASSWORD, current_password: CURRENT_PASSWORD });
  });

  it('2xx なら error は null', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await expect(updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl)).resolves.toEqual({ error: null });
  });

  it('4xx の本文の code (文字列) と status を返す', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(422, { code: 'weak_password', message: 'Password should be stronger' }));
    await expect(updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl)).resolves.toEqual({
      error: { code: 'weak_password', status: 422 },
    });
  });

  it('code が数値で error_code が文字列の古い形は error_code を返す', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(422, { code: 422, error_code: 'same_password', msg: 'x' }));
    await expect(updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl)).resolves.toEqual({
      error: { code: 'same_password', status: 422 },
    });
  });

  it('本文が JSON でなければ code は null で status を返す', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl)).resolves.toEqual({
      error: { code: null, status: 502 },
    });
  });

  it('fetch の例外はそのまま投げる', async () => {
    const failure = new TypeError('fetch failed');
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw failure;
    });
    await expect(updatePasswordWithAccessToken(ACCESS_TOKEN, NEW_PASSWORD, null, fetchImpl)).rejects.toBe(failure);
  });
});
