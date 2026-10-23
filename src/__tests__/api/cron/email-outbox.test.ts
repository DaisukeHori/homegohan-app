import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  EMAIL_OUTBOX_LEASE_SECONDS,
  EMAIL_OUTBOX_RUN_BUDGET_MS,
  type EmailOutboxClaimedRow,
} from '@/lib/emails/outbox';

// #1193 GET /api/cron/email-outbox — メールの送信待ち (email_outbox) を送る worker (Vercel Cron。毎分)。
// 設計: docs/design/operator/10-logs-and-mail-retry.md §6.5・§12。
// DB (outbox-store)・Resend の SDK・停止リスト・ロガーはモックにし、route と worker の本体 (processEmailOutbox) は実物を通す。
// 値はすべてテスト用のダミー。本物のシークレット・アドレスは使わない。

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  createOutboxStore: vi.fn(),
  emailsSend: vi.fn(),
  lookupEmailSuppression: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/emails/outbox-store', () => ({
  createOutboxStore: mocks.createOutboxStore,
}));

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mocks.emailsSend };
  }
  return { Resend: MockResend };
});

vi.mock('@/lib/emails/suppression', () => ({
  lookupEmailSuppression: mocks.lookupEmailSuppression,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    withUser: () => ({ debug: vi.fn(), info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError }),
  }),
  generateRequestId: () => 'req_test',
}));

// ログの保存を待つ延命 (waitUntil) は createLogger が行い、route は延命しない (#1909)。
// 本物の createLogger を通した確認は cron-log-keepalive-1909.test.ts

const routeModule = await import('@/app/api/cron/email-outbox/route');
const { GET } = routeModule;

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const OLD_SECRET = 'dummy-old-cron-secret-fedcba9876543210';
const API_KEY = 'dummy-api-key-for-test-0123456789';
const RECIPIENT = 'invitee@example.test';
const MS_PER_SECOND = 1000;

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/email-outbox', {
    headers: authorization === undefined ? {} : { authorization },
  });
}
const authed = () => makeRequest(`Bearer ${SECRET}`);

const ROW: EmailOutboxClaimedRow = {
  id: '00000000-0000-4000-8000-000000000001',
  template: 'family_invite',
  to_email: RECIPIENT,
  from_email: 'noreply@example.test',
  reply_to: null,
  subject: '招待の件名',
  text_body: '招待の本文',
  html_body: null,
  idempotency_key: 'idem-1',
  attempts: 0,
  created_at: new Date().toISOString(),
  redact_after_send: false,
};

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('RESEND_API_KEY', API_KEY);
  vi.stubEnv('EMAIL_OUTBOX_MAX_ATTEMPTS', undefined);
  vi.stubEnv('EMAIL_OUTBOX_BATCH_SIZE', undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.createOutboxStore.mockReturnValue({ claim: mocks.claim, complete: mocks.complete, fail: mocks.fail });
  mocks.claim.mockResolvedValue([]);
  mocks.complete.mockResolvedValue(true);
  mocks.fail.mockResolvedValue('queued');
  mocks.emailsSend.mockResolvedValue({ data: { id: 'resend-id-1' }, error: null, headers: null });
  mocks.lookupEmailSuppression.mockResolvedValue({ status: 'clear' });
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  vi.unstubAllEnvs();
});

function expectNothingTouched() {
  expect(mocks.createOutboxStore).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.emailsSend).not.toHaveBeenCalled();
}

describe('GET /api/cron/email-outbox: 認証 (app-log-alerts と同じ)', () => {
  it('A-1: Authorization ヘッダーが無ければ 401。DB・送信・ログには何も触れない', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    expectNothingTouched();
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('A-2: 誤ったシークレット (同じ長さ・短い・長い・Bearer なし) は 401', async () => {
    for (const value of [`Bearer ${'x'.repeat(SECRET.length)}`, 'Bearer short', `Bearer ${SECRET}x`, SECRET, `bearer ${SECRET}`]) {
      const res = await GET(makeRequest(value));
      expect(res.status, value).toBe(401);
    }
    expectNothingTouched();
  });

  it('A-3: RESEND_API_KEY が未設定でも、認証の無いリクエストは 401 のまま (warn ログを増やされない)', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('A-4: CRON_SECRET が未設定なら 503 (cron_disabled)。何も実行しない', async () => {
    vi.stubEnv('CRON_SECRET', undefined);

    const res = await GET(makeRequest('Bearer anything'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'cron_disabled' });
    expectNothingTouched();
  });

  it('A-5: 入れ替え中の旧いシークレット (CRON_SECRET_PREVIOUS) でも通る (#1196)', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);

    const res = await GET(makeRequest(`Bearer ${OLD_SECRET}`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'idle' });
  });

  it('A-6: 正しいシークレットなら 200 で処理が走る', async () => {
    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/cron/email-outbox: 鍵と環境変数', () => {
  it('鍵が無ければ not_configured で claim しない (変数名は warn にだけ書き、応答には出さない)', async () => {
    for (const value of [undefined, '']) {
      vi.stubEnv('RESEND_API_KEY', value);
      mocks.logWarn.mockClear();

      const res = await GET(authed());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'not_configured' });
      expect(JSON.stringify(body)).not.toContain('RESEND_API_KEY');
      expect(mocks.logWarn).toHaveBeenCalledWith('RESEND_API_KEY が未設定のため、送信待ちのメールを送りません');
    }
    expectNothingTouched();
  });

  it('環境変数の不正は既定に戻し warn (変数名だけ。値は出さない)。既定は 20 件・6 回', async () => {
    vi.stubEnv('EMAIL_OUTBOX_MAX_ATTEMPTS', 'many-times');
    vi.stubEnv('EMAIL_OUTBOX_BATCH_SIZE', '500');
    mocks.claim.mockResolvedValueOnce([ROW]);
    mocks.emailsSend.mockResolvedValueOnce({ data: null, error: { name: 'application_error', statusCode: 503, message: 'x' }, headers: null });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(mocks.logWarn).toHaveBeenCalledWith('送信待ちの環境変数の値が正しくないため、既定値を使います', {
      ignored_env: ['EMAIL_OUTBOX_MAX_ATTEMPTS', 'EMAIL_OUTBOX_BATCH_SIZE'],
    });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('many-times');
    expect(mocks.claim).toHaveBeenCalledWith(expect.any(String), 20, EMAIL_OUTBOX_LEASE_SECONDS);
    expect(mocks.fail.mock.calls[0][3]).toEqual({ maxAttempts: 6, retryAfterSeconds: 60 });
  });

  it('環境変数が正しければその値を使う (件数は claim へ、回数は fail へ)', async () => {
    vi.stubEnv('EMAIL_OUTBOX_MAX_ATTEMPTS', '3');
    vi.stubEnv('EMAIL_OUTBOX_BATCH_SIZE', '7');
    mocks.claim.mockResolvedValueOnce([ROW]);
    mocks.emailsSend.mockResolvedValueOnce({ data: null, error: { name: 'application_error', statusCode: 503, message: 'x' }, headers: null });

    await GET(authed());

    expect(mocks.claim).toHaveBeenCalledWith(expect.any(String), 7, EMAIL_OUTBOX_LEASE_SECONDS);
    expect(mocks.fail.mock.calls[0][3]).toEqual({ maxAttempts: 3, retryAfterSeconds: 60 });
    expect(mocks.logWarn).not.toHaveBeenCalledWith('送信待ちの環境変数の値が正しくないため、既定値を使います', expect.anything());
  });

  it('worker_id は呼び出しごとに新しい UUID で、complete にも同じ値を渡す', async () => {
    mocks.claim.mockResolvedValueOnce([ROW]);
    await GET(authed());
    await GET(authed());

    const [first, second] = mocks.claim.mock.calls.map(([workerId]) => workerId);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
    expect(mocks.complete).toHaveBeenCalledWith(ROW.id, first, 'resend-id-1');
  });
});

describe('GET /api/cron/email-outbox: 処理と応答', () => {
  it('claim が 0 件なら idle (info ログは残さない)', async () => {
    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({
      status: 'idle',
      claimed: 0,
      sent: 0,
      requeued: 0,
      dead: 0,
      dead_codes: {},
      stopped_early: false,
    });
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it('処理の要約を応答とログに (宛先なし)。Resend へ Idempotency-Key を付けて送る', async () => {
    mocks.claim.mockResolvedValueOnce([ROW]);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    const body = await res.json();
    const summary = { claimed: 1, sent: 1, requeued: 0, dead: 0, dead_codes: {}, stopped_early: false };
    expect(body).toEqual({ status: 'processed', ...summary });
    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    expect(mocks.emailsSend.mock.calls[0][1]).toEqual({ idempotencyKey: 'idem-1' });
    expect(mocks.lookupEmailSuppression).toHaveBeenCalledWith(RECIPIENT);
    expect(mocks.logInfo).toHaveBeenCalledWith('送信待ちのメールを処理しました', summary);
    const exposed = JSON.stringify([body, mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);
    expect(exposed).not.toContain(RECIPIENT);
    expect(exposed).not.toContain('招待の件名');
    expect(exposed).not.toContain('招待の本文');
    expect(exposed).not.toContain(API_KEY);
  });

  it('dead になった行はコード別に数えて応答に載せる', async () => {
    mocks.claim.mockResolvedValueOnce([ROW]);
    mocks.emailsSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', statusCode: 403, message: `domain is not verified for ${RECIPIENT}` },
      headers: null,
    });
    mocks.fail.mockResolvedValueOnce('dead');

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ status: 'processed', dead: 1, dead_codes: { validation_error: 1 } });
    expect(mocks.fail.mock.calls[0][2]).toEqual({
      code: 'validation_error',
      message: 'domain is not verified for i***@example.test',
      statusCode: 403,
      retryable: false,
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(RECIPIENT);
  });

  it('claim の失敗は 500 (汎用)。DB の生の文を返さず、app_logs に残す', async () => {
    mocks.claim.mockRejectedValueOnce(new Error('claim_email_outbox failed: 42501'));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('claim_email_outbox');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.emailsSend).not.toHaveBeenCalled();
  });

  it('complete / fail の RPC の失敗も 500 (汎用)', async () => {
    mocks.claim.mockResolvedValueOnce([ROW]);
    mocks.complete.mockRejectedValueOnce(new Error('complete_email_outbox failed: 57014'));
    const completeFailed = await GET(authed());
    expect(completeFailed.status).toBe(500);

    mocks.claim.mockResolvedValueOnce([ROW]);
    mocks.emailsSend.mockResolvedValueOnce({ data: null, error: { name: 'application_error', statusCode: 503, message: 'x' }, headers: null });
    mocks.fail.mockRejectedValueOnce(new Error('fail_email_outbox failed: 57014'));
    const failFailed = await GET(authed());
    expect(failFailed.status).toBe(500);
  });
});

describe('GET /api/cron/email-outbox: route の設定', () => {
  it('GET だけ公開', () => {
    expect(Object.keys(routeModule).filter((key) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(key))).toEqual(['GET']);
  });

  it('vercel.json に毎分で登録 (1 本だけ)', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };

    expect(vercel.crons.filter((cron) => cron.path === '/api/cron/email-outbox')).toEqual([
      { path: '/api/cron/email-outbox', schedule: '*/1 * * * *' },
    ]);
  });

  it('fetchCache force-no-store (dynamic は force-dynamic)', () => {
    expect(routeModule.dynamic).toBe('force-dynamic');
    expect(routeModule.fetchCache).toBe('force-no-store');
  });

  it('R-16: runtime nodejs・maxDuration = 60 を export し、EMAIL_OUTBOX_RUN_BUDGET_MS < maxDuration × 1000 ≤ EMAIL_OUTBOX_LEASE_SECONDS × 1000', () => {
    expect(routeModule.runtime).toBe('nodejs');
    expect(routeModule.maxDuration).toBe(60);
    expect(EMAIL_OUTBOX_RUN_BUDGET_MS).toBeLessThan(routeModule.maxDuration * MS_PER_SECOND);
    expect(routeModule.maxDuration * MS_PER_SECOND).toBeLessThanOrEqual(EMAIL_OUTBOX_LEASE_SECONDS * MS_PER_SECOND);
  });
});
