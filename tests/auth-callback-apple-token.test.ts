/**
 * Web の Apple のログイン (段 B) の /auth/callback (docs/design/mobile/08-sign-in-with-apple.md §9.5・§12.3・S-34)。
 *   - ?provider=apple で code の交換が成功したら、Apple の refresh token の保管を session と user で 1 回呼ぶ
 *   - 保管は振り分け (同意画面 / next) を変えない。provider 無し (Google) は保管を呼んでも skipped で何も変わらない
 *   - ?error= で戻ったとき: ?provider=apple は固定の日本語の文 (error の値・Apple と GoTrue の英文を出さない)、ほかは今までどおり
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  storeAppleRefreshTokenFromWebCallback: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession, getUser: mocks.getUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
  }),
}));

vi.mock('@/lib/auth/sessions/web-login-context', () => ({
  recordWebLoginContextFromRequest: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

// 保管の中身は src/__tests__/lib/auth/apple/web-callback.test.ts が見る。ここでは呼び方と、固定の文だけを実物のまま使う
vi.mock('@/lib/auth/apple/web-callback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/apple/web-callback')>();
  return { ...actual, storeAppleRefreshTokenFromWebCallback: mocks.storeAppleRefreshTokenFromWebCallback };
});

const { GET } = await import('@/app/(auth)/auth/callback/route');
const { APPLE_WEB_CALLBACK_ERROR_MESSAGE } = await import('@/lib/auth/apple/web-callback');
const { AUTH_LINK_ERROR_MESSAGE } = await import('@homegohan/shared');

const ORIGIN = 'http://localhost:3000';
const USER = { id: 'user-1', email: 'a@example.com', identities: [{ provider: 'apple' }] };
const SESSION = { access_token: 'access.token', refresh_token: 'refresh.token', provider_refresh_token: 'apple.rt' };
/** 初期設定を終え、いまの版に同意済みの既存の利用者 */
const EXISTING_PROFILE = {
  roles: [],
  onboarding_started_at: '2026-01-01T00:00:00.000Z',
  onboarding_completed_at: '2026-01-02T00:00:00.000Z',
  terms_version_accepted: null,
  privacy_version_accepted: null,
};
/** 初期設定をまだ始めていない新しい利用者 (同意画面へ回る) */
const NEW_PROFILE = { roles: [], onboarding_started_at: null, onboarding_completed_at: null };

async function callback(query: string): Promise<URL> {
  const res = await GET(new Request(`${ORIGIN}/auth/callback${query}`));
  const location = res.headers.get('location');
  expect(location, 'リダイレクトする').not.toBeNull();
  return new URL(location!);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: EXISTING_PROFILE, error: null });
  mocks.storeAppleRefreshTokenFromWebCallback.mockResolvedValue('stored');
});

describe('/auth/callback: Apple の refresh token の保管', () => {
  it('?provider=apple で code の交換が成功すると storeAppleRefreshTokenFromWebCallback を session と user で呼ぶ', async () => {
    const location = await callback('?provider=apple&code=abc&next=%2Fhome');

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('abc');
    expect(mocks.storeAppleRefreshTokenFromWebCallback).toHaveBeenCalledTimes(1);
    const input = mocks.storeAppleRefreshTokenFromWebCallback.mock.calls[0][0];
    expect(input.provider).toBe('apple');
    expect(input.user).toBe(USER);
    expect(input.session).toBe(SESSION);
    expect(input.requestId).toBe('req_test');
    expect(typeof input.log.info).toBe('function');
    expect(typeof input.log.warn).toBe('function');
    expect(location.pathname).toBe('/home');
  });

  it('交換が失敗したときは保管を呼ばない', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'invalid flow state' } });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const location = await callback('?provider=apple&code=abc');

    expect(mocks.storeAppleRefreshTokenFromWebCallback).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/login');
  });

  it('provider 無し (Google) では呼んでも skipped で、振り分けは変わらない', async () => {
    mocks.storeAppleRefreshTokenFromWebCallback.mockResolvedValue('skipped');

    const location = await callback('?code=abc&next=%2Fhome');

    expect(mocks.storeAppleRefreshTokenFromWebCallback).toHaveBeenCalledTimes(1);
    expect(mocks.storeAppleRefreshTokenFromWebCallback.mock.calls[0][0].provider).toBeNull();
    expect(location.pathname).toBe('/home');
  });

  it('保管の失敗でも同意画面 / next への redirect は同じ', async () => {
    // 保管の lib は投げない (warn で skipped)。それでも、skipped を返す場合と stored を返す場合で redirect 先が同じこと
    mocks.maybeSingle.mockResolvedValue({ data: NEW_PROFILE, error: null });

    mocks.storeAppleRefreshTokenFromWebCallback.mockResolvedValue('skipped');
    const skipped = await callback('?provider=apple&code=abc&next=%2Fhome');
    mocks.storeAppleRefreshTokenFromWebCallback.mockResolvedValue('stored');
    const stored = await callback('?provider=apple&code=abc&next=%2Fhome');

    expect(skipped.pathname).toBe('/legal-consent');
    expect(`${skipped.pathname}${skipped.search}`).toBe(`${stored.pathname}${stored.search}`);
    expect(new URL(skipped.toString()).searchParams.get('next')).toBe('/home');
  });
});

describe('/auth/callback: ?error= (S-34)', () => {
  it('?provider=apple&next=%2Fhome&error=user_cancelled_authorize (error_description 無し) は /login へ redirect し、Location の error は APPLE_WEB_CALLBACK_ERROR_MESSAGE。交換も保管も呼ばない', async () => {
    const location = await callback('?provider=apple&next=%2Fhome&error=user_cancelled_authorize');

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe(APPLE_WEB_CALLBACK_ERROR_MESSAGE);
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocks.storeAppleRefreshTokenFromWebCallback).not.toHaveBeenCalled();
  });

  it('?provider=apple&error=access_denied&error_description=<英文> も同じ固定の文で、Location に英文 (error_description・error の値) を含まない', async () => {
    const description = 'User denied the Apple authorization request';
    const location = await callback(
      `?provider=apple&error=access_denied&error_description=${encodeURIComponent(description)}`,
    );

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe(APPLE_WEB_CALLBACK_ERROR_MESSAGE);
    const raw = decodeURIComponent(location.search.replace(/\+/g, ' '));
    expect(raw).not.toContain(description);
    expect(raw).not.toContain('access_denied');
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('?provider= 無し (Google・メールのリンク) の ?error=access_denied&error_description=<英文> は /login?error=<固定の文>。英文を Location に含まない (#1917 の続き)', async () => {
    const description = 'Access denied by the provider';
    const location = await callback(`?error=access_denied&error_description=${encodeURIComponent(description)}`);

    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe(AUTH_LINK_ERROR_MESSAGE);
    const raw = decodeURIComponent(location.search.replace(/\+/g, ' '));
    expect(raw).not.toContain(description);
    expect(raw).not.toContain('access_denied');
  });

  it('?provider=google の ?error= (error_description 無し) も固定の文 (error の値を出さない)', async () => {
    const location = await callback('?provider=google&error=access_denied');

    expect(location.searchParams.get('error')).toBe(AUTH_LINK_ERROR_MESSAGE);
  });

  it('固定の文は日本語で、% を含まない (ログイン画面がもう 1 回 decodeURIComponent する)', () => {
    expect(AUTH_LINK_ERROR_MESSAGE).toMatch(/[ぁ-んァ-ン一-龥]/);
    expect(AUTH_LINK_ERROR_MESSAGE).not.toContain('%');
  });
});
