/**
 * #1190 Web の login / callback が、セッションを作る呼び出しの成功の直後にログインの文脈の記録を呼ぶこと
 * (設計 docs/design/cross/16-auth-history-sessions.md §13.5・§20.2)。
 *
 * recordWebLoginContextFromRequest は vi.mock し、呼ぶ所 (login の 1 か所・callback の 3 つの分岐) と渡す値だけを見る。
 * 中身 (claims の読み取り・service_role の UPDATE・warn) は src/lib/auth/__tests__/sessions-web-login-context.test.ts が見る。
 * route のどの 1 か所の呼び出しを消しても、その分岐の it が赤になる (走査 tests/auth/web-login-context-source-scan.test.ts と 2 つの面で見る)。
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLoginFailureStore, type FakeLoginFailureStore } from '../helpers/fake-login-failure-store';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
  adminRpc: vi.fn(),
  recordWebLoginContextFromRequest: vi.fn(async () => undefined),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auth: null as unknown,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}));

vi.mock('@/lib/supabase/server', () => {
  const auth = {
    signInWithPassword: mocks.signInWithPassword,
    exchangeCodeForSession: mocks.exchangeCodeForSession,
    verifyOtp: mocks.verifyOtp,
    getUser: mocks.getUser,
  };
  mocks.auth = auth;
  return {
    createClient: () => ({
      auth,
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }) }),
    }),
    getSupabaseAdmin: () => ({ rpc: mocks.adminRpc }),
  };
});

vi.mock('@/lib/auth/sessions/web-login-context', () => ({
  recordWebLoginContextFromRequest: mocks.recordWebLoginContextFromRequest,
}));

vi.mock('@/lib/auth/turnstile-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/turnstile-verify')>();
  return {
    ...actual,
    verifyTurnstileToken: vi.fn(async () => ({ status: 'disabled' })),
    isTurnstileVerificationEnabled: vi.fn(() => false),
  };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({ ...mocks.logger, withUser: () => mocks.logger }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/auth/login/route';
import { GET } from '@/app/(auth)/auth/callback/route';

const ORIGIN = 'http://localhost:3000';
const SESSION = { access_token: 'access.token', refresh_token: 'refresh.token' };
const USER = { id: 'user-1', email: 'a@example.com' };

let store: FakeLoginFailureStore;
let ipCounter = 0;

function loginRequest(): NextRequest {
  ipCounter += 1;
  return new NextRequest(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-forwarded-for': `198.51.100.${ipCounter}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({ email: 'user@example.com', password: 'Passw0rdSecret' }),
  });
}

async function callback(query: string): Promise<{ location: string; request: Request }> {
  const request = new Request(`${ORIGIN}/auth/callback${query}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  const res = await GET(request);
  const location = res.headers.get('location');
  expect(location, 'リダイレクトする').not.toBeNull();
  const url = new URL(location!);
  return { location: `${url.pathname}${url.search}`, request };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = createFakeLoginFailureStore();
  mocks.adminRpc.mockImplementation((fn: string, args: Record<string, unknown>) => store.client.rpc(fn, args));
  mocks.signInWithPassword.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
  mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
  mocks.verifyOtp.mockResolvedValue({ data: { user: USER, session: SESSION }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: USER }, error: null });
  mocks.maybeSingle.mockResolvedValue({ data: { roles: ['user'], onboarding_completed_at: '2026-10-01T00:00:00Z' }, error: null });
});

describe('POST /api/auth/login', () => {
  it('login: signInWithPassword が error 無しで返ると、recordWebLoginContextFromRequest を supabase.auth・request.headers・その data.session で 1 回呼び、応答は 200 (signed-in)', async () => {
    const request = loginRequest();
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledWith(mocks.auth, request.headers, SESSION);
  });

  it('login: signInWithPassword が error を返すと呼ばない', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    });
    const response = await POST(loginRequest());
    expect(response.status).toBe(401);
    expect(mocks.recordWebLoginContextFromRequest).not.toHaveBeenCalled();
  });
});

describe('GET /auth/callback', () => {
  it('callback: code の exchangeCodeForSession が error 無しで返ると、その data.session で 1 回呼ぶ', async () => {
    const { request } = await callback('?code=abc');
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('abc');
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledWith(mocks.auth, request.headers, SESSION);
  });

  it('callback: token_hash と type の verifyOtp ({ token_hash, type }) が error 無しで返ると、その data.session で 1 回呼ぶ', async () => {
    const { request } = await callback('?token_hash=h1&type=signup');
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h1', type: 'signup' });
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledWith(mocks.auth, request.headers, SESSION);
  });

  it('callback: token と type だけ (token_hash 無し) のフォールバックの verifyOtp ({ token_hash: token, type }) が error 無しで返ると、その data.session で 1 回呼ぶ', async () => {
    const { request } = await callback('?token=t1&type=recovery');
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: 't1', type: 'recovery' });
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledTimes(1);
    expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledWith(mocks.auth, request.headers, SESSION);
  });

  it.each(['?code=abc', '?token_hash=h1&type=signup', '?token=t1&type=recovery'])(
    'callback: 3 つの分岐のどれも、error を返したときは呼ばない (%s)',
    async (query) => {
      const failure = { data: { user: null, session: null }, error: { message: 'expired', status: 403 } };
      mocks.exchangeCodeForSession.mockResolvedValue(failure);
      mocks.verifyOtp.mockResolvedValue(failure);
      await callback(query);
      expect(mocks.recordWebLoginContextFromRequest).not.toHaveBeenCalled();
    },
  );

  it.each(['?code=abc', '?token_hash=h1&type=signup', '?token=t1&type=recovery'])(
    'callback: 3 つの分岐のどれも、呼んだときのリダイレクト先は呼ばないときと同じ (記録が応答を変えない) (%s)',
    async (query) => {
      const withRecord = await callback(query);
      expect(mocks.recordWebLoginContextFromRequest).toHaveBeenCalledTimes(1);
      // セッションの無い成功 (記録の関数は手順 1 で何もせずに返る §13.5) と同じ行き先。どちらもプロフィールで決まる /home
      mocks.recordWebLoginContextFromRequest.mockClear();
      mocks.exchangeCodeForSession.mockResolvedValue({ data: { user: USER, session: null }, error: null });
      mocks.verifyOtp.mockResolvedValue({ data: { user: USER, session: null }, error: null });
      const withoutSession = await callback(query);
      expect(withoutSession.location).toBe(withRecord.location);
      expect(withRecord.location).toBe('/home');
    },
  );
});
