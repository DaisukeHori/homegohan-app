import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import {
  BACKUP_FRESHNESS_CRON_INTERVAL_HOURS,
  BACKUP_FRESHNESS_CRON_PATH,
  BACKUP_FRESHNESS_SCHEDULE_UTC,
  BACKUP_STALE_AFTER_HOURS,
  BACKUP_STALE_ALERT_COOLDOWN_MINUTES,
} from '@/lib/backups/core';

// #1129 GET /api/cron/backup-freshness — DB バックアップが新しく取れていないことを運用メールに知らせる cron
// (docs/design/cross/17-backup-automation.md §7.3・§8.3 の「鮮度」の行・§11)。
// DB (admin_audit_logs の select と claim / release の RPC)・メール送信 (sendEmail)・ロガーはモックにし、
// route 本体と、文面 (renderBackupStaleEmail)・判定 (isBackupStale)・宛先の読み口 (resolveOpsAlertRecipient) は実物を通す。
// claim_ops_alert / release_ops_alert の DB 側の挙動は tests/integration/rls/ops-alert-state.test.ts が実際の PostgreSQL で確かめる。
// 値はすべてテスト用のダミー。本物のシークレット・アドレスは使わない。
// route はファイルの一番外側で 1 回だけ読む (テスト・フックの中で import しない。tests/heavy-unit-test-timeout.test.ts の同じ型)。

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  sendEmail: vi.fn(),
  waitUntil: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  /** true の間、文面を作る関数が例外を投げる (権利を取ったあとの例外の確認用) */
  renderThrows: false,
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
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

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

// 関数を延命する waitUntil。Vercel の外では何もしないが、呼ばれたかを確かめるために差し替える
vi.mock('@vercel/functions', () => ({
  waitUntil: mocks.waitUntil,
}));

// 文面は実物を通す。renderThrows のときだけ例外にする
vi.mock('@/lib/emails/ops/backup-stale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/ops/backup-stale')>();
  return {
    ...actual,
    renderBackupStaleEmail: (vars: Parameters<typeof actual.renderBackupStaleEmail>[0]) => {
      if (mocks.renderThrows) throw new Error('render failed');
      return actual.renderBackupStaleEmail(vars);
    },
  };
});

const routeModule = await import('@/app/api/cron/backup-freshness/route');
const { GET } = routeModule;

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const OPS_EMAIL = 'ops-owner@example.test';
const SITE_URL = 'https://app.example.test';
const CLAIMED_AT = '2026-10-17T05:37:00.123456+00:00';
/** 確認の時刻 (14:37 JST の回) */
const NOW = new Date('2026-10-17T05:37:00.000Z');
const MS_PER_HOUR = 60 * 60 * 1000;
/** NOW から hours 時間前の created_at */
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * MS_PER_HOUR).toISOString();

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/backup-freshness', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

const authed = () => makeRequest(`Bearer ${SECRET}`);

type DbResult = { data: unknown; error: { code?: string; message: string } | null };

interface Scenario {
  /** admin_audit_logs の最新 1 行の select の応答 (maybeSingle) */
  latest: DbResult;
  claim: DbResult;
  release: DbResult;
}

let scenario: Scenario;

function setScenario(overrides: Partial<Scenario> = {}) {
  scenario = {
    latest: { data: { created_at: hoursAgo(12) }, error: null },
    claim: { data: CLAIMED_AT, error: null },
    release: { data: true, error: null },
    ...overrides,
  };
}

/** from() から始まる連なりの呼び出しを、[メソッド名, 引数] の列で残す */
let chainCalls: Array<[string, unknown[]]>;
/** true の間、maybeSingle が例外を投げる */
let latestThrows = false;

function makeQueryBuilder() {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      chainCalls.push([method, args]);
      return builder;
    };
  }
  builder.maybeSingle = async (...args: unknown[]) => {
    chainCalls.push(['maybeSingle', args]);
    if (latestThrows) throw new Error('fetch failed (db.internal.example.test)');
    return scenario.latest;
  };
  return builder;
}

const sentResult = { ok: true, id: 'email-id-1', attempts: 1, skipped: false, error: null } as const;
const skippedResult = {
  ok: false,
  id: null,
  attempts: 0,
  skipped: true,
  error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定です', null, 0, false),
} as const;
const failedResult = {
  ok: false,
  id: null,
  attempts: 1,
  skipped: false,
  error: new EmailSendError('validation_error', 'EMAIL_SEND_FAILED: domain is not verified', 403, 1, false),
} as const;

const rpcCalls = (name: string) => mocks.rpc.mock.calls.filter(([fn]) => fn === name);

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.renderThrows = false;
  latestThrows = false;
  chainCalls = [];
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  setScenario();
  mocks.from.mockImplementation(() => makeQueryBuilder());
  mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'claim_ops_alert') return scenario.claim;
    if (fn === 'release_ops_alert') return scenario.release;
    throw new Error(`想定外の RPC: ${fn}`);
  });
  mocks.sendEmail.mockResolvedValue(sentResult);
});

afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  vi.unstubAllEnvs();
});

/** 認証・宛先の確認より先に、DB・メールに何も触れていないこと */
function expectNothingTouched() {
  expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.sendEmail).not.toHaveBeenCalled();
}

/** 古い (最新の取得が無い) 状態にする */
const setStale = (overrides: Partial<Scenario> = {}) => setScenario({ latest: { data: null, error: null }, ...overrides });

// ---------------------------------------------------------------
// 認証
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: 認証 (#1129)', () => {
  it('A-1: Authorization ヘッダーが無ければ 401。DB・メール・ログには何も触れない', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    expectNothingTouched();
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('A-2: 誤ったシークレットは 401', async () => {
    for (const value of [`Bearer ${'x'.repeat(SECRET.length)}`, 'Bearer short', SECRET]) {
      const res = await GET(makeRequest(value));
      expect(res.status, value).toBe(401);
    }
    expectNothingTouched();
  });

  it('A-3: CRON_SECRET が未設定なら 503 (cron_disabled)。DB に触れない', async () => {
    vi.stubEnv('CRON_SECRET', undefined);

    const res = await GET(makeRequest('Bearer anything'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'cron_disabled' });
    expectNothingTouched();
  });
});

// ---------------------------------------------------------------
// 宛先 (OPS_ALERT_EMAIL)
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: 宛先 OPS_ALERT_EMAIL (#1129)', () => {
  it('C-1: 未設定 (空白だけを含む) なら 200 disabled。info ログ 1 行だけで、from を呼ばない', async () => {
    for (const blank of [undefined, '', '  ']) {
      vi.stubEnv('OPS_ALERT_EMAIL', blank);
      mocks.logInfo.mockClear();

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'disabled' });
      expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    }
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expectNothingTouched();
  });

  it('C-2: メールアドレス (1 つ) の形でなければ 200 invalid_config。warn を残し、設定値はログに出さない。DB に触れない', async () => {
    for (const invalid of ['not-an-email', 'a@example.test, b@example.test', 'ほめゴハン <ops@example.test>']) {
      vi.stubEnv('OPS_ALERT_EMAIL', invalid);
      mocks.logWarn.mockClear();

      const res = await GET(authed());

      expect(res.status, invalid).toBe(200);
      await expect(res.json(), invalid).resolves.toEqual({ status: 'invalid_config' });
      expect(mocks.logWarn, invalid).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mocks.logWarn.mock.calls), invalid).not.toContain('example.test');
    }
    expectNothingTouched();
  });
});

// ---------------------------------------------------------------
// 鮮度の判定
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: 鮮度の判定 (#1129)', () => {
  it('F-1: 最新が 12 時間前なら fresh。claim を呼ばず、メールも送らない', async () => {
    const latest = hoursAgo(12);
    setScenario({ latest: { data: { created_at: latest }, error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'fresh',
      latest_completed_at: latest,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('F-2: 取得の行だけを読む: admin_audit_logs の created_at を、action_type・target_type・actor_id NULL で絞って新しい順に 1 行 (S-23。actor のある偽の行で fresh にしない)', async () => {
    await GET(authed());

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('admin_audit_logs');
    expect(chainCalls).toEqual([
      ['select', ['created_at']],
      ['eq', ['action_type', 'backup.daily.completed']],
      ['eq', ['target_type', 'database_backup']],
      ['is', ['actor_id', null]],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
      ['maybeSingle', []],
    ]);
  });

  it('F-3: 30 時間ちょうどまでは fresh、それを超えたら stale (BACKUP_STALE_AFTER_HOURS の境界)', async () => {
    expect(BACKUP_STALE_AFTER_HOURS).toBe(30);

    setScenario({ latest: { data: { created_at: hoursAgo(BACKUP_STALE_AFTER_HOURS) }, error: null } });
    await expect((await GET(authed())).json()).resolves.toMatchObject({ status: 'fresh' });

    setScenario({ latest: { data: { created_at: hoursAgo(BACKUP_STALE_AFTER_HOURS + 1 / 60) }, error: null } });
    await expect((await GET(authed())).json()).resolves.toMatchObject({ status: 'stale_sent' });
  });

  it('F-4: 行が無い → claim → sendEmail → stale_sent。最新は null で応答する', async () => {
    setStale();

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'stale_sent',
      latest_completed_at: null,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // 送れたときは権利を返さない (23 時間の抑止が効く)
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    // 順: 読む → 権利を取る → 送る
    const claimOrder = mocks.rpc.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(mocks.sendEmail.mock.invocationCallOrder[0]);
  });

  it('F-5: 最新が 31 時間前でも stale。メールの最新の取得は日本時間で載る', async () => {
    // 2026-10-15T22:37Z = 2026-10-16 07:37 JST
    setScenario({ latest: { data: { created_at: hoursAgo(31) }, error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ status: 'stale_sent', latest_completed_at: hoursAgo(31) });
    expect(mocks.sendEmail.mock.calls[0][0].text).toContain('最新の取得: 2026/10/16 07:37 (日本時間)');
  });

  it('F-6: 行の created_at が文字列でない (形が違う) なら、記録なしとして stale にする', async () => {
    setScenario({ latest: { data: { created_at: 12345 }, error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ status: 'stale_sent', latest_completed_at: null });
  });
});

// ---------------------------------------------------------------
// 送る権利 (claim_ops_alert)
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: 送る権利 (#1129)', () => {
  it('D-1: 権利はキー backup_stale とクールダウン BACKUP_STALE_ALERT_COOLDOWN_MINUTES で取る。その値は cron の間隔 1440 分より短い (翌日の回: 前回から 23 時間 59 分 59 秒でも取れる側)', async () => {
    setStale();

    await GET(authed());

    expect(rpcCalls('claim_ops_alert')).toEqual([
      ['claim_ops_alert', { p_alert_key: 'backup_stale', p_cooldown_minutes: BACKUP_STALE_ALERT_COOLDOWN_MINUTES }],
    ]);
    const cronIntervalMinutes = BACKUP_FRESHNESS_CRON_INTERVAL_HOURS * 60;
    expect(cronIntervalMinutes).toBe(1440);
    expect(BACKUP_STALE_ALERT_COOLDOWN_MINUTES).toBe(1380);
    expect(BACKUP_STALE_ALERT_COOLDOWN_MINUTES).toBeLessThan(cronIntervalMinutes);
    // 前回の送信から 23 時間 59 分 59 秒 (= 翌日の回が 1 秒早く起きた) でも、クールダウンは明けている
    const almostOneDayMinutes = (24 * 60 * 60 - 1) / 60;
    expect(almostOneDayMinutes).toBeGreaterThanOrEqual(BACKUP_STALE_ALERT_COOLDOWN_MINUTES);
  });

  it('D-2: claim が NULL (クールダウン中) なら stale_deduped。送らず、権利を返す操作もしない。warn を 1 行残す', async () => {
    setStale({ claim: { data: null, error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'stale_deduped',
      latest_completed_at: null,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({
      status: 'stale_deduped',
      latest_completed_at: null,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
    });
  });

  it('D-3: claim が error → 500 (汎用)。送らない', async () => {
    setStale({ claim: { data: null, error: { code: '42501', message: 'permission denied for function claim_ops_alert' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// メールを送れなかったとき
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: メールを送れなかったとき (#1129)', () => {
  it('S-1: sendEmail が { ok: false, skipped } → release を呼び stale_send_skipped (200)', async () => {
    setStale();
    mocks.sendEmail.mockResolvedValue(skippedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale_send_skipped' });
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'backup_stale', p_claimed_at: CLAIMED_AT }],
    ]);
  });

  it('S-2: sendEmail が { ok: false } (skipped でない) → release を呼び stale_send_failed (200)', async () => {
    setStale();
    mocks.sendEmail.mockResolvedValue(failedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale_send_failed' });
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
  });

  it('S-3: sendEmail が例外 → release してから 500 (汎用)', async () => {
    setStale();
    mocks.sendEmail.mockRejectedValue(new Error('unexpected (resend.internal.example.test)'));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('resend.internal');
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
  });

  it('S-4: 文面を作る処理が権利を取ったあとに例外を投げても、release してから 500', async () => {
    setStale();
    mocks.renderThrows = true;

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
  });

  it('S-5: sendEmail が { ok: false } で release が error を返す → warn ログで stale_send_failed の 200 のまま (例外を外へ出さない)', async () => {
    setStale({ release: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
    mocks.sendEmail.mockResolvedValue(failedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale_send_failed' });
    const releaseWarn = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('送る権利を返せませんでした'));
    expect(releaseWarn?.[1]).toEqual({ pg_code: '57014' });
  });

  it('S-6: release が例外を投げる → 同じく stale_send_failed の 200 のまま。warn は error_name だけ', async () => {
    setStale();
    mocks.sendEmail.mockResolvedValue(failedResult);
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'claim_ops_alert') return scenario.claim;
      throw new TypeError('fetch failed');
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'stale_send_failed' });
    const releaseWarn = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('送る権利を返せませんでした'));
    expect(releaseWarn?.[1]).toEqual({ error_name: 'TypeError' });
  });

  it('S-7: sendEmail が例外で release も例外 → 500 のまま (release の失敗で本題を上書きしない)', async () => {
    setStale();
    mocks.sendEmail.mockRejectedValue(new Error('unexpected'));
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'claim_ops_alert') return scenario.claim;
      throw new Error('release failed');
    });

    const res = await GET(authed());

    expect(res.status).toBe(500);
  });

  it.each([
    ['suppressed (宛先が停止リスト)', 'suppressed', 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした'],
    ['invalid_envelope (文面の不備)', 'invalid_envelope', 'EMAIL_INVALID_ENVELOPE: subject: too long'],
  ])(
    'S-8: sendEmail が %s なら、送り直しても同じ結果なので権利を返さない (release を呼ばない)。stale_send_failed の 200 と warn 1 行 (#1577 の 8)',
    async (_label, code, message) => {
      setStale();
      mocks.sendEmail.mockResolvedValue({
        ok: false,
        id: null,
        attempts: 0,
        skipped: false,
        error: new EmailSendError(code, message, null, 0, false),
      });

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: 'stale_send_failed' });
      expect(rpcCalls('claim_ops_alert')).toHaveLength(1);
      expect(rpcCalls('release_ops_alert')).toHaveLength(0);
      const staleWarns = mocks.logWarn.mock.calls.filter(([, meta]) => (meta as { status?: string } | undefined)?.status === 'stale_send_failed');
      expect(staleWarns).toHaveLength(1);
      expect(staleWarns[0][1]).toMatchObject({ error_code: code });
    },
  );

  it.each([
    ['outbox_failed (送信待ちへの登録の失敗)', 'outbox_failed', true, false],
    ['not_configured (送信の設定が未完了 = skipped)', 'not_configured', false, true],
    ['validation_error (Resend 由来のほかのコード)', 'validation_error', false, false],
  ])(
    'S-9: sendEmail が %s なら、これまでどおり権利を返す (release を 1 回、取った時刻で呼ぶ) (#1577 の 8 の対照)',
    async (_label, code, retryable, skipped) => {
      setStale();
      mocks.sendEmail.mockResolvedValue({
        ok: false,
        id: null,
        attempts: 0,
        skipped,
        error: new EmailSendError(code, `EMAIL_TEST_FAILURE: ${code}`, null, 0, retryable),
      });

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: skipped ? 'stale_send_skipped' : 'stale_send_failed' });
      expect(rpcCalls('release_ops_alert')).toEqual([
        ['release_ops_alert', { p_alert_key: 'backup_stale', p_claimed_at: CLAIMED_AT }],
      ]);
    },
  );
});

// ---------------------------------------------------------------
// DB の失敗
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: DB の失敗は 500 (汎用メッセージ) (#1129)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  const RAW = 'relation "public.admin_audit_logs" does not exist (host=db.internal.example.test)';

  it('X-1: 最新 1 行の select が error → 500。DB の生のエラー文は返さず、app_logs に残す。claim もメールもしない', async () => {
    setScenario({ latest: { data: null, error: { code: '42P01', message: RAW } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(GENERIC);
    expect(JSON.stringify(body)).not.toContain('admin_audit_logs');
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('X-2: select が例外を投げる・Supabase のクライアントを作れない → 500', async () => {
    latestThrows = true;
    let res = await GET(authed());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);

    latestThrows = false;
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });
    res = await GET(authed());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(GENERIC);
    expect(JSON.stringify(body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// メールの内容・ログ
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: メールの内容とログ (#1129)', () => {
  it('M-1: 宛先は OPS_ALERT_EMAIL。template は ops_backup_stale で、本文に運営の画面の URL が載る', async () => {
    setStale();

    await GET(authed());

    const envelope = mocks.sendEmail.mock.calls[0][0];
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.template).toBe('ops_backup_stale');
    expect(envelope.subject).toBe(`【ほめゴハン運用】DB バックアップが ${BACKUP_STALE_AFTER_HOURS} 時間以上取れていません`);
    expect(envelope.text).toContain(`${SITE_URL}/super-admin/backups`);
    expect(envelope.text).toContain('最新の取得: 記録なし');
  });

  it('M-2: メールの本文・件名に宛先・利用者の情報が無い (DB の行に余分な列が混ざっても載せない)', async () => {
    setScenario({
      latest: {
        data: { created_at: hoursAgo(40), actor_id: 'user-1234', details: { email: 'taro@example.test' } },
        error: null,
      },
    });

    await GET(authed());

    const envelope = mocks.sendEmail.mock.calls[0][0];
    for (const leaked of [OPS_EMAIL, 'user-1234', 'taro@example.test']) {
      expect(envelope.text).not.toContain(leaked);
      expect(envelope.subject).not.toContain(leaked);
    }
  });

  it('M-3: 応答の JSON とログに、通知先のメールアドレスは出ない。送れたときの warn は最新の日時としきい値と送信待ちの id', async () => {
    setStale();

    const res = await GET(authed());

    expect(JSON.stringify(await res.json())).not.toContain(OPS_EMAIL);
    const logs = JSON.stringify([...mocks.logInfo.mock.calls, ...mocks.logWarn.mock.calls, ...mocks.logError.mock.calls]);
    expect(logs).not.toContain(OPS_EMAIL);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toEqual({
      status: 'stale_sent',
      latest_completed_at: null,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      outbox_id: 'email-id-1',
    });
  });

  it('M-4: 送れなかったときの warn にも最新の日時としきい値と失敗のコードが載る (宛先は無い)', async () => {
    const latest = hoursAgo(50);
    setScenario({ latest: { data: { created_at: latest }, error: null } });
    mocks.sendEmail.mockResolvedValue(failedResult);

    await GET(authed());

    const staleWarn = mocks.logWarn.mock.calls.find(([, meta]) => (meta as { status?: string })?.status === 'stale_send_failed');
    expect(staleWarn?.[1]).toEqual({
      status: 'stale_send_failed',
      latest_completed_at: latest,
      stale_after_hours: BACKUP_STALE_AFTER_HOURS,
      error_code: 'validation_error',
    });
  });
});

// ---------------------------------------------------------------
// そのほか
// ---------------------------------------------------------------
describe('GET /api/cron/backup-freshness: そのほか (#1129)', () => {
  it('O-1: vercel.json の crons に、path が BACKUP_FRESHNESS_CRON_PATH で schedule が BACKUP_FRESHNESS_SCHEDULE_UTC の行がちょうど 1 本あり、既存の cron が残っている', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };

    expect(BACKUP_FRESHNESS_CRON_PATH).toBe('/api/cron/backup-freshness');
    expect(BACKUP_FRESHNESS_SCHEDULE_UTC).toBe('37 5 * * *');
    expect(vercel.crons.filter((cron) => cron.path === BACKUP_FRESHNESS_CRON_PATH)).toEqual([
      { path: BACKUP_FRESHNESS_CRON_PATH, schedule: BACKUP_FRESHNESS_SCHEDULE_UTC },
    ]);
    for (const existing of ['/api/cron/process-menu-queue', '/api/cron/app-log-alerts']) {
      expect(vercel.crons.filter((cron) => cron.path === existing), existing).toHaveLength(1);
    }
  });

  it('O-2: GET だけを公開し、Node.js ランタイム・キャッシュしない設定になっている', () => {
    expect(
      Object.keys(routeModule).filter((key) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(key)),
    ).toEqual(['GET']);
    expect(routeModule.runtime).toBe('nodejs');
    expect(routeModule.dynamic).toBe('force-dynamic');
    expect(routeModule.fetchCache).toBe('force-no-store');
    expect(routeModule.maxDuration).toBe(60);
  });

  it('O-3: 応答を返したあとも関数を延命して、ログを書き切らせる (認証で断った要求は対象外)', async () => {
    await GET(makeRequest());
    expect(mocks.waitUntil).not.toHaveBeenCalled();

    await GET(authed());
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);

    // 宛先が未設定で info ログだけの回も、そのログを書き切らせる
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);
    await GET(authed());
    expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('O-4: DB への入口は admin_audit_logs の select と 2 つの RPC (claim_ops_alert・release_ops_alert) だけ', async () => {
    setStale();
    mocks.sendEmail.mockResolvedValue(failedResult);

    await GET(authed());

    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(['admin_audit_logs']);
    expect([...new Set(mocks.rpc.mock.calls.map(([fn]) => fn))].sort()).toEqual(['claim_ops_alert', 'release_ops_alert']);
  });
});
