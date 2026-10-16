/**
 * #1190 GET /api/cron/login-alerts (不審なログインの通知の worker の route) の route テスト。
 * 設計 docs/design/cross/16-auth-history-sessions.md §14.8・§20.2
 *
 * worker (src/lib/auth/sessions/login-alert-worker.ts) は vi.mock し、route が渡す deps・alertMode・応答の形を見る。
 * worker の中身は sessions-login-alert-worker.test.ts が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processLoginAlerts: vi.fn(),
  createLoginAlertWorkerDeps: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  sendEmail: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/auth/sessions/login-alert-worker', () => ({
  processLoginAlerts: mocks.processLoginAlerts,
  createLoginAlertWorkerDeps: mocks.createLoginAlertWorkerDeps,
}));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/emails/send', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: mocks.logWarn, error: mocks.logError };
    return { ...logger, withUser: () => logger };
  },
  generateRequestId: () => 'req_test',
}));

const { GET } = await import('@/app/api/cron/login-alerts/route');

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const ADMIN_CLIENT = { name: 'service-role-client' };
const DEPS = { name: 'worker-deps' };
const SUMMARY = { claimed: 4, queued: 1, skipped: 2, failed: 1 };

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/login-alerts', {
    headers: authorization === undefined ? {} : { authorization },
  });
}
const authed = () => makeRequest(`Bearer ${SECRET}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', '');
  vi.stubEnv('AUTH_LOGIN_ALERT', '');
  mocks.getSupabaseAdmin.mockReturnValue(ADMIN_CLIENT);
  mocks.createLoginAlertWorkerDeps.mockReturnValue(DEPS);
  mocks.processLoginAlerts.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/login-alerts (§14.8)', () => {
  it('processLoginAlerts に createLoginAlertWorkerDeps(getSupabaseAdmin()) の deps を渡し、route は sendEmail を呼ばない', async () => {
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(mocks.createLoginAlertWorkerDeps).toHaveBeenCalledWith(ADMIN_CLIENT);
    expect(mocks.processLoginAlerts).toHaveBeenCalledWith(DEPS, { alertMode: 'on' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CRON_SECRET が合わなければ 401', async () => {
    const wrong = await GET(makeRequest('Bearer wrong-secret'));
    expect(wrong.status).toBe(401);
    const missing = await GET(makeRequest());
    expect(missing.status).toBe(401);
    expect(mocks.processLoginAlerts).not.toHaveBeenCalled();
  });

  it('AUTH_LOGIN_ALERT=off を worker に渡す', async () => {
    vi.stubEnv('AUTH_LOGIN_ALERT', 'OFF');
    await GET(authed());
    expect(mocks.processLoginAlerts).toHaveBeenCalledWith(DEPS, { alertMode: 'off' });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('不正な値は変数名だけを warn に出す', async () => {
    vi.stubEnv('AUTH_LOGIN_ALERT', 'secret-looking-value');
    await GET(authed());
    expect(mocks.processLoginAlerts).toHaveBeenCalledWith(DEPS, { alertMode: 'on' });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const printed = JSON.stringify(mocks.logWarn.mock.calls);
    expect(printed).toContain('AUTH_LOGIN_ALERT');
    expect(printed).not.toContain('secret-looking-value');
  });

  it('応答は件数だけ ({ claimed, queued, skipped, failed })', async () => {
    mocks.processLoginAlerts.mockResolvedValue({ ...SUMMARY, extra: 'should-not-leak' });
    const res = await GET(authed());
    expect(await res.json()).toEqual(SUMMARY);
  });

  it('claim の失敗 (worker の例外) は 500 で、本文に元の文を出さない', async () => {
    mocks.processLoginAlerts.mockRejectedValue(new Error('function claim_login_alerts(integer) does not exist'));
    const res = await GET(authed());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('claim_login_alerts');
    expect(mocks.logError).toHaveBeenCalled();
  });
});
