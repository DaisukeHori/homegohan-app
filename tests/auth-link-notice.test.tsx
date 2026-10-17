/**
 * #1574 メールアドレス変更の確認の 1 通目を Web で開いたときに、何も知らせずに /home へ移らない
 *
 * Supabase の Secure email change が有効だと、1 通目のリンクの戻り先 (/auth/callback) には、セッションの代わりに
 * 知らせ (#message=Confirmation link accepted. Please proceed to confirm link sent to the other email) だけが付く。
 * /auth/callback (src/app/(auth)/auth/callback/route.ts) はサーバーで動くのでハッシュを読めず、以前は黙って /home へ移っていた。
 *
 * 確かめること:
 *   - /auth/callback: 認証の情報 (code・token_hash・token) が無いときは、本来の遷移先を next に入れて /auth/link-notice へ移す
 *     (Location にハッシュを付けない = ブラウザが元のハッシュを引き継ぐ)
 *   - /auth/callback: クエリにも message が付いたとき (GoTrue のソースでは PKCE のリンク)・token_hash / token の形の email_change で
 *     セッションが返らなかったときは、notice=email_change_awaiting_other を付ける
 *   - /auth/callback: 2 通目 (セッションが返る) や、ほかの種類の確認は、今までどおり遷移先へ直接移る
 *   - resolveLinkNotice (src/lib/auth/link-notice.ts) の表 (知らせ・エラー・どちらでもない・next の検証)
 *   - /auth/link-notice の画面: 1 通目なら知らせを出して自動では移らない。知らせが無ければ next へ、エラーならログイン画面へ移る
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_CHANGE_AWAITING_OTHER_NOTICE } from '@homegohan/shared';

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  return {
    exchangeCodeForSession: vi.fn(),
    verifyOtp: vi.fn(),
    getUser: vi.fn(),
    maybeSingle: vi.fn(),
    replace,
    // Next の useRouter は描画のたびに同じものを返す (毎回新しいものを返すと、router に依存する effect が回り続ける)
    router: { replace },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      verifyOtp: mocks.verifyOtp,
      getUser: mocks.getUser,
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
    }),
  }),
}));

// ログインの記録 (user_sessions_metadata) はこのテストの対象外
vi.mock('@/lib/auth/sessions/web-login-context', () => ({
  recordWebLoginContextFromRequest: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { GET } = await import('@/app/(auth)/auth/callback/route');
const { default: LinkNoticePage } = await import('@/app/(auth)/auth/link-notice/page');
const {
  buildLinkNoticePath,
  LINK_NOTICE_DEFAULT_NEXT,
  LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER,
  LINK_NOTICE_PATH,
  resolveLinkNotice,
} = await import('@/lib/auth/link-notice');

const ORIGIN = 'http://localhost:3000';
/** GoTrue が 1 通目の確認で付ける知らせ (URL エンコード前) */
const SINGLE_CONFIRMATION = 'Confirmation link accepted. Please proceed to confirm link sent to the other email';
/** GoTrue がハッシュ・クエリに付ける形 (url.Values の Encode と同じく空白は +) */
const SINGLE_CONFIRMATION_ENCODED = new URLSearchParams({ message: SINGLE_CONFIRMATION }).toString();
/** 初期設定を終え、いまの版に同意済みの既存の利用者 (同意画面・初期設定へは回らない) */
const EXISTING_PROFILE = {
  roles: [],
  onboarding_started_at: '2026-01-01T00:00:00.000Z',
  onboarding_completed_at: '2026-01-02T00:00:00.000Z',
  terms_version_accepted: null,
  privacy_version_accepted: null,
  birth_date: '1990-01-01',
};

async function callback(query: string): Promise<string> {
  const res = await GET(new Request(`${ORIGIN}/auth/callback${query}`));
  const location = res.headers.get('location');
  expect(location, 'リダイレクトする').not.toBeNull();
  const url = new URL(location!);
  expect(url.hash, 'Location にハッシュを付けない (ブラウザに元のハッシュを引き継がせる)').toBe('');
  return `${url.pathname}${url.search}`;
}

function noticePath(next: string, notice?: string): string {
  const params = new URLSearchParams({ next });
  if (notice) params.set('notice', notice);
  return `/auth/link-notice?${params.toString()}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@example.com' } }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: EXISTING_PROFILE, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/auth/callback: 認証リンクの知らせを /auth/link-notice へ渡す (#1574)', () => {
  it('★認証の情報が無い (1 通目のリンクの #message はサーバーに届かない) ときは、本来の遷移先を next に入れて /auth/link-notice へ', async () => {
    expect(await callback('')).toBe(noticePath('/home'));
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it('認証の情報が無く、ログインもしていないときは、next はログイン画面 (今までの移り先)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await callback('')).toBe(noticePath('/login'));
  });

  it('★クエリにも message が付いた 1 通目 (GoTrue のソースでは PKCE のリンク) は、notice を付ける', async () => {
    expect(await callback(`?${SINGLE_CONFIRMATION_ENCODED}`)).toBe(
      noticePath('/home', LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER),
    );
  });

  it('クエリの message が別の知らせなら notice は付けない (ハッシュはあちらで読む)', async () => {
    expect(await callback('?message=Email+confirmed')).toBe(noticePath('/home'));
  });

  it.each([['token_hash'], ['token']])(
    '★%s の形の email_change で、確認は通ったがセッションが返らない (1 通目) ときは、notice を付ける',
    async (param) => {
      mocks.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: null });
      expect(await callback(`?${param}=h&type=email_change`)).toBe(
        noticePath('/home', LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER),
      );
      expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'email_change' });
    },
  );

  it('email_change の 2 通目 (セッションが返る = 変更の完了) は、今までどおり遷移先へ直接移る', async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'a', refresh_token: 'r' } },
      error: null,
    });
    expect(await callback('?token_hash=h&type=email_change')).toBe('/home');
  });

  it('email_change の確認に失敗したときは notice を付けない (今までどおり)', async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { message: 'expired' } });
    expect(await callback('?token_hash=h&type=email_change')).toBe('/home');
  });

  it('ほかの種類の確認 (signup) でセッションが返らなくても notice は付けない', async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1' }, session: null }, error: null });
    expect(await callback('?token_hash=h&type=signup')).toBe('/home');
  });

  it('OAuth の code は今までどおり遷移先へ直接移る', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: { id: 'user-1' }, session: null }, error: null });
    expect(await callback('?code=abc')).toBe('/home');
  });

  it('クエリのエラーは今までどおりログイン画面へ (link-notice を通さない)', async () => {
    expect(await callback('?error=access_denied&error_description=Email+link+is+invalid')).toBe(
      '/login?error=Email+link+is+invalid',
    );
  });

  it('招待などの next は、そのまま link-notice の next に渡す', async () => {
    const next = '/invite/token-1';
    expect(await callback(`?next=${encodeURIComponent(next)}`)).toBe(noticePath(next));
  });
});

describe('resolveLinkNotice (#1574)', () => {
  it.each([
    ['ハッシュの 1 通目の知らせ', `?next=%2Fhome`, `#${SINGLE_CONFIRMATION_ENCODED}`, { kind: 'email_change_awaiting_other', next: '/home' }],
    ['サーバーが付けた notice', `?next=%2Fhome&notice=${LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER}`, '', { kind: 'email_change_awaiting_other', next: '/home' }],
    ['ログインしていないときの next', `?next=%2Flogin`, `#${SINGLE_CONFIRMATION_ENCODED}`, { kind: 'email_change_awaiting_other', next: '/login' }],
    ['知らせが無い', `?next=%2Fonboarding%2Fresume`, '', { kind: 'continue', next: '/onboarding/resume' }],
    ['別の知らせ', `?next=%2Fhome`, '#message=Email+confirmed', { kind: 'continue', next: '/home' }],
    ['ハッシュにトークンなど別のもの', `?next=%2Fhome`, '#access_token=x&refresh_token=y', { kind: 'continue', next: '/home' }],
    ['next が無い', '', '', { kind: 'continue', next: LINK_NOTICE_DEFAULT_NEXT }],
    ['next が外のサイト (オープンリダイレクト)', `?next=${encodeURIComponent('//evil.example.com')}`, '', { kind: 'continue', next: LINK_NOTICE_DEFAULT_NEXT }],
    ['next がスキーム付き', `?next=${encodeURIComponent('https://evil.example.com')}`, `#${SINGLE_CONFIRMATION_ENCODED}`, { kind: 'email_change_awaiting_other', next: LINK_NOTICE_DEFAULT_NEXT }],
    ['ハッシュのエラー (説明つき)', `?next=%2Fhome`, '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', { kind: 'link_error', redirectTo: '/login?error=Email+link+is+invalid+or+has+expired' }],
    ['ハッシュのエラー (説明なし)', `?next=%2Fhome`, '#error=access_denied', { kind: 'link_error', redirectTo: '/login?error=access_denied' }],
  ])('%s', (_label, search, hash, expected) => {
    expect(resolveLinkNotice({ search, hash })).toEqual(expected);
  });

  it('エラーは知らせより先に見る (/auth/callback と同じ順)', () => {
    expect(resolveLinkNotice({ search: '?next=%2Fhome', hash: `#error=access_denied&${SINGLE_CONFIRMATION_ENCODED}` }).kind).toBe(
      'link_error',
    );
  });

  it('buildLinkNoticePath の結果を、resolveLinkNotice がそのまま読める', () => {
    const next = '/legal-consent?next=%2Fonboarding%2Fwelcome';
    const path = buildLinkNoticePath(next, LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER);
    expect(path.startsWith(`${LINK_NOTICE_PATH}?`)).toBe(true);
    const resolved = resolveLinkNotice({ search: path.slice(LINK_NOTICE_PATH.length), hash: '' });
    expect(resolved.kind).toBe('email_change_awaiting_other');
    // getSafeRedirectPath はデコード済みの形を返す (ログイン画面の next と同じ扱い)
    expect(resolved).toEqual({ kind: 'email_change_awaiting_other', next: '/legal-consent?next=/onboarding/welcome' });
  });
});

describe('/auth/link-notice の画面 (#1574)', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderAt(search: string, hash: string) {
    window.history.replaceState(null, '', `/auth/link-notice${search}${hash}`);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<LinkNoticePage />);
    });
  }

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  it('★1 通目の知らせがハッシュにあれば、もう一方のリンクも開くよう知らせ、自動では移らない。「続ける」は next へ', async () => {
    await renderAt('?next=%2Fhome', `#${SINGLE_CONFIRMATION_ENCODED}`);
    const notice = container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(EMAIL_CHANGE_AWAITING_OTHER_NOTICE);
    expect(container.querySelector('[data-testid="link-notice-next"]')?.getAttribute('href')).toBe('/home');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('サーバーが notice を付けたときも同じ知らせを出す', async () => {
    await renderAt(`?next=%2Flogin&notice=${LINK_NOTICE_EMAIL_CHANGE_AWAITING_OTHER}`, '');
    expect(container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="link-notice-next"]')?.getAttribute('href')).toBe('/login');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('知らせが無ければ、何も出さずに next へ移る', async () => {
    await renderAt('?next=%2Fonboarding%2Fresume', '');
    expect(mocks.replace).toHaveBeenCalledWith('/onboarding/resume');
    expect(container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]')).toBeNull();
  });

  it('ハッシュにエラーがあれば、ログイン画面へエラーつきで移る', async () => {
    await renderAt('?next=%2Fhome', '#error=access_denied&error_description=Email+link+is+invalid');
    expect(mocks.replace).toHaveBeenCalledWith('/login?error=Email+link+is+invalid');
    expect(container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]')).toBeNull();
  });

  it('知らない知らせ (HTML を含む) は画面に出さず、知らせを出さないまま next へ移る', async () => {
    const hostile = '<img src=x onerror=alert(1)>Email confirmed';
    await renderAt('?next=%2Fhome', `#${new URLSearchParams({ message: hostile }).toString()}`);
    expect(mocks.replace).toHaveBeenCalledWith('/home');
    expect(container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('Email confirmed');
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('1 通目の知らせに別の文字が混ざっていても、出すのは決まった文だけ (message の値はそのまま出さない)', async () => {
    const tampered = `${SINGLE_CONFIRMATION} <b>injected</b>`;
    await renderAt('?next=%2Fhome', `#${new URLSearchParams({ message: tampered }).toString()}`);
    const notice = container.querySelector('[data-testid="link-notice-email-change-awaiting-other"]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('[role="status"]')?.textContent).toBe(EMAIL_CHANGE_AWAITING_OTHER_NOTICE);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).not.toContain('injected');
    expect(container.textContent).not.toContain(SINGLE_CONFIRMATION);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
