/**
 * T02: /auth/native-bridge route 単体テスト
 * Issue #844 — RN↔Web 認証ブリッジテスト
 *
 * カバレッジ:
 *   1. access_token / refresh_token 不在 → /login redirect
 *   2. cross-origin next パラメータ ブロック
 *   3. is_native_app Cookie セット確認
 *   4. setSession エラー時の fallback 動作
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── supabase/server モック ────────────────────────────────────────────────────
const mockSetSession = vi.fn();

const supabaseClient = {
  auth: {
    setSession: mockSetSession,
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => supabaseClient,
}));

// ── next/headers の cookies() モック ─────────────────────────────────────────
vi.mock('next/headers', () => ({
  cookies: () => ({}),
}));

// ── Route handler import ──────────────────────────────────────────────────────
import { GET } from '../../src/app/(auth)/auth/native-bridge/route';

// ── ヘルパー ──────────────────────────────────────────────────────────────────
function makeRequest(params: Record<string, string>, baseUrl = 'https://homegohan-app.vercel.app') {
  const url = new URL('/auth/native-bridge', baseUrl);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString()) as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  // デフォルト: setSession 成功
  mockSetSession.mockResolvedValue({ error: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 1: access_token / refresh_token 不在 → /login redirect
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース1: トークン不在 → /login redirect', () => {
  it('access_token も refresh_token もない場合 /login へリダイレクトする', async () => {
    const req = makeRequest({});
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).toContain('/login');
  });

  it('access_token のみある場合 /login へリダイレクトする', async () => {
    const req = makeRequest({ access_token: 'tok-access' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('refresh_token のみある場合 /login へリダイレクトする', async () => {
    const req = makeRequest({ refresh_token: 'tok-refresh' });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 2: cross-origin next パラメータ ブロック
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース2: cross-origin next パラメータ ブロック', () => {
  it('next が別オリジンの絶対 URL のとき /home?mode=app へフォールバックする', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: 'https://evil.example.com/steal',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    // evil.example.com には飛ばない
    expect(location).not.toContain('evil.example.com');
    // フォールバック先は /home?mode=app
    expect(location).toContain('/home');
    expect(location).toContain('mode=app');
  });

  it('next が同一オリジンの絶対 URL のとき許可してそこへリダイレクトする', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: 'https://homegohan-app.vercel.app/menus',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/menus');
  });

  it('next が相対パス (/ 始まり) のとき同一オリジンとして許可する', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: '/profile?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/profile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 3: is_native_app Cookie セット確認
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース3: is_native_app Cookie セット', () => {
  it('setSession 成功時に is_native_app=1 Cookie がセットされる', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
      next: '/home?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    // Set-Cookie ヘッダに is_native_app=1 が含まれること
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('is_native_app=1');
  });

  it('is_native_app Cookie には maxAge (30日相当) が設定されている', async () => {
    const req = makeRequest({
      access_token: 'tok-access',
      refresh_token: 'tok-refresh',
    });
    const res = await GET(req);
    const setCookie = res.headers.get('set-cookie') ?? '';
    // 30日 = 2592000秒
    expect(setCookie).toMatch(/max-age=2592000/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 4: setSession エラー時の fallback 動作
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース4: setSession エラー時 fallback', () => {
  it('setSession がエラーを返したとき /login へリダイレクトする', async () => {
    mockSetSession.mockResolvedValue({ error: { message: 'invalid token' } });
    const req = makeRequest({
      access_token: 'invalid-access',
      refresh_token: 'invalid-refresh',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('setSession エラー時は is_native_app Cookie がセットされない', async () => {
    mockSetSession.mockResolvedValue({ error: { message: 'session expired' } });
    const req = makeRequest({
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
    });
    const res = await GET(req);
    const setCookie = res.headers.get('set-cookie') ?? '';
    // エラー時は Cookie 不要 (is_native_app は設定しない)
    expect(setCookie).not.toContain('is_native_app=1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ケース 5: 正常フロー end-to-end
// ─────────────────────────────────────────────────────────────────────────────
describe('ケース5: 正常フロー', () => {
  it('両トークンあり setSession 成功 → next パスへリダイレクト', async () => {
    const req = makeRequest({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
      next: '/home?mode=app',
    });
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/home');
    // setSession が正しい引数で呼ばれたこと
    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
    });
  });

  it('next 省略時のデフォルトは /home?mode=app', async () => {
    const req = makeRequest({
      access_token: 'valid-access',
      refresh_token: 'valid-refresh',
    });
    const res = await GET(req);
    const location = res.headers.get('location')!;
    expect(location).toContain('/home');
    expect(location).toContain('mode=app');
  });
});
