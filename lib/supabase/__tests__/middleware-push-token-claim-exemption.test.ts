/**
 * #1636: 通知のトークンの claim (POST /api/push-tokens/claim) だけを、middleware のメンテナンス・凍結の例外にする。
 *
 * claim は利用者の操作ではなく、端末の後片付け (同じ端末の前の利用者の行を外す) なので、メンテナンス中 (503) や凍結中 (403) に
 * 止めると、前の利用者宛ての通知がこの端末に次の起動まで届き続ける。例外は claim の 1 本だけで、ほかの API に広がらないことを、
 * src/app/api の全 route を実際に middleware (updateSession) に通して確かめる (route を足したときも、この検査が見張る)。
 *   - メンテナンス中 (一般ユーザー): 通るのは、もともと止めない API (死活監視・認証・cron・フラグの取得) と claim だけ
 *   - 凍結中: 通るのは、退会・書き出し (#1445) と claim だけ
 *   - release (セッション無しの後片付け) や似たパス (末尾の / ・前方一致) は止まったまま
 *   - 規約の同意ゲート (#1689。LEGAL_CONSENT_ENFORCE=on) でも claim は止めない (同意の許可リスト LEGAL_CONSENT_EXEMPT_API_PATHS に
 *     claim の行がある)。凍結中・メンテナンス中は同意の画面に進めないので、止めると上の例外が意味を失う
 *
 * 規約の同意ゲートの環境の値に左右されないように、既定は LEGAL_CONSENT_ENFORCE を未設定にする (vi.stubEnv。#1435 の流儀)。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string, _options?: unknown) => false);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string, options?: unknown) => mockIsFeatureEnabled(key, userId, options),
}));

import { updateSession } from '../middleware';
import { PUSH_TOKEN_CLAIM_API_PATH, isPushTokenClaimApiPath } from '@/lib/push-tokens';
import { CONTACT_API_PATH } from '@/lib/auth/frozen';
import { LEGAL_CONSENT_REQUIRED_CODE, PUSH_TOKEN_RELEASE_API_PATH } from '@homegohan/shared';
import { stubSupabasePublicEnv } from './supabase-public-env';

const API_ROOT = join(process.cwd(), 'src/app/api');
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_FORBIDDEN = 403;
const HTTP_OK = 200;
const FROZEN_AT = '2026-07-01T00:00:00.000Z';

/** 規約の同意の列まで持つプロフィール (未同意 = どちらも NULL)。同意ゲートを効かせる検査で使う */
function unconsentedProfile(overrides: { frozen_at?: string | null } = {}) {
  return {
    data: {
      roles: ['user'],
      frozen_at: null,
      unban_at: null,
      terms_version_accepted: null,
      privacy_version_accepted: null,
      ...overrides,
    },
    error: null,
  };
}

function postRequest(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: 'POST',
    headers: { authorization: 'Bearer header.payload.signature' },
  });
}

/** src/app/api の route.ts から、URL のパスを作る (動的な区切り [x]・[...x]・[[...x]] は仮の値、(グループ) は外す) */
function apiRoutePaths(): string[] {
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'route.ts') {
        const segments = relative(API_ROOT, dir)
          .split(sep)
          .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
          .map((segment) => (/^\[.*\]$/.test(segment) ? 'sample-id' : segment));
        paths.push(['/api', ...segments].join('/'));
      }
    }
  };
  walk(API_ROOT);
  return paths.sort();
}

/**
 * claim のほかにメンテナンス中でも止めない API (src/lib/maintenance-mode.ts の isMaintenanceExemptPath)。
 * #1636 より前からのものと、Resend の Webhook の受け口 (#1577 の 4。完全一致の 1 本)
 */
function isPreexistingMaintenanceExemptApi(path: string): boolean {
  return (
    path === '/api/health' ||
    path.startsWith('/api/auth/') ||
    path.startsWith('/api/cron/') ||
    path === '/api/feature-flags' ||
    path === '/api/webhooks/resend'
  );
}

async function passes(path: string, expectedBlockStatus: number): Promise<boolean> {
  const res = await updateSession(
    new NextRequest(new URL(`http://localhost${path}`), {
      method: 'POST',
      headers: { authorization: 'Bearer header.payload.signature' },
    }),
  );
  if (res.status === expectedBlockStatus) return false;
  // 止めない側は、middleware がそのまま次へ渡す (NextResponse.next の 200)
  expect(res.status, `${path} は ${expectedBlockStatus} か、次へ渡すかのどちらか`).toBe(200);
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  stubSupabasePublicEnv();
  // 規約の同意ゲートは既定で未設定 (= 止めない)。開発者のシェルや CI の値に左右されないように vi.stubEnv で作る
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', undefined);
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockMaybeSingle.mockResolvedValue({ data: { roles: ['user'], frozen_at: null, unban_at: null }, error: null });
  mockIsFeatureEnabled.mockResolvedValue(false);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('claim の例外は 1 本だけ (#1636)', () => {
  it('claim の route が実在し、例外の判定は完全一致だけ', () => {
    expect(existsSync(join(API_ROOT, 'push-tokens/claim/route.ts'))).toBe(true);
    expect(PUSH_TOKEN_CLAIM_API_PATH).toBe('/api/push-tokens/claim');
    expect(isPushTokenClaimApiPath('/api/push-tokens/claim')).toBe(true);
    for (const path of [
      '/api/push-tokens/claim/',
      '/api/push-tokens/claimx',
      '/api/push-tokens/claim/x',
      '/api/push-tokens',
      PUSH_TOKEN_RELEASE_API_PATH,
      '/API/push-tokens/claim',
      '/api/push-tokens/claim?x=1',
    ]) {
      expect(isPushTokenClaimApiPath(path), path).toBe(false);
    }
  });

  it('メンテナンス中: 全 route のうち、新しく通るのは claim だけ (ほかの API は 503 のまま)', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const routes = apiRoutePaths();
    // 番兵: route の読み取りが壊れて何も拾わなくなったときに、検査が素通りしないように
    expect(routes).toContain(PUSH_TOKEN_CLAIM_API_PATH);
    expect(routes).toContain(PUSH_TOKEN_RELEASE_API_PATH);
    expect(routes).toContain('/api/pantry');

    const passed: string[] = [];
    for (const path of routes) {
      if (await passes(path, HTTP_SERVICE_UNAVAILABLE)) passed.push(path);
    }

    expect(passed.filter((path) => !isPreexistingMaintenanceExemptApi(path))).toEqual([PUSH_TOKEN_CLAIM_API_PATH]);
    expect(passed).not.toContain(PUSH_TOKEN_RELEASE_API_PATH);
  });

  it('凍結中: 全 route のうち、通るのは退会・書き出し (#1445)・有料プランの解約の 3 本 (billing/01 §9.8) と claim とネイティブ認証ブリッジのコード (#1861) とお問い合わせの送信 (#1871) だけ (ほかの API は 403 のまま)', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { roles: ['user'], frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null },
      error: null,
    });
    const passed: string[] = [];
    for (const path of apiRoutePaths()) {
      if (await passes(path, HTTP_FORBIDDEN)) passed.push(path);
    }

    // billing/01 §9.8: 凍結中も通す有料プランの解約の 3 本 (契約の要約・解約の予約・Billing Portal) も通る
    expect(passed).toEqual(
      [
        '/api/account/delete',
        '/api/account/export',
        '/api/billing/subscription',
        '/api/billing/subscription/cancel',
        '/api/billing/portal',
        PUSH_TOKEN_CLAIM_API_PATH,
        // #1861: モバイルの凍結の画面 (Web の /frozen の WebView) を本人のセッションで開くため (src/lib/auth/frozen.ts の isNativeBridgeCodeApiPath)
        '/api/auth/native-bridge/code',
        // #1871: お問い合わせの送信 (POST /api/contact。src/lib/auth/frozen.ts の isFrozenContactSubmitRequest。ここは全 route を POST で通す)
        CONTACT_API_PATH,
      ].sort(),
    );
  });

  it('メンテナンス中かつ凍結中でも claim は通り、似たパスと release は止まる', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValue({
      data: { roles: ['user'], frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null },
      error: null,
    });

    const claim = await updateSession(new NextRequest(new URL(`http://localhost${PUSH_TOKEN_CLAIM_API_PATH}`), { method: 'POST' }));
    expect(claim.status).toBe(200);

    for (const path of ['/api/push-tokens/claimx', '/api/push-tokens/claim/x', PUSH_TOKEN_RELEASE_API_PATH]) {
      const res = await updateSession(new NextRequest(new URL(`http://localhost${path}`), { method: 'POST' }));
      // 凍結の判定 (403) が先に返る
      expect(res.status, path).toBe(HTTP_FORBIDDEN);
    }
  });

  it('未ログインの release はメンテナンス中は 503 (例外は claim だけ。アプリは次の起動でやり直す)', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const release = await updateSession(new NextRequest(new URL(`http://localhost${PUSH_TOKEN_RELEASE_API_PATH}`), { method: 'POST' }));
    expect(release.status).toBe(HTTP_SERVICE_UNAVAILABLE);

    // 未ログインの claim も middleware は通す (route が 401 で断る)
    const claim = await updateSession(new NextRequest(new URL(`http://localhost${PUSH_TOKEN_CLAIM_API_PATH}`), { method: 'POST' }));
    expect(claim.status).toBe(200);
  });
});

describe('規約の同意ゲート (#1689) でも claim は止めない (#1636)', () => {
  beforeEach(() => {
    vi.stubEnv('LEGAL_CONSENT_ENFORCE', 'on');
  });

  it.each([
    ['凍結なし・メンテナンスなし', null, false],
    ['凍結中', FROZEN_AT, false],
    ['メンテナンス中', null, true],
    ['凍結中かつメンテナンス中', FROZEN_AT, true],
  ] as const)('ENFORCE=on × 未同意 × %s: claim は通る', async (_name, frozenAt, maintenance) => {
    mockIsFeatureEnabled.mockResolvedValue(maintenance);
    mockMaybeSingle.mockResolvedValue(unconsentedProfile({ frozen_at: frozenAt }));

    const claim = await updateSession(postRequest(PUSH_TOKEN_CLAIM_API_PATH));

    expect(claim.status).toBe(HTTP_OK);
  });

  it('ENFORCE=on × 未同意 (凍結なし): release と似たパスは同意の 403 で止まる (許可リストは claim の完全一致だけ)', async () => {
    mockMaybeSingle.mockResolvedValue(unconsentedProfile());

    for (const path of [PUSH_TOKEN_RELEASE_API_PATH, '/api/push-tokens/claimx', '/api/push-tokens/claim/x', '/api/pantry']) {
      const res = await updateSession(postRequest(path));
      expect(res.status, path).toBe(HTTP_FORBIDDEN);
      expect(((await res.json()) as { code?: string }).code, path).toBe(LEGAL_CONSENT_REQUIRED_CODE);
    }
  });

  it('ENFORCE=on × 未同意 × 凍結中: 全 route のうち、通るのは退会・書き出し・有料プランの解約の 3 本と claim とネイティブ認証ブリッジのコード (#1861) とお問い合わせの送信 (#1871) だけ (同意の 403 は出ない)', async () => {
    mockMaybeSingle.mockResolvedValue(unconsentedProfile({ frozen_at: FROZEN_AT }));

    const passed: string[] = [];
    for (const path of apiRoutePaths()) {
      const res = await updateSession(postRequest(path));
      if (res.status === HTTP_OK) {
        passed.push(path);
        continue;
      }
      expect(res.status, path).toBe(HTTP_FORBIDDEN);
      // 凍結の 403 (AUTH_ACCOUNT_FROZEN) で、同意の 403 ではない
      expect(((await res.json()) as { error?: { code?: string } }).error?.code, path).toBe('AUTH_ACCOUNT_FROZEN');
    }

    // billing/01 §9.8: 凍結中も通す有料プランの解約の 3 本 (契約の要約・解約の予約・Billing Portal) も通る
    expect(passed).toEqual(
      [
        '/api/account/delete',
        '/api/account/export',
        '/api/billing/subscription',
        '/api/billing/subscription/cancel',
        '/api/billing/portal',
        PUSH_TOKEN_CLAIM_API_PATH,
        '/api/auth/native-bridge/code',
        CONTACT_API_PATH,
      ].sort(),
    );
  });

  it('ENFORCE=on × 未同意 × メンテナンス中: 全 route のうち、新しく通るのは claim だけ (ほかは 503 のまま。同意の 403 は出ない)', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValue(unconsentedProfile());

    const passed: string[] = [];
    for (const path of apiRoutePaths()) {
      if (await passes(path, HTTP_SERVICE_UNAVAILABLE)) passed.push(path);
    }

    expect(passed.filter((path) => !isPreexistingMaintenanceExemptApi(path))).toEqual([PUSH_TOKEN_CLAIM_API_PATH]);
  });
});
