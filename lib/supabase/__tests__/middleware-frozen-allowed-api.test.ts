/**
 * #1445: 凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)。
 *
 * lib/supabase/middleware.ts は、凍結中の利用者の /api 呼び出しを 403 AUTH_ACCOUNT_FROZEN で止める (#1030)。
 * 退会 (POST /api/account/delete) と書き出し (GET /api/account/export) だけは止めない。
 * billing/01 §9.8: 有料プランの解約の予約と、その前提の 2 つ (契約の要約・Billing Portal) も止めない。
 * 止めない一覧 (src/lib/auth/frozen.ts の FROZEN_ALLOWED_API_PATHS) をここで固定し、
 *   - 一覧のパスは、凍結中でも通る (Cookie と Bearer のどちらでも)
 *   - それ以外の /api は、似たパス (前方一致・末尾の / ・別の /api/account/*) も含めて 403 のまま
 *   - 凍結中でも、退会と書き出しの画面 (/frozen/account) は開け、設定画面 (/settings) は /frozen へ差し戻される
 * を確かめる。
 * #1861: ネイティブ認証ブリッジのコードの発行 (NATIVE_BRIDGE_CODE_API_PATH) も、FROZEN_ALLOWED_API_PATHS とは別の判定
 * (isNativeBridgeCodeApiPath) で凍結中に止めない (モバイルの凍結の画面 = Web の /frozen の WebView を本人のセッションで開くため)。
 * #1871: お問い合わせの送信 (POST /api/contact) も、FROZEN_ALLOWED_API_PATHS とは別の判定 (isFrozenContactSubmitRequest。
 * メソッドまで見る) で凍結中に止めない (凍結の画面の「サポートに問い合わせる」から /contact へ進んだ本人が送れるようにするため)。
 * 同じパスの GET (お問い合わせの履歴) と、ほかのメソッドは 403 のまま。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getSession: mockGetSession, getUser: mockGetUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

// メンテナンスモードは OFF の前提 (DB を読みに行かせない)
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { updateSession } from '../middleware';
import {
  ACCOUNT_DELETE_API_PATH,
  ACCOUNT_EXPORT_API_PATH,
  BILLING_CANCEL_API_PATH,
  BILLING_PORTAL_API_PATH,
  BILLING_SUBSCRIPTION_API_PATH,
  CONTACT_API_PATH,
  CONTACT_SUBMIT_METHOD,
  FAMILY_DISSOLVE_API_PATH,
  FROZEN_ALLOWED_API_PATHS,
  NATIVE_BRIDGE_CODE_API_PATH,
  ORG_DISSOLVE_API_PATH,
  isFrozenAllowedApiPath,
  isFrozenContactSubmitRequest,
  isNativeBridgeCodeApiPath,
} from '@/lib/auth/frozen';
import { stubSupabasePublicEnv } from './supabase-public-env';

/** 一時 BAN の解除予定を「今から 1 日後」にするための長さ */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const FROZEN_PROFILE = { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null, roles: ['user'] };

function request(path: string, init?: { method?: string; headers?: Record<string, string> }) {
  return new NextRequest(new URL(`http://localhost${path}`), init);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubSupabasePublicEnv();
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockMaybeSingle.mockResolvedValue({ data: FROZEN_PROFILE, error: null });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('FROZEN_ALLOWED_API_PATHS (#1445): 凍結中でも止めない API の一覧', () => {
  it('退会・書き出しと、有料プランの解約の 3 本 (契約の要約・解約の予約・Billing Portal) と、家族グループ・組織の解散の 2 本の 7 つだけ (足すときは、本人がサービスから離れるための操作かを確かめてから、このテストも直す)', () => {
    expect([...FROZEN_ALLOWED_API_PATHS]).toEqual([
      '/api/account/delete',
      '/api/account/export',
      '/api/billing/subscription',
      '/api/billing/subscription/cancel',
      '/api/billing/portal',
      '/api/family/dissolve',
      '/api/org/dissolve',
    ]);
    expect(ACCOUNT_DELETE_API_PATH).toBe('/api/account/delete');
    expect(ACCOUNT_EXPORT_API_PATH).toBe('/api/account/export');
    expect(BILLING_SUBSCRIPTION_API_PATH).toBe('/api/billing/subscription');
    expect(BILLING_CANCEL_API_PATH).toBe('/api/billing/subscription/cancel');
    expect(BILLING_PORTAL_API_PATH).toBe('/api/billing/portal');
    expect(FAMILY_DISSOLVE_API_PATH).toBe('/api/family/dissolve');
    expect(ORG_DISSOLVE_API_PATH).toBe('/api/org/dissolve');
  });

  it('一覧のパスには、実際の route がある (route を移したのに一覧だけ古いまま、を防ぐ)', () => {
    for (const path of FROZEN_ALLOWED_API_PATHS) {
      const routeFile = join(process.cwd(), 'src/app', path, 'route.ts');
      expect(existsSync(routeFile), routeFile).toBe(true);
    }
  });

  it('完全一致だけを通す (前方一致・末尾の /・大文字・クエリ付きの文字列は通さない)', () => {
    expect(isFrozenAllowedApiPath('/api/account/delete')).toBe(true);
    expect(isFrozenAllowedApiPath('/api/account/export')).toBe(true);
    expect(isFrozenAllowedApiPath('/api/billing/subscription')).toBe(true);
    expect(isFrozenAllowedApiPath('/api/billing/subscription/cancel')).toBe(true);
    expect(isFrozenAllowedApiPath('/api/billing/portal')).toBe(true);
    for (const path of [
      '/api/account',
      '/api/account/',
      '/api/account/delete/',
      '/api/account/delete/confirm',
      '/api/account/deletex',
      '/api/account/export/extra',
      '/api/Account/delete',
      '/api/account/delete?x=1',
      '/api/export/meals',
      '/api/pantry',
      '/api/billing',
      '/api/billing/subscription/',
      '/api/billing/subscription/resume',
      '/api/billing/subscription/cancel/',
      '/api/billing/checkout',
      '/api/billing/checkout/sync',
      '/api/billing/checkout/preview',
      '/api/billing/portal/',
    ]) {
      expect(isFrozenAllowedApiPath(path), path).toBe(false);
    }
  });
});

describe('updateSession (#1445): 凍結中の利用者の /api', () => {
  it.each([
    ['POST', '/api/account/delete'],
    ['GET', '/api/account/export'],
    ['GET', '/api/billing/subscription'],
    ['POST', '/api/billing/subscription/cancel'],
    ['POST', '/api/billing/portal'],
  ])('%s %s は凍結中でも 403 にせず、route へ通す (Cookie のセッション)', async (method, path) => {
    const res = await updateSession(request(path, { method }));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    // 凍結を判定した上で通している (判定を飛ばしたのではない)
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['POST', '/api/account/delete'],
    ['GET', '/api/account/export'],
    ['GET', '/api/billing/subscription'],
    ['POST', '/api/billing/subscription/cancel'],
    ['POST', '/api/billing/portal'],
  ])('%s %s はモバイルアプリの Bearer のセッションでも、凍結中に通す', async (method, path) => {
    const res = await updateSession(request(path, { method, headers: { authorization: 'Bearer aaa.bbb.ccc' } }));

    expect(res.status).toBe(200);
  });

  it.each([
    '/api/pantry',
    '/api/meals',
    '/api/export/meals',
    '/api/account',
    '/api/account/delete/',
    '/api/account/delete/confirm',
    '/api/account/deletex',
    '/api/account/export/extra',
    '/api/notification-preferences',
    '/api/billing/subscription/resume',
    '/api/billing/checkout',
    '/api/billing/checkout/sync',
    '/api/billing/checkout/preview',
    // #1178 個人情報の請求 (DSR) の本人向けの API は、凍結中は受け付けない (設計 cross/15 S-13・§21。FROZEN_ALLOWED_API_PATHS に足さない)
    '/api/account/data-requests',
    '/api/account/data-requests/00000000-0000-4000-8000-000000000000/withdraw',
  ])('%s は今までどおり 403 AUTH_ACCOUNT_FROZEN', async (path) => {
    const res = await updateSession(request(path));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
    });
  });

  it('一時 BAN の継続中 (unban_at が未来) でも、退会の API は通す', async () => {
    const future = new Date(Date.now() + ONE_DAY_MS).toISOString();
    mockMaybeSingle.mockResolvedValue({ data: { ...FROZEN_PROFILE, unban_at: future }, error: null });

    const res = await updateSession(request('/api/account/delete', { method: 'POST' }));

    expect(res.status).toBe(200);
  });
});

describe('updateSession (#1445): 凍結中の利用者の画面', () => {
  it('退会と書き出しの画面 (/frozen/account) は凍結中でも開ける (/frozen へ差し戻さない)', async () => {
    const res = await updateSession(request('/frozen/account'));

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('設定画面 (/settings) は今までどおり /frozen へ差し戻す (退会と書き出しは /frozen/account から行う)', async () => {
    const res = await updateSession(request('/settings'));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/frozen');
  });
});

describe('#1861: ネイティブ認証ブリッジのコードの発行は、凍結中でも止めない', () => {
  it('パスは /api/auth/native-bridge/code の 1 本で、route が実在する。FROZEN_ALLOWED_API_PATHS には入れない (別の判定)', () => {
    expect(NATIVE_BRIDGE_CODE_API_PATH).toBe('/api/auth/native-bridge/code');
    expect(existsSync(join(process.cwd(), 'src/app', NATIVE_BRIDGE_CODE_API_PATH, 'route.ts'))).toBe(true);
    expect(FROZEN_ALLOWED_API_PATHS).not.toContain(NATIVE_BRIDGE_CODE_API_PATH);
    expect(isNativeBridgeCodeApiPath(NATIVE_BRIDGE_CODE_API_PATH)).toBe(true);
  });

  it('完全一致で判定する (似たパスは当たらない)', () => {
    for (const path of [
      '/api/auth/native-bridge',
      '/api/auth/native-bridge/code/',
      '/api/auth/native-bridge/codex',
      '/api/auth/native-bridge/code/extra',
      '/api/auth/login',
      '/api/auth/session-sync',
      '/api/Auth/native-bridge/code',
    ]) {
      expect(isNativeBridgeCodeApiPath(path), path).toBe(false);
    }
  });

  it('凍結中の Bearer のセッションでも、POST /api/auth/native-bridge/code は route へ通す (凍結は判定した上で通す)', async () => {
    const res = await updateSession(
      request(NATIVE_BRIDGE_CODE_API_PATH, { method: 'POST', headers: { authorization: 'Bearer aaa.bbb.ccc' } }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it.each(['/api/auth/native-bridge/code/', '/api/auth/native-bridge/codex', '/api/auth/session-sync', '/api/legal/status'])(
    '%s は凍結中なら今までどおり 403 AUTH_ACCOUNT_FROZEN (ブリッジの例外は 1 本だけ)',
    async (path) => {
      const res = await updateSession(request(path, { method: 'POST', headers: { authorization: 'Bearer aaa.bbb.ccc' } }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
      });
    },
  );
});

describe('#1871: お問い合わせの送信 (POST /api/contact) は、凍結中でも止めない', () => {
  it('パスは /api/contact・メソッドは POST の 1 組で、route が実在し POST を受ける。FROZEN_ALLOWED_API_PATHS には入れない (別の判定)', () => {
    expect(CONTACT_API_PATH).toBe('/api/contact');
    expect(CONTACT_SUBMIT_METHOD).toBe('POST');
    const routeFile = join(process.cwd(), 'src/app', CONTACT_API_PATH, 'route.ts');
    expect(existsSync(routeFile)).toBe(true);
    expect(readFileSync(routeFile, 'utf8')).toMatch(/^export async function POST\(/m);
    expect(FROZEN_ALLOWED_API_PATHS).not.toContain(CONTACT_API_PATH);
    expect(isFrozenAllowedApiPath(CONTACT_API_PATH)).toBe(false);
    expect(isFrozenContactSubmitRequest('POST', CONTACT_API_PATH)).toBe(true);
  });

  it('パスは完全一致・メソッドは POST だけ (GET の履歴・ほかのメソッド・似たパスは当たらない)', () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post']) {
      expect(isFrozenContactSubmitRequest(method, CONTACT_API_PATH), method).toBe(false);
    }
    for (const path of [
      '/api/contact/',
      '/api/contactx',
      '/api/contact/extra',
      '/api/Contact',
      '/api/contact?x=1',
      '/api/admin/inquiries',
      '/contact',
    ]) {
      expect(isFrozenContactSubmitRequest('POST', path), path).toBe(false);
    }
  });

  it.each([
    ['Cookie', undefined],
    ['Bearer', { authorization: 'Bearer aaa.bbb.ccc' }],
  ])('凍結中の %s のセッションでも、POST /api/contact は route へ通す (凍結は判定した上で通す)', async (_session, headers) => {
    const res = await updateSession(request(CONTACT_API_PATH, { method: 'POST', headers }));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('一時 BAN の継続中 (unban_at が未来) でも、POST /api/contact は通す', async () => {
    const future = new Date(Date.now() + ONE_DAY_MS).toISOString();
    mockMaybeSingle.mockResolvedValue({ data: { ...FROZEN_PROFILE, unban_at: future }, error: null });

    const res = await updateSession(request(CONTACT_API_PATH, { method: 'POST' }));

    expect(res.status).toBe(200);
  });

  it.each([
    ['GET', '/api/contact'],
    ['PUT', '/api/contact'],
    ['PATCH', '/api/contact'],
    ['DELETE', '/api/contact'],
    ['POST', '/api/contact/'],
    ['POST', '/api/contactx'],
    ['POST', '/api/contact/extra'],
    ['POST', '/api/admin/inquiries'],
    ['POST', '/api/pantry'],
  ])('凍結中の %s %s は今までどおり 403 AUTH_ACCOUNT_FROZEN (通すのは送信の 1 組だけ)', async (method, path) => {
    const res = await updateSession(request(path, { method }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
    });
  });
});
