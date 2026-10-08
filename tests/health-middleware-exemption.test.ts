// @vitest-environment node
/**
 * tests/health-middleware-exemption.test.ts
 *
 * #1181: 死活監視用の /api/health が、認証ミドルウェア (Supabase のセッション処理) を通らず、
 * 未ログインのまま route に届くことの回帰テスト。
 *
 *   1. src/middleware.ts の matcher: ちょうど /api/health だけをミドルウェアの対象から外す。
 *      /api/health/* (健康記録 API) や /health (健康記録ページ) は従来どおり対象のまま。
 *   2. updateSession: matcher を通って呼ばれた場合でも、未ログインの /api/health を
 *      ログインへリダイレクトしたり 401/403 で止めたりしない。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── @supabase/ssr モック (lib/supabase/__tests__/middleware.test.ts と同型) ───
const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockCreateServerClient = vi.fn();

mockCreateServerClient.mockImplementation(() => ({
  auth: { getSession: mockGetSession, getUser: mockGetUser },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn() }) }) }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

// #1148: メンテナンスモードのフラグ。ここではメンテナンス OFF の前提で、DB を読みに行かせない
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { config } from '@/middleware';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Next.js は matcher を path-to-regexp で正規表現に変換する。この matcher は
 * `/(<否定先読みつきの正規表現>)` の 1 グループだけなので、前後を ^ $ で挟めば同じ判定になる。
 */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

describe('src/middleware.ts の matcher (#1181)', () => {
  it('ちょうど /api/health はミドルウェアを通さない', () => {
    expect(runsMiddleware('/api/health')).toBe(false);
  });

  it('/api/health/* (健康記録 API) は従来どおりミドルウェアの対象のまま', () => {
    expect(runsMiddleware('/api/health/goals')).toBe(true);
    expect(runsMiddleware('/api/health/blood-tests')).toBe(true);
    expect(runsMiddleware('/api/health/records/quick')).toBe(true);
    expect(runsMiddleware('/api/health/notifications/preferences')).toBe(true);
  });

  it('前方一致で巻き込まない (/api/healthz, /api/health-check, /api/healthy)', () => {
    expect(runsMiddleware('/api/healthz')).toBe(true);
    expect(runsMiddleware('/api/health-check')).toBe(true);
    expect(runsMiddleware('/api/healthy')).toBe(true);
  });

  it('健康記録ページ /health と他の API・ページは対象のまま', () => {
    expect(runsMiddleware('/health')).toBe(true);
    expect(runsMiddleware('/health/goals')).toBe(true);
    expect(runsMiddleware('/api/profile')).toBe(true);
    expect(runsMiddleware('/api/cron/process-menu-queue')).toBe(true);
    expect(runsMiddleware('/login')).toBe(true);
    expect(runsMiddleware('/')).toBe(true);
  });

  it('既存の除外 (静的ファイル・manifest・robots・service worker・画像) は変わらない', () => {
    expect(runsMiddleware('/_next/static/chunks/main.js')).toBe(false);
    expect(runsMiddleware('/_next/image')).toBe(false);
    expect(runsMiddleware('/favicon.ico')).toBe(false);
    expect(runsMiddleware('/manifest.json')).toBe(false);
    expect(runsMiddleware('/robots.txt')).toBe(false);
    expect(runsMiddleware('/sw.js')).toBe(false);
    expect(runsMiddleware('/workbox-abc123.js')).toBe(false);
    expect(runsMiddleware('/logo.png')).toBe(false);
  });
});

describe('updateSession — 未ログインの /api/health (#1181)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'Auth session missing!' } });
  });

  it('ログインへリダイレクトせず、そのまま route に渡す', async () => {
    const res = await updateSession(new NextRequest(new URL('http://localhost/api/health')));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('?deep=1 でも同じ', async () => {
    const res = await updateSession(new NextRequest(new URL('http://localhost/api/health?deep=1')));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('ページの /health (健康記録) は従来どおり未ログインなら /login へ送る (除外の対象外)', async () => {
    const res = await updateSession(new NextRequest(new URL('http://localhost/health')));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/login?next=%2Fhealth');
  });
});
