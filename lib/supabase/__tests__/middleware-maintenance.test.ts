/**
 * lib/supabase/middleware.ts のメンテナンスモード (#1148) のユニットテスト
 *
 * feature_flags の maintenance_mode が ON のあいだ、運営 (admin / super_admin) 以外には
 * メンテナンス中の応答を返す。
 *   - ページ: 503 の HTML (Retry-After 付き。ログイン画面へ回さない)
 *   - API:    503 の JSON { error: { code: 'MAINTENANCE_MODE', message } }
 * 止めないもの: 運営ロール / ログイン・認証 (/login・/auth/*) / 利用規約・プライバシーポリシー /
 *   死活監視 (/api/health)・cron・認証 API・フラグの取得 (/api/feature-flags) / /_next
 *   (画像などの静的ファイルは、ミドルウェアの matcher が外していて、ここには届かない。拡張子で通す処理は無い)
 * フラグの読み出しの失敗は fail-open (止めない)。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// @supabase/ssr の createServerClient モック (middleware.test.ts と同型)
// ─────────────────────────────────────────────────────────────────────────────
const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockCreateServerClient = vi.fn();

mockCreateServerClient.mockImplementation(() => ({
  auth: { getSession: mockGetSession, getUser: mockGetUser },
  from: (_table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: mockMaybeSingle,
      }),
    }),
  }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

// メンテナンスモードのフラグ。テストごとに ON / OFF / 例外を差し込む
const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string, _options?: unknown) => true);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string, options?: unknown) => mockIsFeatureEnabled(key, userId, options),
}));

import { updateSession } from '../middleware';
import { stubSupabasePublicEnv } from './supabase-public-env';

function apiRequest(path: string) {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function pageRequest(path: string) {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      roles: ['user'],
      onboarding_started_at: '2026-03-01T00:00:00.000Z',
      onboarding_completed_at: '2026-03-01T01:00:00.000Z',
      frozen_at: null,
      unban_at: null,
      ...overrides,
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // updateSession は Supabase の URL・anon キーが無いと汎用の 500 で止まる (#1182)。Supabase のクライアントはモックなので値はダミー
  stubSupabasePublicEnv();
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(true); // メンテナンス ON
});

afterEach(() => {
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(true);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('updateSession — メンテナンスモード: API (/api/*) (#1148)', () => {
  it('一般ユーザーの API 呼び出しは 503 MAINTENANCE_MODE。Retry-After が付き、キャッシュさせない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(apiRequest('/api/pantry'));

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.error.code).toBe('MAINTENANCE_MODE');
    expect(body.error.message).toContain('メンテナンス中');
  });

  it('フラグは maintenance_mode を、そのユーザーの ID とロールで、短い待ち時間の上限つきで読む', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['support'] }));

    await updateSession(apiRequest('/api/pantry'));

    expect(mockIsFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('maintenance_mode', 'user-1', {
      timeoutMs: 800,
      context: { roles: ['support'] },
    });
  });

  it.each([['admin'], ['super_admin']])('%s の API 呼び出しは止めない (フラグも読まない)', async (role) => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'op-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user', role] }));

    const res = await updateSession(apiRequest('/api/pantry'));

    expect(res.status).toBe(200);
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('org_admin や support などの運営ではないロールは止める', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['org_admin', 'org_manager', 'support'] }));

    const res = await updateSession(apiRequest('/api/org/members'));
    expect(res.status).toBe(503);
  });

  it('未ログインの API 呼び出しも 503 (route 側の 401 より先にメンテナンス中を返す)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest('/api/pantry'));

    expect(res.status).toBe(503);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('maintenance_mode', undefined, expect.anything());
  });

  it('プロフィールを読めなかった (運営かどうか確かめられない) ときは、運営ではない人として止める', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db error' } });

    const res = await updateSession(apiRequest('/api/pantry'));
    expect(res.status).toBe(503);
  });

  it('フラグが OFF なら今までどおり通す', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(apiRequest('/api/pantry'));
    expect(res.status).toBe(200);
  });

  it('凍結中のユーザーは、メンテナンス中でも先に 403 AUTH_ACCOUNT_FROZEN (凍結の判定は変えない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: '2026-07-01T00:00:00.000Z' }));

    const res = await updateSession(apiRequest('/api/pantry'));
    expect(res.status).toBe(403);
  });

  it.each([
    '/api/health',
    '/api/cron/process-menu-queue',
    '/api/auth/session-sync',
    '/api/auth/native-bridge/code',
    '/api/feature-flags',
  ])('%s はメンテナンス中でも止めない (フラグも読まない)', async (path) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest(path));

    expect(res.status).toBe(200);
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it.each([
    '/api/healthz',
    '/api/health/goals',
    '/api/authx',
    '/api/cronx/job',
    '/api/feature-flags/extra',
    '/api/feature-flagsx',
  ])('%s のような似たパスは止める (前方一致の取りこぼし防止)', async (path) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest(path));
    expect(res.status).toBe(503);
  });

  it('静的ファイルの拡張子を API の末尾に付けても、メンテナンス中の応答を返す (動的な API ルートを通り抜けさせない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest('/api/recipes/abc.json'));
    expect(res.status).toBe(503);
  });

  it('この呼び出しで更新されたセッションの Cookie を、メンテナンス中の応答にも載せる (更新トークンを失わない)', async () => {
    mockGetUser.mockImplementation(async () => {
      const config = mockCreateServerClient.mock.calls[0][2];
      config.cookies.set('sb-refreshed-token', 'new-value', { path: '/' });
      return { data: { user: { id: 'user-1' } }, error: null };
    });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(apiRequest('/api/pantry'));

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toContain('sb-refreshed-token=new-value');
  });

  it('フラグの判定が (万一) 例外を投げても、API を止めない (fail-open)', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('flag store exploded'));
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(apiRequest('/api/pantry'));
    expect(res.status).toBe(200);
  });
});

describe('updateSession — メンテナンスモード: ページ (#1148)', () => {
  it('未ログインの人には、ログイン画面へ回さず、メンテナンス中の画面 (503 の HTML) を出す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('retry-after')).toBe('300');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const html = await res.text();
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('メンテナンス中');
  });

  it('メンテナンス中の画面は自己完結している (外部への通信もスクリプトも無い。運営向けのログインへのリンクだけある)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const html = await (await updateSession(pageRequest('/home'))).text();

    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).toContain('href="/login"');
  });

  it('公開ページ (トップ) もメンテナンス中の画面になる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/'));
    expect(res.status).toBe(503);
  });

  it('一般ユーザーには、オンボーディングや凍結の差し戻しより先に、メンテナンス中の画面を出す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    mockMaybeSingle.mockResolvedValue(profile({ onboarding_started_at: null, onboarding_completed_at: null }));
    const notStarted = await updateSession(pageRequest('/meal-plans'));
    expect(notStarted.status).toBe(503);
    expect(notStarted.headers.get('location')).toBeNull();

    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: '2026-07-01T00:00:00.000Z' }));
    const frozen = await updateSession(pageRequest('/meal-plans'));
    expect(frozen.status).toBe(503);
    expect(frozen.headers.get('location')).toBeNull();
  });

  it.each([
    ['admin', '/admin'],
    ['super_admin', '/super-admin'],
  ])('%s は止めない (メンテナンスの作業ができる。フラグも読まない)', async (role, path) => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'op-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: [role] }));

    const res = await updateSession(pageRequest(path));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('運営ロールのユーザーが /home を開くと、今までどおり /admin へ送られる (メンテナンスの対象外)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'op-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['admin'] }));

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/admin');
  });

  it.each([
    '/login',
    '/login/',
    '/auth/native-bridge',
    '/auth/callback',
    '/terms',
    '/privacy',
    '/_next/static/chunks/main.js',
  ])('%s はメンテナンス中でも止めない (未ログイン。フラグも読まない)', async (path) => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest(path));

    expect(res.status).not.toBe(503);
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });

  it('ログイン中の一般ユーザーが /auth/native-bridge を開いても止めない (コードの引き換えを妨げない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(pageRequest('/auth/native-bridge'));
    expect(res.status).not.toBe(503);
  });

  it.each(['/loginx', '/authx', '/termsx', '/privacyx', '/_nextx/static'])(
    '%s のような似たパスは止める (前方一致の取りこぼし防止)',
    async (path) => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const res = await updateSession(pageRequest(path));
      expect(res.status).toBe(503);
    },
  );

  // 静的ファイルは matcher がミドルウェアから外している。拡張子で通すことはしないので、
  // 末尾が静的ファイルに見える動的なページのパスも、一般ユーザーはメンテナンス中の画面で止まる
  it.each(['/meals/abc.json', '/invite/x.txt', '/family/members/x.js', '/pantry/x.css'])(
    '%s のような、末尾が静的ファイルに見えるページのパスも止める (未ログイン)',
    async (path) => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const res = await updateSession(pageRequest(path));
      expect(res.status).toBe(503);
    },
  );

  it('ログイン中の一般ユーザーが /meals/abc.json を開いても止める (ページの描画まで進ませない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(pageRequest('/meals/abc.json'));
    expect(res.status).toBe(503);
  });

  it('プロフィールを読めなかった (運営かどうか確かめられない) ときは、運営ではない人として止める', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db error' } });

    const res = await updateSession(pageRequest('/home'));
    expect(res.status).toBe(503);
  });

  it('フラグが OFF なら今までどおり (未ログインは /login へ、ログイン済みは素通り)', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);

    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const anon = await updateSession(pageRequest('/home'));
    expect(anon.status).toBe(307);
    expect(anon.headers.get('location')).toBe('http://localhost/login?next=%2Fhome');

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());
    const loggedIn = await updateSession(pageRequest('/home'));
    expect(loggedIn.status).toBe(200);
  });

  it('ログイン済みの人の判定には、そのユーザーの ID と、読んだロールを渡す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['user', 'org_member'] }));

    await updateSession(pageRequest('/home'));

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('maintenance_mode', 'user-1', {
      timeoutMs: 800,
      context: { roles: ['user', 'org_member'] },
    });
  });

  it('この呼び出しで更新されたセッションの Cookie を、メンテナンス中の画面にも載せる', async () => {
    mockGetUser.mockImplementation(async () => {
      const config = mockCreateServerClient.mock.calls[0][2];
      config.cookies.set('sb-refreshed-token', 'new-value', { path: '/' });
      return { data: { user: { id: 'user-1' } }, error: null };
    });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toContain('sb-refreshed-token=new-value');
  });

  it('フラグの判定が (万一) 例外を投げても、ページを止めない (fail-open)', async () => {
    mockIsFeatureEnabled.mockRejectedValue(new Error('flag store exploded'));
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(pageRequest('/home'));
    expect(res.status).toBe(200);
  });
});
