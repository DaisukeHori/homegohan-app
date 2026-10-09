/**
 * lib/supabase/middleware.ts のユニットテスト
 * #1030 round-2 Critical: /api/* ルートも frozen_at のアクセス制限対象にする
 * (requireUser/requireRole を経由しない route が多数あり素通りしていたバグの修正)
 * #1030 round-3 Critical: Bearer トークン (モバイルアプリ) セッションでも
 * frozen_at チェックが効くよう Authorization ヘッダーを createServerClient へ転送する
 * #1030 round-3 Warning: 凍結リダイレクトから /contact を除外する
 * #1030 round-4 Warning: CRON_SECRET (非 JWT Bearer) は Auth API へ転送しない
 * #1174: 利用規約 (/terms)・プライバシーポリシー (/privacy) は、未ログインでも、
 * ログイン済みのオンボーディング未完了・凍結中でも差し戻さない
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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
import { TEST_SUPABASE_ANON_KEY, TEST_SUPABASE_URL, stubSupabasePublicEnv } from './supabase-public-env';

// updateSession は必須の環境変数 (#1182) が無いと汎用の 500 を返して止まる。
// このファイルでは Supabase クライアントをモックしているので、値はダミーでよい (テストごとに入れ直す)。
beforeEach(() => {
  stubSupabasePublicEnv();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

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

  // #1030 (round-4 Warning fix): CRON_SECRET (非 JWT) を Auth API へ転送しない
  it('/api/cron/* の非 JWT Bearer トークン (CRON_SECRET) では Authorization ヘッダーを転送せず Auth API を呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(
      apiRequest('/api/cron/process-menu-queue', { authorization: 'Bearer this-is-not-a-jwt-cron-secret' }),
    );

    expect(res.status).toBe(200);
    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    const config = mockCreateServerClient.mock.calls[0][2];
    expect(config.global).toBeUndefined();
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

    await updateSession(apiRequest('/api/pantry', { authorization: 'Bearer aaa.bbb.ccc' }));

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    const config = mockCreateServerClient.mock.calls[0][2];
    expect(config.global).toEqual({ headers: { Authorization: 'Bearer aaa.bbb.ccc' } });
  });

  it('凍結中ユーザーの Bearer セッションによる API 呼び出しも 403 AUTH_ACCOUNT_FROZEN を返す (Cookie 無しでも frozen_at が効く)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null },
      error: null,
    });

    const res = await updateSession(apiRequest('/api/pantry', { authorization: 'Bearer aaa.bbb.ccc' }));

    expect(res.status).toBe(403);
  });

  // #1030 (round-4 Warning fix): 非 JWT の Bearer トークン (CRON_SECRET 等) は転送しない
  it('非 JWT 形式の Bearer トークンは createServerClient の global.headers へ転送しない (CRON_SECRET 誤転送防止)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await updateSession(apiRequest('/api/pantry', { authorization: 'Bearer plain-shared-secret-no-dots' }));

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    const config = mockCreateServerClient.mock.calls[0][2];
    expect(config.global).toBeUndefined();
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

// #1057 (round-2 Critical fix): 招待リンク経由でサインアップ/ログインした
// 認証済み・オンボーディング未完了ユーザーが middleware の強制オンボーディング
// リダイレクトによって /invite/[token] から弾かれないことを、実際の updateSession
// 経路(publicPaths ではなく resolveOnboardingRedirect の分岐)で検証する。
describe('updateSession — 招待リンクへの認証済みユーザーの遷移 (#1057 round-2 Critical)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('オンボーディング未着手(not_started)の新規サインアップユーザーが /invite/[token] に遷移しても /onboarding/welcome へ強制リダイレクトされない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: null,
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/invite/abcdef123456'));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング進行中(in_progress)の既存ユーザーが /invite/[token] に遷移しても /onboarding/resume へ強制リダイレクトされない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: '2026-03-01T00:00:00.000Z',
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/invite/abcdef123456'));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング未着手ユーザーが /invite/[token] 以外の保護ページに遷移する場合は従来どおり welcome へリダイレクトされる(回帰確認)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: null,
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/meal-plans'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });
});

// #1232: 家族参加の本人同意ページ (/family/promotions/[token]) はメールリンクの着地点。
// 未認証でもログイン画面へ弾かず (publicPaths)、認証済み・オンボーディング未完了でも
// 強制オンボーディングで弾かない (resolveOnboardingRedirect) ことを、実際の updateSession 経路で検証する。
describe('updateSession — 家族参加の本人同意ページへの遷移 (#1232)', () => {
  const promotionPath = `/family/promotions/${'a'.repeat(64)}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('未認証ユーザーが /family/promotions/[token] を開いても /login へリダイレクトされない (メールリンクの着地点)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest(promotionPath));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('未認証ユーザーが /family/dashboard のような他の家族ページを開くと従来どおり /login?next=... へリダイレクトされる(回帰確認)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/family/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/login?next=%2Ffamily%2Fdashboard');
  });

  it('未認証ユーザーが /family/promotionsx のような似たパスを開くと /login へリダイレクトされる(前方一致の取りこぼし防止)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest('/family/promotionsx'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/login?next=%2Ffamily%2Fpromotionsx');
  });

  it('オンボーディング未着手(not_started)の認証済みユーザーが /family/promotions/[token] に遷移しても /onboarding/welcome へ強制リダイレクトされない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: null,
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest(promotionPath));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });
});

// S-7b (#1036 のレビュー): ネイティブ認証ブリッジ (/auth/native-bridge?code=...) は、WebView に
// 残っている別アカウント (オンボーディング未完了・凍結中) のセッションがあっても、コードの引き換え前に
// 差し戻してはならない。差し戻すとコードが使われず、WebView が古いアカウントのまま残る。
describe('updateSession — 認証の途中の画面 (/auth/*) への遷移 (S-7b)', () => {
  const bridgePath = '/auth/native-bridge';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('オンボーディング未着手(not_started)のセッションが残っていても、/auth/native-bridge は /onboarding/welcome へ差し戻さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: null,
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest(bridgePath));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング進行中(in_progress)のセッションが残っていても、/auth/native-bridge は /onboarding/resume へ差し戻さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: '2026-03-01T00:00:00.000Z',
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest(bridgePath));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('凍結中のアカウントのセッションが残っていても、/auth/native-bridge は /frozen へ差し戻さない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: '2026-03-01T00:00:00.000Z',
        onboarding_completed_at: '2026-03-01T01:00:00.000Z',
        frozen_at: '2026-03-02T00:00:00.000Z',
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest(bridgePath));

    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('/authx のような似たパスは従来どおり差し戻す (前方一致の取りこぼし防止)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue({
      data: {
        roles: [],
        onboarding_started_at: null,
        onboarding_completed_at: null,
        frozen_at: null,
        unban_at: null,
      },
      error: null,
    });

    const res = await updateSession(pageRequest('/authx'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });
});

// #1174 (同意の前提): 利用規約 (/terms) とプライバシーポリシー (/privacy) は、サインアップ画面の同意リンク・
// LP のフッター・ストア審査に出すプライバシー URL の着地点。以前は (main) グループにあり publicPaths にも無かったため、
// 未ログインで開くと 307 → /login?next=%2Fprivacy になり、同意の根拠になる文面を読めないまま
// 「同意したものとみなす」状態だった。未ログインでも読めること、ログイン済みでも
// オンボーディング (/onboarding/welcome・/resume) や凍結 (/frozen) の差し戻しで弾かれないことを、
// 実際の updateSession 経路で検証する。
describe.each(['/terms', '/privacy'])('updateSession — %s への遷移 (#1174)', (policyPath) => {
  function profile(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        roles: [],
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
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it('未ログインでも /login へリダイレクトされない (同意リンクの着地点)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('未ログインでクエリ付き (?mode=app など) でも /login へリダイレクトされない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest(`${policyPath}?mode=app`));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('getUser() が例外を投げた (認証基盤の一時障害) ときも /login へリダイレクトされない', async () => {
    mockGetUser.mockRejectedValue(new Error('network error'));

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング未着手(not_started)のログイン済みユーザーも /onboarding/welcome へ差し戻されない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(
      profile({ onboarding_started_at: null, onboarding_completed_at: null }),
    );

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング進行中(in_progress)のログイン済みユーザーも /onboarding/resume へ差し戻されない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ onboarding_completed_at: null }));

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('凍結中のログイン済みユーザーも /frozen へ差し戻されない (凍結の理由になる規約を読める)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: '2026-07-01T00:00:00.000Z' }));

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('オンボーディング完了済みのログイン済みユーザーは従来どおり素通りする', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile());

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('管理者ロールのログイン済みユーザーも差し戻されない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ roles: ['admin'] }));

    const res = await updateSession(pageRequest(policyPath));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it(`${policyPath}x のような似たパスは、未ログインなら従来どおり /login?next=... へリダイレクトされる (前方一致の取りこぼし防止)`, async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(pageRequest(`${policyPath}x`));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `http://localhost/login?next=${encodeURIComponent(`${policyPath}x`)}`,
    );
  });

  it(`${policyPath}x のような似たパスは、オンボーディング未着手のログイン済みユーザーなら従来どおり welcome へ差し戻される`, async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(
      profile({ onboarding_started_at: null, onboarding_completed_at: null }),
    );

    const res = await updateSession(pageRequest(`${policyPath}x`));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/onboarding/welcome');
  });

  it(`${policyPath}x のような似たパスは、凍結中のログイン済みユーザーなら従来どおり /frozen へ差し戻される`, async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    mockMaybeSingle.mockResolvedValue(profile({ frozen_at: '2026-07-01T00:00:00.000Z' }));

    const res = await updateSession(pageRequest(`${policyPath}x`));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/frozen');
  });
});

// #1182: `process.env.X!` では、未設定のとき undefined が Supabase のクライアントに流れ込み、変数名の分からない
// エラー ("Your project's URL and Key are required...") になっていた。必須の環境変数が無いときは、
// 認証を素通りさせず (fail-open にしない)、internalError の汎用の 500 で止める。
// #1172: 応答 (本文・ヘッダ) には変数名を出さない。変数名は db-logger (構造化ログ) にだけ渡す。
const mockLoggerError = vi.fn();
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({ error: mockLoggerError, withUser: vi.fn(() => ({ error: mockLoggerError })) })),
  generateRequestId: vi.fn(() => 'req-test'),
}));

describe('updateSession — 必須の環境変数 (#1182)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it('設定されていれば、その値をそのまま createServerClient に渡す', async () => {
    await updateSession(apiRequest());

    expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    expect(mockCreateServerClient.mock.calls[0][0]).toBe(TEST_SUPABASE_URL);
    expect(mockCreateServerClient.mock.calls[0][1]).toBe(TEST_SUPABASE_ANON_KEY);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  describe.each([
    ['API', apiRequest],
    ['ページ', () => pageRequest('/home')],
  ] as const)('%s へのリクエスト', (_kind, makeRequest) => {
    it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])(
      '%s が未設定なら、汎用の 500 を返し (本文・ヘッダに変数名なし)、Supabase のクライアントを作らない',
      async (name) => {
        vi.stubEnv(name, undefined);

        const res = await updateSession(makeRequest());
        const text = await res.text();

        expect(res.status).toBe(500);
        expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
        expect(text).not.toContain(name);
        expect(JSON.stringify([...res.headers.entries()])).not.toContain(name);
        // 認証を素通りさせない (リダイレクトでも next() でもない)
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('x-middleware-next')).toBeNull();
        expect(mockCreateServerClient).not.toHaveBeenCalled();
      },
    );
  });

  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])(
    '%s が未設定なら、変数名を持つ MissingEnvError を db-logger に渡す (値は渡さない)',
    async (name) => {
      vi.stubEnv(name, undefined);

      await updateSession(pageRequest('/home'));

      expect(mockLoggerError).toHaveBeenCalledTimes(1);
      const [, error, metadata] = mockLoggerError.mock.calls[0];
      expect(error).toMatchObject({ name: 'MissingEnvError', envName: name });
      expect(metadata).toEqual({ path: '/home' });
      expect(JSON.stringify(metadata)).not.toContain(TEST_SUPABASE_URL);
      expect(JSON.stringify(metadata)).not.toContain(TEST_SUPABASE_ANON_KEY);
    },
  );

  it.each(['', '   '])('値が %j (空・空白だけ) でも、未設定として扱う', async (blank) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', blank);

    const res = await updateSession(pageRequest('/home'));

    expect(res.status).toBe(500);
    expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ envName: 'NEXT_PUBLIC_SUPABASE_URL' });
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  // 規約の同意ゲート (#1174) と合わせたときの順序。必須の変数の検査は、同意ゲート (user_profiles の読み取り・
  // 同意画面への 307・お知らせのヘッダー) より前にある。欠けていれば、同意画面へも回さず、
  // クライアントが送ってきた同意のお知らせのヘッダーも画面へ転送しない (汎用の 500 だけを返す)
  describe('同意ゲート (#1174) との順序', () => {
    const PENDING_HEADER = 'x-legal-consent-pending';
    const NOT_ACCEPTED_PROFILE = {
      data: {
        roles: [],
        onboarding_started_at: '2026-03-01T00:00:00.000Z',
        onboarding_completed_at: '2026-03-01T01:00:00.000Z',
        frozen_at: null,
        unban_at: null,
        terms_version_accepted: null,
        privacy_version_accepted: null,
      },
      error: null,
    };

    beforeEach(() => {
      vi.stubEnv('LEGAL_CONSENT_ENFORCE', 'on');
      vi.stubEnv('LEGAL_CONSENT_NOTICE', 'on');
      mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
      mockMaybeSingle.mockResolvedValue(NOT_ACCEPTED_PROFILE);
    });

    // 同意のフラグを後ろの describe に持ち越さない (Supabase の 2 つはファイル先頭の beforeEach が入れ直す)
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('対照: 変数がそろっていれば、未同意の利用者は同意画面へ回る (この組み立てで同意ゲートが働くことの確認)', async () => {
      const res = await updateSession(pageRequest('/home'));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');
      expect(mockCreateServerClient).toHaveBeenCalledTimes(1);
    });

    it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'])(
      '%s が無ければ、同意画面へ回さず汎用の 500 で止め、送られてきた同意のヘッダーも転送しない',
      async (name) => {
        vi.stubEnv(name, undefined);

        const res = await updateSession(pageRequest('/home', { [PENDING_HEADER]: '1' }));
        const text = await res.text();

        expect(res.status).toBe(500);
        expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
        expect(text).not.toContain(name);
        expect(JSON.stringify([...res.headers.entries()])).not.toContain(name);
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get(`x-middleware-request-${PENDING_HEADER}`)).toBeNull();
        expect(res.headers.get('x-middleware-override-headers')).toBeNull();
        expect(mockCreateServerClient).not.toHaveBeenCalled();
        expect(mockMaybeSingle).not.toHaveBeenCalled();
        expect(mockLoggerError.mock.calls[0][1]).toMatchObject({ envName: name });
      },
    );
  });
});

// 公開にするのは /terms と /privacy だけ。同じ「設定」まわりの保護ページ (/settings など) は
// 未ログインなら従来どおりログイン画面へ回す (publicPaths を広げすぎていないことの確認)。
describe('updateSession — 保護ページは未ログインなら従来どおり /login へ回す (#1174 回帰確認)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  });

  it.each(['/settings', '/profile', '/home'])(
    '未ログインで %s を開くと /login?next=... へリダイレクトされる',
    async (path) => {
      mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

      const res = await updateSession(pageRequest(path));

      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(
        `http://localhost/login?next=${encodeURIComponent(path)}`,
      );
    },
  );
});
