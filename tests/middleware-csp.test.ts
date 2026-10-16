// @vitest-environment node
/**
 * #1169: src/middleware.ts が、どの分岐の応答にも nonce つきの CSP を付け、同じ方針をリクエストヘッダーにも載せて
 * Next (と画面の getCspNonce) へ渡すことの検査 (docs/design/cross/18-csp-nonce.md §4・§12.1・§15)。
 *
 * updateSession (lib/supabase/middleware.ts) はモックにし、既存の分岐が返す応答の形 (next / redirect / 403 JSON / 503 HTML / 500、
 * 同意のお知らせのために NextResponse.next({ request }) を作り直す形) をそのまま返させる。
 * NextResponse.next({ request }) は、作った時点の request.headers を x-middleware-request-* として Next に渡すので、
 * その値で「Next が読むリクエストヘッダー」を確かめる。
 */
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type UpdateSessionBranch =
  | 'next'
  | 'consent-pending'
  | 'redirect'
  | 'frozen-json'
  | 'maintenance-html'
  | 'internal-error';

const { session } = vi.hoisted(() => ({
  session: {
    branch: 'next' as UpdateSessionBranch,
    /** updateSession が呼ばれた時点のリクエストヘッダー (middleware が載せた値) */
    seenHeaders: null as Headers | null,
  },
}));

/** 同意のお知らせのヘッダー (lib/supabase/middleware.ts の withLegalConsentPendingHeader が足す) */
const LEGAL_CONSENT_PENDING_HEADER = 'x-legal-consent-pending';
/** NextResponse.next({ request }) が Next へ渡すリクエストヘッダーの前置き (Next の内部の約束) */
const FORWARDED_REQUEST_HEADER_PREFIX = 'x-middleware-request-';
/** NextResponse.next({ request }) が、上書きしたリクエストヘッダーの名前を並べるヘッダー */
const OVERRIDE_HEADERS_HEADER = 'x-middleware-override-headers';
/** 本番の Supabase の URL の見本 (方針にローカルの origin を足さない) */
const PRODUCTION_SUPABASE_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co';
/** 応答の状態 (updateSession の既存の分岐が返すもの) */
const STATUS_FORBIDDEN = 403;
const STATUS_SERVICE_UNAVAILABLE = 503;
const STATUS_INTERNAL_ERROR = 500;
const STATUS_TEMPORARY_REDIRECT = 307;

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: async (request: NextRequest) => {
    session.seenHeaders = new Headers(request.headers);
    switch (session.branch) {
      case 'next':
        return NextResponse.next({ request });
      case 'consent-pending': {
        // withLegalConsentPendingHeader と同じ: 1 度作った応答を、request.headers を足してから作り直す
        const first = NextResponse.next({ request });
        request.headers.set(LEGAL_CONSENT_PENDING_HEADER, '1');
        const recreated = NextResponse.next({ request });
        for (const cookie of first.cookies.getAll()) recreated.cookies.set(cookie);
        return recreated;
      }
      case 'redirect':
        return NextResponse.redirect(new URL('/frozen', request.url));
      case 'frozen-json':
        return NextResponse.json({ error: 'frozen', code: 'AUTH_ACCOUNT_FROZEN' }, { status: STATUS_FORBIDDEN });
      case 'maintenance-html':
        return new NextResponse('<!doctype html><html><head><style>body{margin:0}</style></head><body>メンテナンス中</body></html>', {
          status: STATUS_SERVICE_UNAVAILABLE,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      case 'internal-error':
        return NextResponse.json({ error: 'internal', code: 'INTERNAL_ERROR' }, { status: STATUS_INTERNAL_ERROR });
    }
  },
}));

const { middleware } = await import('@/middleware');
const { CSP_HEADER, CSP_NONCE_HEADER, CSP_REPORT_ONLY_HEADER, cspDirectivesOf } = await import('@/lib/security/csp');

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(path, 'https://homegohan.example'), { headers });
}

/** 方針の script-src の 'nonce-…' の値 */
function nonceOf(policy: string | null): string | undefined {
  expect(policy, 'CSP が無い').not.toBeNull();
  const source = cspDirectivesOf(policy ?? '')
    .get('script-src')
    ?.find((token) => token.startsWith("'nonce-"));
  return source?.slice("'nonce-".length, -1);
}

/** NextResponse.next({ request }) が Next へ渡すリクエストヘッダーの値 */
function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`${FORWARDED_REQUEST_HEADER_PREFIX}${name.toLowerCase()}`);
}

beforeEach(() => {
  session.branch = 'next';
  session.seenHeaders = null;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PRODUCTION_SUPABASE_URL);
  vi.stubEnv('CSP_REPORT_ONLY', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('src/middleware.ts の CSP (#1169)', () => {
  it('応答に Content-Security-Policy が付き、script-src の nonce が request header の x-csp-nonce と同じ', async () => {
    const response = await middleware(request('/home'));
    const policy = response.headers.get(CSP_HEADER);
    const nonce = nonceOf(policy);

    expect(nonce).toBeDefined();
    expect(session.seenHeaders?.get(CSP_NONCE_HEADER)).toBe(nonce);
    expect(forwardedRequestHeader(response, CSP_NONCE_HEADER)).toBe(nonce);
    expect(cspDirectivesOf(policy ?? '').get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('request header の content-security-policy にも同じ方針が載る (Next が読む経路)', async () => {
    const response = await middleware(request('/'));
    const policy = response.headers.get(CSP_HEADER);

    expect(session.seenHeaders?.get(CSP_HEADER)).toBe(policy);
    expect(forwardedRequestHeader(response, CSP_HEADER)).toBe(policy);
    expect(response.headers.get(OVERRIDE_HEADERS_HEADER)?.split(',')).toEqual(
      expect.arrayContaining([CSP_HEADER.toLowerCase(), CSP_NONCE_HEADER]),
    );
  });

  it.each([
    ['redirect', STATUS_TEMPORARY_REDIRECT],
    ['frozen-json', STATUS_FORBIDDEN],
    ['maintenance-html', STATUS_SERVICE_UNAVAILABLE],
    ['internal-error', STATUS_INTERNAL_ERROR],
  ] as const)('updateSession が redirect / 403 JSON / 503 HTML / 500 を返しても CSP が付く (%s)', async (branch, status) => {
    session.branch = branch;
    const response = await middleware(request('/home'));

    expect(response.status).toBe(status);
    const nonce = nonceOf(response.headers.get(CSP_HEADER));
    expect(nonce).toBe(session.seenHeaders?.get(CSP_NONCE_HEADER));
  });

  it('updateSession が NextResponse.next({ request }) を作り直しても (x-legal-consent-pending を足す経路) request header の nonce は変わらない', async () => {
    session.branch = 'consent-pending';
    const response = await middleware(request('/home'));
    const nonce = nonceOf(response.headers.get(CSP_HEADER));

    expect(forwardedRequestHeader(response, LEGAL_CONSENT_PENDING_HEADER)).toBe('1');
    expect(forwardedRequestHeader(response, CSP_NONCE_HEADER)).toBe(nonce);
    expect(forwardedRequestHeader(response, CSP_HEADER)).toBe(response.headers.get(CSP_HEADER));
  });

  it('2 回の要求で nonce が違う', async () => {
    const first = nonceOf((await middleware(request('/'))).headers.get(CSP_HEADER));
    const second = nonceOf((await middleware(request('/'))).headers.get(CSP_HEADER));

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('クライアントが送った x-csp-nonce・content-security-policy・content-security-policy-report-only は捨てられ、middleware の値だけが残る', async () => {
    const response = await middleware(
      request('/', {
        [CSP_NONCE_HEADER]: 'evil',
        'content-security-policy': "script-src 'nonce-evil'",
        'content-security-policy-report-only': "script-src 'nonce-evil2'",
      }),
    );
    const policy = response.headers.get(CSP_HEADER);
    const nonce = nonceOf(policy);

    expect(nonce).not.toBe('evil');
    expect(session.seenHeaders?.get(CSP_NONCE_HEADER)).toBe(nonce);
    expect(session.seenHeaders?.get(CSP_HEADER)).toBe(policy);
    expect(session.seenHeaders?.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    expect(forwardedRequestHeader(response, CSP_NONCE_HEADER)).toBe(nonce);
    expect(forwardedRequestHeader(response, CSP_HEADER)).toBe(policy);
    expect(policy).not.toContain('evil');
  });

  it('CSP_REPORT_ONLY=on なら応答と request header の名前が Content-Security-Policy-Report-Only になり、Content-Security-Policy は付かない', async () => {
    vi.stubEnv('CSP_REPORT_ONLY', 'on');
    const response = await middleware(request('/', { 'content-security-policy': "script-src 'nonce-evil'" }));
    const policy = response.headers.get(CSP_REPORT_ONLY_HEADER);
    const nonce = nonceOf(policy);

    expect(response.headers.get(CSP_HEADER)).toBeNull();
    expect(session.seenHeaders?.get(CSP_HEADER)).toBeNull();
    expect(session.seenHeaders?.get(CSP_REPORT_ONLY_HEADER)).toBe(policy);
    expect(forwardedRequestHeader(response, CSP_REPORT_ONLY_HEADER)).toBe(policy);
    expect(forwardedRequestHeader(response, CSP_NONCE_HEADER)).toBe(nonce);
  });

  it("NODE_ENV=development なら 'unsafe-eval' が付く", async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const devPolicy = (await middleware(request('/'))).headers.get(CSP_HEADER) ?? '';
    vi.stubEnv('NODE_ENV', 'production');
    const prodPolicy = (await middleware(request('/'))).headers.get(CSP_HEADER) ?? '';

    expect(cspDirectivesOf(devPolicy).get('script-src')).toContain("'unsafe-eval'");
    expect(cspDirectivesOf(prodPolicy).get('script-src')).not.toContain("'unsafe-eval'");
  });

  it('?mode=app の is_native_app Cookie は今までどおり付く', async () => {
    const appMode = await middleware(request('/home?mode=app'));
    expect(appMode.cookies.get('is_native_app')?.value).toBe('1');
    expect(appMode.headers.get(CSP_HEADER)).not.toBeNull();

    const alreadySet = await middleware(request('/home?mode=app', { cookie: 'is_native_app=1' }));
    expect(alreadySet.cookies.get('is_native_app')).toBeUndefined();

    const browser = await middleware(request('/home'));
    expect(browser.cookies.get('is_native_app')).toBeUndefined();
  });
});
