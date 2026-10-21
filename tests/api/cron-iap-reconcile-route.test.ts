/**
 * GET /api/cron/iap-reconcile (ストアの購読の定期の取り直しの route) の単体テスト (billing/04 §12.1 のテスト 21〜30)。
 * route を本物で動かす。facade (reconcileStoreSubscriptions)・gateway・repository・メンテナンスのフラグ・ログは偽物。
 * `requireCronAuth` は本物。route はファイルの一番外側で 1 回だけ読む (テスト・フックの中で import しない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  reconcileStoreSubscriptions: vi.fn(),
  createRevenueCatGateway: vi.fn(),
  createIapRepository: vi.fn(),
  createIapReconcileRepository: vi.fn(),
  isMaintenanceFlagOn: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/billing/iap-reconcile-service', () => ({ reconcileStoreSubscriptions: mocks.reconcileStoreSubscriptions }));
vi.mock('@/lib/billing/revenuecat-gateway', () => ({ createRevenueCatGateway: mocks.createRevenueCatGateway }));
vi.mock('@/lib/billing/iap-repository', () => ({ createIapRepository: mocks.createIapRepository }));
vi.mock('@/lib/billing/iap-reconcile-repository', () => ({ createIapReconcileRepository: mocks.createIapReconcileRepository }));
vi.mock('@/lib/maintenance-mode', () => ({ isMaintenanceFlagOn: mocks.isMaintenanceFlagOn }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_test',
}));

const { GET, maxDuration } = await import('@/app/api/cron/iap-reconcile/route');
const { RevenueCatNotConfiguredError } = await import('@/lib/billing/iap-core');
const {
  IAP_RECONCILE_CRON_PATH,
  IAP_RECONCILE_MAX_DURATION_SECONDS,
  IAP_RECONCILE_SCHEDULE_UTC,
  IapReconcileFailedError,
  emptyIapReconcileSummary,
} = await import('@/lib/billing/iap-reconcile-core');

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const GATEWAY = { name: 'revenuecat-gateway' };
const IAP_REPOSITORY = { name: 'iap-repository' };
const RECONCILE_REPOSITORY = { name: 'iap-reconcile-repository' };
const USER = '11111111-1111-4111-8111-111111111111';
const PROCESSED_SUMMARY = {
  candidates: 3,
  synced: 3,
  applied: 2,
  stale: 1,
  ended: 0,
  no_subscription: 0,
  skipped_unknown: 0,
  rejected: {},
  failed: {},
  stopped_early: null,
  oldest_period_end: '2026-10-21T00:00:00+00:00',
  elapsed_ms: 1234,
};
const SUMMARY_KEYS = Object.keys(PROCESSED_SUMMARY).sort();

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/iap-reconcile', {
    headers: authorization === undefined ? {} : { authorization },
  });
}
const authed = () => makeRequest(`Bearer ${SECRET}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', '');
  vi.stubEnv('IAP_RECONCILE_BATCH_SIZE', '');
  vi.stubEnv('IAP_RECONCILE_RECHECK_HOURS', '');
  mocks.isMaintenanceFlagOn.mockResolvedValue(false);
  mocks.createRevenueCatGateway.mockReturnValue(GATEWAY);
  mocks.createIapRepository.mockReturnValue(IAP_REPOSITORY);
  mocks.createIapReconcileRepository.mockReturnValue(RECONCILE_REPOSITORY);
  mocks.reconcileStoreSubscriptions.mockResolvedValue(PROCESSED_SUMMARY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectNothingTouched() {
  expect(mocks.isMaintenanceFlagOn).not.toHaveBeenCalled();
  expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();
  expect(mocks.createIapRepository).not.toHaveBeenCalled();
  expect(mocks.createIapReconcileRepository).not.toHaveBeenCalled();
  expect(mocks.reconcileStoreSubscriptions).not.toHaveBeenCalled();
  expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
}

describe('GET /api/cron/iap-reconcile (billing/04 §8.4・§9.1)', () => {
  it('A-1: 401 without Authorization or with a wrong secret and 503 { error: cron_disabled } when CRON_SECRET is unset; the maintenance flag, the gateway, the repositories and the service are not touched', async () => {
    const wrong = await GET(makeRequest('Bearer wrong-secret'));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    const missing = await GET(makeRequest());
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'unauthorized' });
    expectNothingTouched();

    // CRON_SECRET が未設定 (空) なら 503。requireCronAuth がサーバーのログに 1 行残すので黙らせる
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('CRON_SECRET', '');
    const disabled = await GET(authed());
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ error: 'cron_disabled' });
    expectNothingTouched();
  });

  it('M-1: returns 200 { status: maintenance } without creating the gateway, reading IAP_RECONCILE_* or calling the service while isMaintenanceFlagOn is true', async () => {
    mocks.isMaintenanceFlagOn.mockResolvedValue(true);
    // 環境変数は不正な値にしておく (読まれていれば warn が出る)
    vi.stubEnv('IAP_RECONCILE_BATCH_SIZE', 'not-a-number');

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'maintenance' });
    expect(mocks.createRevenueCatGateway).not.toHaveBeenCalled();
    expect(mocks.createIapRepository).not.toHaveBeenCalled();
    expect(mocks.createIapReconcileRepository).not.toHaveBeenCalled();
    expect(mocks.reconcileStoreSubscriptions).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('K-1: returns 200 { status: not_configured } with one warn (no RPC, no repository, no service) when createRevenueCatGateway throws RevenueCatNotConfiguredError', async () => {
    mocks.createRevenueCatGateway.mockImplementation(() => {
      throw new RevenueCatNotConfiguredError();
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_configured' });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith('REVENUECAT_SECRET_API_KEY が未設定のため、ストアの購読の取り直しを行いません');
    expect(mocks.createIapRepository).not.toHaveBeenCalled();
    expect(mocks.createIapReconcileRepository).not.toHaveBeenCalled();
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.reconcileStoreSubscriptions).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('E-1: passes valid IAP_RECONCILE_BATCH_SIZE / IAP_RECONCILE_RECHECK_HOURS to the service as batchSize / recheckHours and, for an invalid value, uses the default with a warn whose ignored_env names the variable (the value is not logged)', async () => {
    vi.stubEnv('IAP_RECONCILE_BATCH_SIZE', '25');
    vi.stubEnv('IAP_RECONCILE_RECHECK_HOURS', '12');
    await GET(authed());
    expect(mocks.reconcileStoreSubscriptions).toHaveBeenLastCalledWith(expect.anything(), { batchSize: 25, recheckHours: 12, ignored: [] });
    expect(mocks.logWarn).not.toHaveBeenCalled();

    // 範囲外 (上限 40 を超える) と数字でない値は既定に戻り、変数名だけが warn に出る
    const secretLookingValue = 'secret-looking-value';
    vi.stubEnv('IAP_RECONCILE_BATCH_SIZE', '41');
    vi.stubEnv('IAP_RECONCILE_RECHECK_HOURS', secretLookingValue);
    await GET(authed());
    expect(mocks.reconcileStoreSubscriptions).toHaveBeenLastCalledWith(expect.anything(), {
      batchSize: 40,
      recheckHours: 6,
      ignored: ['IAP_RECONCILE_BATCH_SIZE', 'IAP_RECONCILE_RECHECK_HOURS'],
    });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith('ストアの購読の取り直しの環境変数の値が正しくないため、既定値を使います', {
      ignored_env: ['IAP_RECONCILE_BATCH_SIZE', 'IAP_RECONCILE_RECHECK_HOURS'],
    });
    const printed = JSON.stringify(mocks.logWarn.mock.calls);
    expect(printed).not.toContain(secretLookingValue);
    expect(printed).not.toContain('"41"');
  });

  it('R-1: returns 200 { status: idle, ...summary } with no info log for candidates 0, and { status: processed, ...summary } with an info log otherwise; the body has exactly the summary keys and no user ids', async () => {
    const idleSummary = { ...emptyIapReconcileSummary([]), elapsed_ms: 3 };
    mocks.reconcileStoreSubscriptions.mockResolvedValueOnce(idleSummary);
    const idle = await GET(authed());
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ status: 'idle', ...idleSummary });
    expect(mocks.logInfo).not.toHaveBeenCalled();

    const processed = await GET(authed());
    expect(processed.status).toBe(200);
    const body = (await processed.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'processed', ...PROCESSED_SUMMARY });
    expect(Object.keys(body).sort()).toEqual(['status', ...SUMMARY_KEYS].sort());
    expect(JSON.stringify(body)).not.toContain(USER);
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    expect(mocks.logInfo).toHaveBeenCalledWith('ストアの購読の取り直しを処理しました', PROCESSED_SUMMARY);
  });

  it('R-2: returns 500 with the fixed internalError body and an app_logs error when the service throws IapReconcileFailedError (the summary is in the error metadata, not in the body) or a PostgrestError; no user id or raw RevenueCat text is in the body', async () => {
    const failedSummary = { ...emptyIapReconcileSummary([]), candidates: 2, synced: 1, failed: { revenuecat_client_error: 1 } };
    mocks.reconcileStoreSubscriptions.mockRejectedValueOnce(new IapReconcileFailedError(failedSummary));
    const failed = await GET(authed());
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    // 要約 (件数と種類だけ) は error の metadata に残る
    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ summary: failedSummary });

    mocks.logError.mockClear();
    const postgrestError = Object.assign(new Error(`permission denied for function billing_iap_reconcile_candidates (user ${USER})`), { code: '42501' });
    mocks.reconcileStoreSubscriptions.mockRejectedValueOnce(postgrestError);
    const rpc = await GET(authed());
    expect(rpc.status).toBe(500);
    const rpcBody = JSON.stringify(await rpc.json());
    expect(rpcBody).not.toContain(USER);
    expect(rpcBody).not.toContain('billing_iap_reconcile_candidates');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ error_code: '42501' });
    expect(mocks.logError.mock.calls[0][2]).not.toHaveProperty('summary');
  });

  it('R-3: builds deps from createRevenueCatGateway / createIapRepository / createIapReconcileRepository and passes them to reconcileStoreSubscriptions (no direct Supabase client)', async () => {
    await GET(authed());

    expect(mocks.reconcileStoreSubscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileStoreSubscriptions).toHaveBeenCalledWith(
      { gateway: GATEWAY, repository: IAP_REPOSITORY, reconcileRepository: RECONCILE_REPOSITORY },
      { batchSize: 40, recheckHours: 6, ignored: [] },
    );
    // route 自身は Supabase の client を作らない (repository の中だけ)
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/cron/iap-reconcile/route.ts'), 'utf8');
    expect(source).not.toMatch(/@\/lib\/supabase/);
    expect(source).not.toMatch(/getSupabaseAdmin/);
  });

  it('C-1: maxDuration literal equals IAP_RECONCILE_MAX_DURATION_SECONDS', () => {
    expect(maxDuration).toBe(IAP_RECONCILE_MAX_DURATION_SECONDS);
    // route segment config はリテラルだけ (定数の import を書けない) ので、ファイルにリテラルで書かれている
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/cron/iap-reconcile/route.ts'), 'utf8');
    expect(source).toMatch(new RegExp(`export const maxDuration = ${IAP_RECONCILE_MAX_DURATION_SECONDS};`));
  });

  it('C-2: vercel.json has exactly one cron with path IAP_RECONCILE_CRON_PATH and schedule IAP_RECONCILE_SCHEDULE_UTC, and the 6 existing crons (process-menu-queue / app-log-alerts / email-outbox / push-outbox / backup-freshness / login-alerts) remain', () => {
    const VercelJsonCronsSchema = z.object({ crons: z.array(z.object({ path: z.string(), schedule: z.string() })) });
    const raw = fs.readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf-8');
    const { crons } = VercelJsonCronsSchema.parse(JSON.parse(raw));
    expect(crons.filter((cron) => cron.path === IAP_RECONCILE_CRON_PATH)).toEqual([
      { path: IAP_RECONCILE_CRON_PATH, schedule: IAP_RECONCILE_SCHEDULE_UTC },
    ]);
    const paths = crons.map((cron) => cron.path);
    for (const existing of ['process-menu-queue', 'app-log-alerts', 'email-outbox', 'push-outbox', 'backup-freshness', 'login-alerts']) {
      expect(paths, existing).toContain(`/api/cron/${existing}`);
    }
    // 6 本 + 本冊の 1 本
    expect(crons).toHaveLength(7);
  });

  it('C-3: requireCronAuth is awaited before isMaintenanceFlagOn (an unauthenticated request never reads the flag)', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/cron/iap-reconcile/route.ts'), 'utf8');
    const authAt = source.indexOf('await requireCronAuth(req)');
    const flagAt = source.indexOf('await isMaintenanceFlagOn()');
    expect(authAt).toBeGreaterThan(-1);
    expect(flagAt).toBeGreaterThan(authAt);

    const res = await GET(makeRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(mocks.isMaintenanceFlagOn).not.toHaveBeenCalled();
  });
});
