/**
 * lib/supabase/middleware.ts の /api の同意ゲート (#1442) のユニットテスト
 * (設計書 docs/design/cross/13a-legal-consent-api-server.md §6.13・§6.14 C)
 *
 * LEGAL_CONSENT_ENFORCE=on のとき、いま有効な版に同意していない (未同意・旧版・行なし) サインイン中の利用者の /api 呼び出しを、
 * 許可リスト (packages/shared の LEGAL_CONSENT_EXEMPT_API_PATHS) 以外は 403 { error, code: 'LEGAL_CONSENT_REQUIRED' } で止める。
 * 判定の順は 凍結 (403 AUTH_ACCOUNT_FROZEN) → メンテナンス (503) → 同意。
 *
 * 見張り (§6.13):
 *   1. src/app/api の全 route を列挙し、未同意 × ENFORCE=on で updateSession を 1 本ずつ通す (route を足せば自動で表に入る)
 *   2. 許可リストの各行は実在する route に当たる
 *   3. 許可リストの中身を固定する
 *   4. 許可リストは、凍結中・メンテナンス中に middleware が通す /api (FROZEN_ALLOWED_API_PATHS・通知のトークンの claim (#1636)・
 *      isMaintenanceExemptPath) をすべて含む (判定の関数での包含と、全 route を middleware に通したときに同意の 403 が出ないこと)
 *   5. src/proxy.ts の matcher が /api で外すのは api/health$ だけ
 * 限界 (見ないもの): アプリが Supabase を直接読む経路・Edge Functions を直接呼ぶ経路・/api の外の route handler・
 *   route の中の分岐 (動的な区間は固定の値で置き換える)・本番の LEGAL_CONSENT_ENFORCE の実値 (§6.13 の限界の表)。
 *
 * 画面の同意ゲート (#1174) は middleware-legal-consent.test.ts。モックはそれと同型。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  LEGAL_CONSENT_EXEMPT_API_PATHS,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  LEGAL_DOCUMENTS,
  isLegalConsentExemptApiPath,
  isLegalConsentRequiredBody,
  PUSH_TOKEN_RELEASE_API_PATH,
} from '@homegohan/shared';
import { LegalConsentRequiredBodySchema } from '@/lib/legal-consent-api';
import { FROZEN_ALLOWED_API_PATHS, isFrozenAllowedApiPath } from '@/lib/auth/frozen';
import { PUSH_TOKEN_CLAIM_API_PATH, isPushTokenClaimApiPath } from '@/lib/push-tokens';
import { isMaintenanceExemptPath } from '@/lib/maintenance-mode';
import { listRouteFiles } from '../../../tests/helpers/ai-reach';

// ─────────────────────────────────────────────────────────────────────────────
// @supabase/ssr の createServerClient モック (middleware-legal-consent.test.ts と同型)
// ─────────────────────────────────────────────────────────────────────────────

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn();
const mockCreateServerClient = vi.fn();

mockCreateServerClient.mockImplementation(() => ({
  auth: {
    getSession: mockGetSession,
    getUser: mockGetUser,
  },
  from: (_table: string) => ({
    select: (columns?: string) => {
      mockSelect(columns);
      return {
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      };
    },
  }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

// #1148: メンテナンスモードのフラグ。既定は OFF (テストごとに ON を差し込む)
const mockIsFeatureEnabled = vi.fn(async (_key: string, _userId?: string, _options?: unknown) => false);
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: (key: string, userId?: string, options?: unknown) => mockIsFeatureEnabled(key, userId, options),
}));

import { updateSession } from '../middleware';
import { config } from '@/proxy';
import { stubSupabasePublicEnv } from './supabase-public-env';

const PROFILE_COLUMNS_WITH_LEGAL =
  'roles, onboarding_started_at, onboarding_completed_at, frozen_at, unban_at, terms_version_accepted, privacy_version_accepted';
const PROFILE_COLUMNS_WITHOUT_LEGAL = 'roles, onboarding_started_at, onboarding_completed_at, frozen_at, unban_at';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const OLD_VERSION = 'v0-old';
const FROZEN_AT = '2026-07-01T00:00:00.000Z';

const ACCEPTED_CURRENT = { terms: CURRENT_TERMS, privacy: CURRENT_PRIVACY };
const NOT_ACCEPTED = { terms: null, privacy: null };

/** 動的な区間 ([id] など) を置き換える固定の値 (middleware は path だけで決めるので、値は何でもよい) */
const DYNAMIC_SEGMENT_SAMPLE = 'sample-id';

function apiRequest(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(`http://localhost${path}`), init);
}

function consentProfile(
  accepted: { terms: string | null; privacy: string | null } | 'columns-missing',
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      roles: [],
      onboarding_started_at: '2026-03-01T00:00:00.000Z',
      onboarding_completed_at: '2026-03-01T01:00:00.000Z',
      frozen_at: null,
      unban_at: null,
      ...(accepted === 'columns-missing'
        ? {}
        : { terms_version_accepted: accepted.terms, privacy_version_accepted: accepted.privacy }),
      ...overrides,
    },
    error: null,
  };
}

/** getUser() がトークンを更新したとき (createServerClient の cookies.set が呼ばれる) を再現する */
function mockGetUserRefreshingToken() {
  mockGetUser.mockImplementation(async () => {
    const options = mockCreateServerClient.mock.calls.at(-1)?.[2];
    options.cookies.set('sb-test-auth-token', 'refreshed-token', { path: '/' });
    return { data: { user: { id: 'user-1' } }, error: null };
  });
}

function setUp(enforce: string | undefined) {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // updateSession は Supabase の URL・anon キーが無いと汎用の 500 で止まる (#1182)。unstubAllEnvs で消えるので入れ直す
  stubSupabasePublicEnv();
  // 未設定 (undefined) も vi.stubEnv で作る (#1435)
  vi.stubEnv('LEGAL_CONSENT_ENFORCE', enforce);
  vi.stubEnv('LEGAL_CONSENT_NOTICE', undefined);
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mockIsFeatureEnabled.mockReset();
  mockIsFeatureEnabled.mockResolvedValue(false);
}

/** 同意ゲートの 403 (LEGAL_CONSENT_REQUIRED) か。凍結の 403 (AUTH_ACCOUNT_FROZEN) とは本文の code で見分ける */
async function isLegalConsentDenied(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body: unknown = await res.clone().json();
  return isLegalConsentRequiredBody(body);
}

async function expectLegalConsentRequired(res: Response) {
  expect(res.status).toBe(403);
  const body: unknown = await res.json();
  expect(body).toEqual({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });
}

/** src/app/api/<...>/route.ts → /api/<...> (動的な区間は固定の値に置き換える) */
function routeFileToApiPath(file: string): string {
  const dir = file.replace(/^src\/app/, '').replace(/\/route\.tsx?$/, '');
  return dir
    .split('/')
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.*\]$/.test(segment) ? DYNAMIC_SEGMENT_SAMPLE : segment))
    .join('/');
}

/** src/app/api の全 route (ファイルと、middleware に通す path) */
const API_ROUTES = listRouteFiles()
  .filter((file) => file.startsWith('src/app/api/'))
  .map((file) => ({ file, path: routeFileToApiPath(file) }));

/** 許可リストの行が当たる route の path (動的な区間は置き換える前の形で比べる) */
function routeDirsOf(): string[] {
  return listRouteFiles()
    .filter((file) => file.startsWith('src/app/api/'))
    .map((file) => file.replace(/^src\/app/, '').replace(/\/route\.tsx?$/, ''));
}

/**
 * Next.js は matcher を path-to-regexp で正規表現に変換する。この matcher は
 * `/(<否定先読みつきの正規表現>)` の 1 グループだけなので、前後を ^ $ で挟めば同じ判定になる (tests/health-middleware-exemption.test.ts と同じ読み方)
 */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

describe('updateSession — /api の同意ゲート (#1442): 全 route の表 (見張り)', () => {
  beforeEach(() => setUp('on'));
  afterEach(() => vi.unstubAllEnvs());

  it('src/app/api の route を 1 本以上列挙できる (走査の道が変わって空の表で緑にならない)', () => {
    expect(API_ROUTES.length).toBeGreaterThan(0);
    // 許可リストに当たる route と当たらない route の両方がある
    expect(API_ROUTES.some((route) => isLegalConsentExemptApiPath(route.path))).toBe(true);
    expect(API_ROUTES.some((route) => !isLegalConsentExemptApiPath(route.path))).toBe(true);
  });

  it.each(API_ROUTES.map((route) => [route.path, route.file] as const))(
    `src/app/api の全 route (${API_ROUTES.length} 本) を 未同意 × ENFORCE=on で通すと、許可リストの route だけが 403 にならず、それ以外は 403 LEGAL_CONSENT_REQUIRED — %s`,
    async (path) => {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

      const res = await updateSession(apiRequest(path));

      if (isLegalConsentExemptApiPath(path)) {
        expect(res.status, `${path} は許可リストなので止めない`).toBe(200);
      } else {
        await expectLegalConsentRequired(res);
      }
    },
  );

  it('許可リストの各行は実在する route に当たる (prefix の行は 1 本以上)', () => {
    const dirs = routeDirsOf();
    for (const entry of LEGAL_CONSENT_EXEMPT_API_PATHS) {
      const hits =
        entry.match === 'exact'
          ? dirs.filter((dir) => dir === entry.path)
          : dirs.filter((dir) => dir === entry.path || dir.startsWith(`${entry.path}/`));
      expect(hits.length, `${entry.path} (${entry.match}) が実在する route に当たる`).toBeGreaterThanOrEqual(1);
      if (entry.match === 'exact') expect(hits, `${entry.path} はちょうど 1 本`).toHaveLength(1);
    }
  });

  it('許可リストの中身 (path / match / reason) は設計書 13a §6.4 のとおり (スナップショット)', () => {
    // 足すときは、このテストと設計書 13a §6.4 の表を一緒に直す。利用者のデータを読み書きする API は足さない
    expect(LEGAL_CONSENT_EXEMPT_API_PATHS.map(({ path, match, reason }) => ({ path, match, reason }))).toEqual([
      { path: '/api/legal/accept', match: 'exact', reason: 'consent_itself' },
      { path: '/api/legal/status', match: 'exact', reason: 'consent_itself' },
      { path: '/api/auth', match: 'prefix', reason: 'auth_flow' },
      { path: '/api/account/delete', match: 'exact', reason: 'leave_service' },
      { path: '/api/account/export', match: 'exact', reason: 'leave_service' },
      { path: '/api/billing/subscription', match: 'exact', reason: 'leave_service' },
      { path: '/api/billing/subscription/cancel', match: 'exact', reason: 'leave_service' },
      { path: '/api/billing/portal', match: 'exact', reason: 'leave_service' },
      { path: '/api/push-tokens/claim', match: 'exact', reason: 'device_cleanup' },
      { path: '/api/contact', match: 'exact', reason: 'contact' },
      { path: '/api/log', match: 'exact', reason: 'telemetry' },
      { path: '/api/csp-report', match: 'exact', reason: 'telemetry' },
      { path: '/api/feature-flags', match: 'exact', reason: 'client_status' },
      { path: '/api/health', match: 'exact', reason: 'no_user_session' },
      { path: '/api/cron', match: 'prefix', reason: 'no_user_session' },
      { path: '/api/webhooks', match: 'prefix', reason: 'no_user_session' },
      { path: '/api/e2e', match: 'prefix', reason: 'test_only' },
    ]);
    for (const entry of LEGAL_CONSENT_EXEMPT_API_PATHS) {
      expect(entry.note.length, `${entry.path} の理由の文`).toBeGreaterThan(0);
    }
  });

  it('許可リストは、凍結の判定で通るパス (FROZEN_ALLOWED_API_PATHS + 通知のトークンの claim) をすべて exact の行で含む', () => {
    // middleware の凍結の分岐が通すのは isFrozenAllowedApiPath と isPushTokenClaimApiPath (#1636) の 2 つ。
    // 凍結中は同意の画面に進めないので、ここで通したパスを同意ゲートで止めると、凍結の例外が意味を失う
    const frozenPassed = [...FROZEN_ALLOWED_API_PATHS, PUSH_TOKEN_CLAIM_API_PATH];
    expect(FROZEN_ALLOWED_API_PATHS.length).toBeGreaterThan(0);
    for (const path of frozenPassed) {
      expect(isFrozenAllowedApiPath(path) || isPushTokenClaimApiPath(path), `${path} は凍結の判定で通る`).toBe(true);
      expect(isLegalConsentExemptApiPath(path), path).toBe(true);
      expect(LEGAL_CONSENT_EXEMPT_API_PATHS.some((entry) => entry.path === path && entry.match === 'exact'), path).toBe(true);
    }
    // 全 route で: 凍結の判定で通る route は、すべて同意の許可リストにある (凍結の一覧に足したときの漏れを見張る)
    const frozenPassedRoutes = API_ROUTES.filter((route) => isFrozenAllowedApiPath(route.path) || isPushTokenClaimApiPath(route.path));
    expect(frozenPassedRoutes.map((route) => route.path).sort()).toEqual([...frozenPassed].sort());
    for (const route of frozenPassedRoutes) {
      expect(isLegalConsentExemptApiPath(route.path), route.path).toBe(true);
    }
  });

  it('許可リストは、メンテナンス中に通す /api (isMaintenanceExemptPath) をすべて含む (全 route)', () => {
    // メンテナンス中は同意の画面 (/api/legal/accept) も 503 で止まるので、ここで通したパスを同意ゲートで止めると例外が意味を失う
    const maintenancePassed = API_ROUTES.filter((route) => isMaintenanceExemptPath(route.path));
    // 番兵: 判定の関数が何も通さなくなって、空の表で緑にならないように
    expect(maintenancePassed.map((route) => route.path)).toContain(PUSH_TOKEN_CLAIM_API_PATH);
    expect(maintenancePassed.map((route) => route.path)).toContain('/api/feature-flags');
    for (const route of maintenancePassed) {
      expect(isLegalConsentExemptApiPath(route.path), route.path).toBe(true);
    }
  });

  it('全 route を 未同意 × ENFORCE=on × 凍結中 で通すと、同意の 403 は 1 本も出ない (凍結の 403 か、通すかのどちらか)。claim と退会・書き出しは通る', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { frozen_at: FROZEN_AT }));

    const consentDenied: string[] = [];
    const passed: string[] = [];
    for (const route of API_ROUTES) {
      const res = await updateSession(apiRequest(route.path, { method: 'POST' }));
      if (await isLegalConsentDenied(res)) consentDenied.push(route.path);
      else if (res.status === 200) passed.push(route.path);
    }

    expect(consentDenied).toEqual([]);
    expect(passed.sort()).toEqual([...FROZEN_ALLOWED_API_PATHS, PUSH_TOKEN_CLAIM_API_PATH].sort());
  });

  it('全 route を 未同意 × ENFORCE=on × メンテナンス中 (一般の利用者) で通すと、同意の 403 は 1 本も出ない (503 か、通すかのどちらか)。claim は通る', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { roles: ['user'] }));

    const consentDenied: string[] = [];
    const passed: string[] = [];
    for (const route of API_ROUTES) {
      const res = await updateSession(apiRequest(route.path, { method: 'POST' }));
      if (await isLegalConsentDenied(res)) consentDenied.push(route.path);
      else if (res.status === 200) passed.push(route.path);
    }

    expect(consentDenied).toEqual([]);
    expect(passed).toContain(PUSH_TOKEN_CLAIM_API_PATH);
    expect(passed).not.toContain(PUSH_TOKEN_RELEASE_API_PATH);
  });

  it('通知のトークンの claim は 未同意 × ENFORCE=on でも止めない (端末の後片付け #1636)。release と似た名前は止める', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const claim = await updateSession(apiRequest(PUSH_TOKEN_CLAIM_API_PATH, { method: 'POST' }));
    expect(claim.status).toBe(200);

    for (const path of [PUSH_TOKEN_RELEASE_API_PATH, '/api/push-tokens/claimx', '/api/push-tokens/claim/x']) {
      await expectLegalConsentRequired(await updateSession(apiRequest(path, { method: 'POST' })));
    }
  });

  it('src/proxy.ts の matcher が /api で外すのは api/health$ だけ', () => {
    expect(runsMiddleware('/api/health')).toBe(false);
    const skipped = API_ROUTES.filter((route) => !runsMiddleware(route.path)).map((route) => route.path);
    expect(skipped).toEqual(['/api/health']);
  });
});

describe('updateSession — /api の同意ゲート (#1442): 同意の状態と ENFORCE', () => {
  beforeEach(() => setUp('on'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['旧版に同意 (利用規約)', { terms: OLD_VERSION, privacy: CURRENT_PRIVACY }],
    ['旧版に同意 (プライバシーポリシー)', { terms: CURRENT_TERMS, privacy: OLD_VERSION }],
    ['片方だけ同意', { terms: CURRENT_TERMS, privacy: null }],
    ['未同意 (NULL)', NOT_ACCEPTED],
  ])('旧版に同意 / 片方だけ同意 / 行なし も 403。現行の版に両方同意していれば 200 — %s', async (_name, accepted) => {
    mockMaybeSingle.mockResolvedValue(consentProfile(accepted));
    await expectLegalConsentRequired(await updateSession(apiRequest('/api/meals')));

    // 行なし (新規登録の直後)
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expectLegalConsentRequired(await updateSession(apiRequest('/api/meals')));

    mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT));
    const ok = await updateSession(apiRequest('/api/meals'));
    expect(ok.status).toBe(200);
  });

  it.each([
    ['off', 'off'],
    ['未設定', undefined],
    ['空', ''],
    ['on 以外の値 (true)', 'true'],
    ['on 以外の値 (1)', '1'],
  ])('ENFORCE が off / 未設定 / on 以外の値 なら、未同意でも 200 (許可リスト外でも) — %s', async (_name, value) => {
    setUp(value);
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    for (const path of ['/api/meals', '/api/admin/users', '/api/onboarding/status', '/api/legal/accept']) {
      const res = await updateSession(apiRequest(path));
      expect(res.status, path).toBe(200);
    }
  });

  it('user_profiles の読み取りが失敗したら、未同意相当でも素通り (凍結と同じ fail-open)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { code: 'PGRST301', message: 'jwt expired' } });

    const res = await updateSession(apiRequest('/api/meals'));

    expect(res.status).toBe(200);
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('列が無い DB (42703) では列を除いた select でやり直し、同意ゲートだけ素通り (凍結・メンテナンスは効く)', async () => {
    const columnMissing = {
      data: null,
      error: { code: '42703', message: 'column user_profiles.terms_version_accepted does not exist' },
    };

    // 同意ゲートは素通り
    mockMaybeSingle.mockResolvedValueOnce(columnMissing).mockResolvedValueOnce(consentProfile('columns-missing'));
    const passed = await updateSession(apiRequest('/api/meals'));
    expect(passed.status).toBe(200);
    expect(mockSelect.mock.calls.map((call) => call[0])).toEqual([PROFILE_COLUMNS_WITH_LEGAL, PROFILE_COLUMNS_WITHOUT_LEGAL]);

    // 凍結は効く
    mockMaybeSingle
      .mockResolvedValueOnce(columnMissing)
      .mockResolvedValueOnce(consentProfile('columns-missing', { frozen_at: FROZEN_AT }));
    const frozen = await updateSession(apiRequest('/api/meals'));
    expect(frozen.status).toBe(403);
    expect(await frozen.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } });

    // メンテナンスは効く
    mockIsFeatureEnabled.mockResolvedValue(true);
    mockMaybeSingle.mockResolvedValueOnce(columnMissing).mockResolvedValueOnce(consentProfile('columns-missing'));
    const maintenance = await updateSession(apiRequest('/api/meals'));
    expect(maintenance.status).toBe(503);
    expect(((await maintenance.json()) as { code?: string }).code).toBe('MAINTENANCE_MODE');
  });

  it('未ログイン (user null) と getUser の失敗は判定に来ない (route の 401 に委ねる)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await updateSession(apiRequest('/api/meals'))).status).toBe(200);

    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid jwt' } });
    expect((await updateSession(apiRequest('/api/meals'))).status).toBe(200);

    mockGetUser.mockRejectedValue(new Error('network down'));
    expect((await updateSession(apiRequest('/api/meals'))).status).toBe(200);

    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });
});

describe('updateSession — /api の同意ゲート (#1442): 403 の形・順序・経路', () => {
  beforeEach(() => setUp('on'));
  afterEach(() => vi.unstubAllEnvs());

  it('403 の本文は { error, code } の 2 キーだけで LegalConsentRequiredBodySchema を通り、Cache-Control は private, no-store。トークン更新で溜まったセッション Cookie を引き継ぐ', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));
    mockGetUserRefreshingToken();

    const res = await updateSession(apiRequest('/api/meals'));

    expect(res.status).toBe(403);
    const body: unknown = await res.json();
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(['code', 'error']);
    expect(LegalConsentRequiredBodySchema.safeParse(body).success).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('set-cookie') ?? '').toContain('sb-test-auth-token=refreshed-token');
    expect(res.headers.get('location')).toBeNull();
  });

  it('凍結が先: 凍結中かつ未同意は 403 AUTH_ACCOUNT_FROZEN (同意の 403 ではない)。凍結中でも通す 2 本と claim は未同意でも通る', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { frozen_at: FROZEN_AT }));

    const frozen = await updateSession(apiRequest('/api/meals'));
    expect(frozen.status).toBe(403);
    expect(await frozen.json()).toEqual({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' } });

    for (const path of [...FROZEN_ALLOWED_API_PATHS, PUSH_TOKEN_CLAIM_API_PATH]) {
      const res = await updateSession(apiRequest(path));
      expect(res.status, path).toBe(200);
    }
  });

  it('メンテナンス中が先: 運営以外の未同意は 503 MAINTENANCE_MODE。運営はメンテナンスを通った後に同意の判定を受ける', async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);

    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { roles: ['user'] }));
    const user = await updateSession(apiRequest('/api/meals'));
    expect(user.status).toBe(503);
    expect(((await user.json()) as { code?: string }).code).toBe('MAINTENANCE_MODE');

    for (const role of ['admin', 'super_admin']) {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED, { roles: [role] }));
      await expectLegalConsentRequired(await updateSession(apiRequest('/api/admin/users')));

      mockMaybeSingle.mockResolvedValue(consentProfile(ACCEPTED_CURRENT, { roles: [role] }));
      expect((await updateSession(apiRequest('/api/admin/users'))).status, role).toBe(200);
    }
  });

  it('Bearer (JWT 形式) のモバイルのセッションでも同じ判定。非 JWT の Bearer (CRON_SECRET) は判定に来ない', async () => {
    // 実際の Supabase クライアントと同じく、Authorization を転送されたときだけ本人が分かる
    mockGetUser.mockImplementation(async () => {
      const options = mockCreateServerClient.mock.calls.at(-1)?.[2];
      return options?.global ? { data: { user: { id: 'user-1' } }, error: null } : { data: { user: null }, error: null };
    });
    mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

    const jwt = await updateSession(apiRequest('/api/meals', { headers: { authorization: 'Bearer aaa.bbb.ccc' } }));
    await expectLegalConsentRequired(jwt);
    expect(mockCreateServerClient.mock.calls.at(-1)?.[2].global).toEqual({ headers: { Authorization: 'Bearer aaa.bbb.ccc' } });

    mockMaybeSingle.mockClear();
    for (const path of ['/api/cron/process-menu-queue', '/api/meals']) {
      const res = await updateSession(apiRequest(path, { headers: { authorization: 'Bearer this-is-not-a-jwt-cron-secret' } }));
      expect(res.status, path).toBe(200);
      expect(mockCreateServerClient.mock.calls.at(-1)?.[2].global).toBeUndefined();
    }
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])(
    'GET / HEAD / POST / PUT / PATCH / DELETE のどのメソッドでも 403 (API は画面と違って POST も止める) — %s',
    async (method) => {
      mockMaybeSingle.mockResolvedValue(consentProfile(NOT_ACCEPTED));

      const res = await updateSession(apiRequest('/api/meals', { method }));

      expect(res.status).toBe(403);
      if (method !== 'HEAD') {
        expect(await res.json()).toEqual({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });
      }
    },
  );

  it('/api の分岐の select は PROFILE_COLUMNS_WITH_LEGAL の 1 回だけ (クエリを増やさない)', async () => {
    for (const accepted of [NOT_ACCEPTED, ACCEPTED_CURRENT]) {
      mockSelect.mockClear();
      mockMaybeSingle.mockClear();
      mockMaybeSingle.mockResolvedValue(consentProfile(accepted));

      await updateSession(apiRequest('/api/meals'));

      expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledTimes(1);
      expect(mockSelect).toHaveBeenCalledWith(PROFILE_COLUMNS_WITH_LEGAL);
    }
  });

  it('改定の後 (旧版に同意) × ENFORCE=on: 同じ人の /api/meals は 403 LEGAL_CONSENT_REQUIRED (本文の error は LEGAL_CONSENT_REQUIRED_MESSAGE)、画面の GET /home は /legal-consent?next=%2Fhome へ 307、画面の POST /home は回さない (S5・S14 の Web の流れ)', async () => {
    mockMaybeSingle.mockResolvedValue(consentProfile({ terms: OLD_VERSION, privacy: CURRENT_PRIVACY }));

    const api = await updateSession(apiRequest('/api/meals'));
    expect(api.status).toBe(403);
    expect(((await api.json()) as { error?: string }).error).toBe(LEGAL_CONSENT_REQUIRED_MESSAGE);

    const page = await updateSession(apiRequest('/home'));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toBe('http://localhost/legal-consent?next=%2Fhome');

    const post = await updateSession(apiRequest('/home', { method: 'POST' }));
    expect(post.status).toBe(200);
    expect(post.headers.get('location')).toBeNull();
  });
});
