/**
 * lib/supabase/middleware.ts のユニットテスト
 * #1030 round-2 Critical: /api/* ルートも frozen_at のアクセス制限対象にする
 * (requireUser/requireRole を経由しない route が多数あり素通りしていたバグの修正)
 * #1030 round-3 Critical: Bearer トークン (モバイルアプリ) セッションでも
 * frozen_at チェックが効くよう Authorization ヘッダーを createServerClient へ転送する
 * #1030 round-3 Warning: 凍結リダイレクトから /contact を除外する
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// @supabase/ssr の createServerClient モック
// ─────────────────────────────────────────────────────────────────────────────

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockCreateServerClient = vi.fn();

mockCreateServerClient.mockImplementation(() => ({
  auth: {
    getSession: mockGetSession,
    getUser: mockGetUser,
  },
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

import { updateSession } from '../middleware';

function apiRequest(path = '/api/pantry', headers?: Record<string, string>) {
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

function pageRequest(path: string, headers?: Record<string, string>) {
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

describe('updateSession — /api/* の frozen_at enforcement (#1030 round-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('凍結中 (無期限 BAN) のユーザーの API 呼び出しは 403 AUTH_ACCOUNT_FROZEN を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null },
      error: null,
    });

    const res = await updateSession(apiRequest());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
    });
  });

  it('一時 BAN 継続中 (unban_at が未来) の場合も 403 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: future },
      error: null,
    });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(403);
  });

  it('一時 BAN の期限切れ (unban_at が過去) の場合はブロックしない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: '2026-07-02T00:00:00.000Z' },
      error: null,
    });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
  });

  it('未凍結ユーザーの API 呼び出しはブロックしない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: null, unban_at: null },
      error: null,
    });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
  });

  it('未認証 (user=null) の場合はブロックせず route 側の 401 判定に委ねる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it('getUser() がエラーを返した場合は fail-open で route 側に委ねる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'auth error' } });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
  });

  it('getUser() が例外を throw した場合も fail-open で全 API を止めない', async () => {
    mockGetUser.mockRejectedValue(new Error('network error'));

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
  });

  it('user_profiles 取得がエラーの場合は fail-open でブロックしない (#348 と同様の方針)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db error' } });

    const res = await updateSession(apiRequest());
    expect(res.status).toBe(200);
  });

  it('/api/cron/* のような Bearer トークン認証ルートは Supabase セッションが無いため影響を受けない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(apiRequest('/api/cron/process-menu-queue'));
    expect(res.status).toBe(200);
  });
});

describe('updateSession — Authorization ヘッダーの転送 (#1030 round-3 Critical)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('Authorization ヘッダーがある場合 (モバイルアプリの Bearer セッション) は createServerClient の global.headers へ転送する', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({ data: { frozen_at: null, unban_at: null }, error: null });

    await updateSession(apiRequest('/api/pantry', { authorization: 'Bearer mobile-token' }));

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    const config = mockCreateServerClient.mock.calls[0][2];
    expect(config.global).toEqual({ headers: { Authorization: 'Bearer mobile-token' } });
  });

  it('凍結中ユーザーの Bearer セッションによる API 呼び出しも 403 AUTH_ACCOUNT_FROZEN を返す (Cookie 無しでも frozen_at が効く)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null },
      error: null,
    });

    const res = await updateSession(apiRequest('/api/pantry', { authorization: 'Bearer mobile-token' }));

    expect(res.status).toBe(403);
  });

  it('Authorization ヘッダーが無い場合は global オプションを渡さない (Cookie セッションの既存挙動を維持)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await updateSession(apiRequest('/api/pantry'));

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    const config = mockCreateServerClient.mock.calls[0][2];
    expect(config.global).toBeUndefined();
  });
});

describe('updateSession — ページナビゲーションの凍結リダイレクト (#1030 round-3 Warning)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('凍結中ユーザーが保護ページへ遷移すると /frozen へリダイレクトされる', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: ['user'],
        onboarding_started_at: '2026-01-01T00:00:00.000Z',
        onboarding_completed_at: '2026-01-01T00:00:00.000Z',
        frozen_at: '2026-07-01T00:00:00.000Z',
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/frozen');
  });

  it('凍結中ユーザーが /contact へ遷移してもリダイレクトされない (サポート導線のデッドリンク化を防止)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: ['user'],
        onboarding_started_at: '2026-01-01T00:00:00.000Z',
        onboarding_completed_at: '2026-01-01T00:00:00.000Z',
        frozen_at: '2026-07-01T00:00:00.000Z',
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/contact'));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('凍結中ユーザーは /frozen 自体には無限リダイレクトしない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: ['user'],
        onboarding_started_at: '2026-01-01T00:00:00.000Z',
        onboarding_completed_at: '2026-01-01T00:00:00.000Z',
        frozen_at: '2026-07-01T00:00:00.000Z',
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/frozen'));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });
});
