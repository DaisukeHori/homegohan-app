import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { CRON_SECRET_FINDING_CATALOG, type CronSecretFindingId } from '@/lib/ops-alerts/cron-secret-drift';

// #1157 GET /api/cron/app-log-alerts — 本番エラーの急増を運用メールに知らせる cron。
// DB (Supabase の RPC)・メール送信 (sendEmail)・ロガーはモックにし、route 本体と、文面・判定の部品は実物を通す。
// DB 側の関数 (app_log_error_counts / claim_ops_alert / release_ops_alert) の挙動は、
// 結合テスト tests/integration/rls/ops-alert-state.test.ts で実際の PostgreSQL に対して確かめる。
// 値はすべてテスト用のダミー。本物のシークレット・アドレスは使わない。

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
  /** true の間、定期処理の失敗の文面を作る関数が例外を投げる (#1125 の B。P-28) */
  renderCronFailureThrows: false,
  /** true の間、pg_cron の停止の文面を作る関数が例外を投げる (#1125 の B。P-24) */
  renderPgCronStalledThrows: false,
  /** true の間、cron の共有シークレットのずれの文面を作る関数が例外を投げる (#1560。CS-6) */
  renderCronSecretDriftThrows: false,
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
vi.mock('@/lib/emails/ops/app-log-error-spike', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/ops/app-log-error-spike')>();
  return {
    ...actual,
    renderAppLogErrorSpikeEmail: (vars: Parameters<typeof actual.renderAppLogErrorSpikeEmail>[0]) => {
      if (mocks.renderThrows) throw new Error('render failed');
      return actual.renderAppLogErrorSpikeEmail(vars);
    },
  };
});

// #1125 (B) 定期処理の失敗・pg_cron の停止の文面も実物を通し、それぞれのフラグが true のときだけ例外にする
vi.mock('@/lib/emails/ops/cron-failure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/ops/cron-failure')>();
  return {
    ...actual,
    renderCronFailureEmail: (vars: Parameters<typeof actual.renderCronFailureEmail>[0]) => {
      if (mocks.renderCronFailureThrows) throw new Error('render failed');
      return actual.renderCronFailureEmail(vars);
    },
  };
});
vi.mock('@/lib/emails/ops/pg-cron-stalled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/ops/pg-cron-stalled')>();
  return {
    ...actual,
    renderPgCronStalledEmail: (vars: Parameters<typeof actual.renderPgCronStalledEmail>[0]) => {
      if (mocks.renderPgCronStalledThrows) throw new Error('render failed');
      return actual.renderPgCronStalledEmail(vars);
    },
  };
});

// #1560 cron の共有シークレットのずれ・入れ替えの途中の文面も実物を通し、フラグが true のときだけ例外にする
vi.mock('@/lib/emails/ops/cron-secret-drift', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/ops/cron-secret-drift')>();
  return {
    ...actual,
    renderCronSecretDriftEmail: (vars: Parameters<typeof actual.renderCronSecretDriftEmail>[0]) => {
      if (mocks.renderCronSecretDriftThrows) throw new Error('render failed');
      return actual.renderCronSecretDriftEmail(vars);
    },
  };
});

const { GET } = await import('@/app/api/cron/app-log-alerts/route');

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const OLD_SECRET = 'dummy-old-cron-secret-fedcba9876543210';
const OPS_EMAIL = 'ops-owner@example.test';
const SITE_URL = 'https://app.example.test';
const CLAIMED_AT = '2026-10-09T01:15:00.123456+00:00';
const CLIENT_CLAIMED_AT = '2026-10-09T01:15:00.654321+00:00';
/** #1193 届けられなかったメールの通知のキー (email_dead_letter) で権利を取った時刻 (= 印 dead_alerted_at の値) */
const DEAD_CLAIMED_AT = '2026-10-09T01:15:00.789012+00:00';

/** #1493 クライアントの error が無いときの、応答の client (既定のしきい値 100 件) */
const CLIENT_QUIET = { status: 'below_threshold', total: 0, threshold: 100 } as const;
/** #1193 まだ知らせていない dead が無いときの、応答の email_dead_letter (しきい値 0 = 1 件から) */
const DEAD_LETTER_QUIET = { status: 'below_threshold', total: 0, threshold: 0 } as const;
/** #1125 (B) 定期処理の失敗の通知のキー (cron_failure) で権利を取った時刻 (= 台帳の印 alerted_at の値) */
const CRON_FAILURE_CLAIMED_AT = '2026-10-09T01:15:00.246802+00:00';
/** #1125 (B) pg_cron の停止の通知のキー (pg_cron_stalled) で権利を取った時刻 */
const PG_CRON_STALLED_CLAIMED_AT = '2026-10-09T01:15:00.135791+00:00';
/** #1125 (B) まだ知らせていない定期処理の失敗が無いときの、応答の cron_failure (しきい値 0 = 1 件から) */
const CRON_FAILURE_QUIET = { status: 'below_threshold', total: 0, threshold: 0 } as const;
/** #1125 (B) pg_cron が無い (既定の場面) ときの、応答の pg_cron_stalled (既定のしきい値 60 分) */
const PG_CRON_STALLED_QUIET = { status: 'below_threshold', total: 0, threshold: 60 } as const;
/** #1560 ずれの通知のキー (cron_secret_drift) で権利を取った時刻 */
const CRON_SECRET_DRIFT_CLAIMED_AT = '2026-10-09T01:15:00.357913+00:00';
/** #1560 入れ替えの途中の通知のキー (cron_secret_rotation) で権利を取った時刻 */
const CRON_SECRET_ROTATION_CLAIMED_AT = '2026-10-09T01:15:00.468024+00:00';
/** #1560 所見が無いときの、応答の cron_secret_drift / cron_secret_rotation (しきい値 0 = 1 件から) */
const CRON_SECRET_QUIET = { status: 'below_threshold', total: 0, threshold: 0 } as const;
/** #1560 既定の場面の確認の結果 (前の回の確認が 200 current。所見なし)。requested_at は「いま」から 15 分前 */
const probeRowOk = () => [
  {
    probe_id: 41,
    requested_at: new Date(Date.now() - 15 * 60_000).toISOString(),
    send_state: 'sent',
    answered: true,
    http_status: 200,
    timed_out: false,
    has_error: false,
    matched: 'current',
    previous_configured: false,
    alias_used: false,
    body_error: null,
    body_code: null,
  },
];
/** #1560 既定の場面の確認の送信の応答 */
const PROBE_SENT = [{ probe_id: 42, send_state: 'sent', request_id: 9002 }];

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/app-log-alerts', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

const authed = () => makeRequest(`Bearer ${SECRET}`);

interface CountRow {
  function_name: string | null;
  error_count: number;
  total_count: number;
  [extra: string]: unknown;
}

/** 全体が 42 件 (しきい値 20 を超える) の、ふつうの急増 */
const SURGE_ROWS: CountRow[] = [
  { function_name: 'POST /api/meals', error_count: 30, total_count: 42 },
  { function_name: 'cron/process-menu-queue', error_count: 8, total_count: 42 },
  { function_name: null, error_count: 4, total_count: 42 },
];

/** #1193 まだ知らせていない (または印を付けた) dead の行 (email_outbox_dead_counts / mark_email_outbox_dead_alerted の形)。全体 3 件 */
const DEAD_ROWS = [
  { template: 'family_invite', dead_count: 2, total_count: 3 },
  { template: 'support_ticket_reply', dead_count: 1, total_count: 3 },
];

/** 全体が total 件で、1 つの関数に集中している行 */
const rowsOf = (total: number): CountRow[] =>
  total === 0 ? [] : [{ function_name: 'POST /api/meals', error_count: total, total_count: total }];

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

interface Scenario {
  counts: RpcResult;
  claim: RpcResult;
  release: RpcResult;
  /** #1493 ブラウザ・端末から届いた error の数え方 (app_log_client_error_counts) の応答 */
  clientCounts: RpcResult;
  /** #1493 クライアントの通知のキー (app_logs_client_error_spike) で権利を取ったときの応答 */
  clientClaim: RpcResult;
  /** #1193 まだ知らせていない dead の数え方 (email_outbox_dead_counts) の応答 */
  deadCounts: RpcResult;
  /** #1193 届けられなかったメールの通知のキー (email_dead_letter) で権利を取ったときの応答 */
  deadClaim: RpcResult;
  /** #1193 印を付ける RPC (mark_email_outbox_dead_alerted) の応答 (印を付けた行の template ごとの件数) */
  deadMark: RpcResult;
  /** #1193 印を外す RPC (unmark_email_outbox_dead_alerted) の応答 (外した行数) */
  deadUnmark: RpcResult;
  /** #1125 (B) まだ知らせていない定期処理の失敗の数え方 (cron_failure_counts) の応答 */
  cronFailureCounts: RpcResult;
  /** #1125 (B) 定期処理の失敗の通知のキー (cron_failure) で権利を取ったときの応答 */
  cronFailureClaim: RpcResult;
  /** #1125 (B) 台帳に印を付ける RPC (mark_cron_failures_alerted) の応答 */
  cronFailureMark: RpcResult;
  /** #1125 (B) 台帳の印を外す RPC (unmark_cron_failures_alerted) の応答 (外した行数) */
  cronFailureUnmark: RpcResult;
  /** #1125 (B) pg_cron の最新の実行の読み取り (pg_cron_last_run_at) の応答 */
  pgCronLastRun: RpcResult;
  /** #1125 (B) pg_cron の停止の通知のキー (pg_cron_stalled) で権利を取ったときの応答 */
  pgCronStalledClaim: RpcResult;
  /** #1560 確認の結果 (cron_secret_probe_results) の応答 */
  cronSecretResults: RpcResult;
  /** #1560 確認の送信 (send_cron_secret_probe) の応答 */
  cronSecretSend: RpcResult;
  /** #1560 ずれの通知のキー (cron_secret_drift) で権利を取ったときの応答 */
  cronSecretDriftClaim: RpcResult;
  /** #1560 入れ替えの途中の通知のキー (cron_secret_rotation) で権利を取ったときの応答 */
  cronSecretRotationClaim: RpcResult;
}

let scenario: Scenario;

function setScenario(overrides: Partial<Scenario> = {}) {
  scenario = {
    counts: { data: SURGE_ROWS, error: null },
    claim: { data: CLAIMED_AT, error: null },
    release: { data: true, error: null },
    // クライアントの error は、既定では 1 件も無い (サーバーの判定だけを見るテストに混ざらないように)
    clientCounts: { data: [], error: null },
    clientClaim: { data: CLIENT_CLAIMED_AT, error: null },
    // まだ知らせていない dead は、既定では 1 件も無い (印を付ける・外す RPC は呼ばれない)
    deadCounts: { data: [], error: null },
    deadClaim: { data: DEAD_CLAIMED_AT, error: null },
    deadMark: { data: DEAD_ROWS, error: null },
    deadUnmark: { data: 0, error: null },
    // 既定では失敗が 1 件も無く、pg_cron の無い DB と同じ (既存のテストに混ざらない)
    cronFailureCounts: { data: [], error: null },
    cronFailureClaim: { data: CRON_FAILURE_CLAIMED_AT, error: null },
    cronFailureMark: { data: [], error: null },
    cronFailureUnmark: { data: 0, error: null },
    pgCronLastRun: { data: [{ cron_available: false, active_jobs: 0, last_run_at: null }], error: null },
    pgCronStalledClaim: { data: PG_CRON_STALLED_CLAIMED_AT, error: null },
    // 既定では前の回の確認が 200 current で所見が無い (既存のテストに混ざらない)
    cronSecretResults: { data: probeRowOk(), error: null },
    cronSecretSend: { data: PROBE_SENT, error: null },
    cronSecretDriftClaim: { data: CRON_SECRET_DRIFT_CLAIMED_AT, error: null },
    cronSecretRotationClaim: { data: CRON_SECRET_ROTATION_CLAIMED_AT, error: null },
    ...overrides,
  };
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
  mocks.renderThrows = false;
  mocks.renderCronFailureThrows = false;
  mocks.renderPgCronStalledThrows = false;
  mocks.renderCronSecretDriftThrows = false;
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
  // しきい値・クールダウンの上書きは、既定では無し (実行環境に設定があっても、既定値で確かめる)
  vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', undefined);
  vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', undefined);
  vi.stubEnv('OPS_ALERT_CLIENT_ERROR_THRESHOLD', undefined);
  vi.stubEnv('OPS_ALERT_PG_CRON_STALL_MINUTES', undefined);
  vi.stubEnv('OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES', undefined);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  setScenario();
  mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
    if (fn === 'app_log_error_counts') return scenario.counts;
    if (fn === 'app_log_client_error_counts') return scenario.clientCounts;
    if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;
    if (fn === 'mark_email_outbox_dead_alerted') return scenario.deadMark;
    if (fn === 'unmark_email_outbox_dead_alerted') return scenario.deadUnmark;
    if (fn === 'cron_failure_counts') return scenario.cronFailureCounts;
    if (fn === 'mark_cron_failures_alerted') return scenario.cronFailureMark;
    if (fn === 'unmark_cron_failures_alerted') return scenario.cronFailureUnmark;
    if (fn === 'pg_cron_last_run_at') return scenario.pgCronLastRun;
    if (fn === 'cron_secret_probe_results') return scenario.cronSecretResults;
    if (fn === 'send_cron_secret_probe') return scenario.cronSecretSend;
    if (fn === 'claim_ops_alert') {
      if (args?.p_alert_key === 'email_dead_letter') return scenario.deadClaim;
      if (args?.p_alert_key === 'cron_failure') return scenario.cronFailureClaim;
      if (args?.p_alert_key === 'pg_cron_stalled') return scenario.pgCronStalledClaim;
      if (args?.p_alert_key === 'cron_secret_drift') return scenario.cronSecretDriftClaim;
      if (args?.p_alert_key === 'cron_secret_rotation') return scenario.cronSecretRotationClaim;
      return args?.p_alert_key === 'app_logs_client_error_spike' ? scenario.clientClaim : scenario.claim;
    }
    if (fn === 'release_ops_alert') return scenario.release;
    throw new Error(`想定外の RPC: ${fn}`);
  });
  mocks.sendEmail.mockResolvedValue(sentResult);
});

afterEach(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
  vi.unstubAllEnvs();
});

/** 認証・宛先の確認より先に、DB・メール・ログに何も触れていないこと */
function expectNothingTouched() {
  expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.sendEmail).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------
// 認証
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: 認証 (#1157)', () => {
  it('A-1: Authorization ヘッダーが無ければ 401。DB・メール・ログには何も触れない', async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    expectNothingTouched();
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('A-2: 誤ったシークレット (同じ長さ・短い・長い・Bearer なし) は 401', async () => {
    const wrongValues = [
      `Bearer ${'x'.repeat(SECRET.length)}`,
      'Bearer short',
      `Bearer ${SECRET}x`,
      SECRET,
      `bearer ${SECRET}`,
    ];
    for (const value of wrongValues) {
      const res = await GET(makeRequest(value));
      expect(res.status, value).toBe(401);
    }
    expectNothingTouched();
  });

  it('A-3: OPS_ALERT_EMAIL が未設定でも、認証の無いリクエストは 401 のまま (info ログを増やされない)', async () => {
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mocks.logInfo).not.toHaveBeenCalled();
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
    await expect(res.json()).resolves.toMatchObject({ status: 'sent' });
  });

  it('A-6: 正しいシークレットなら 200 で処理が走る', async () => {
    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// 宛先 (OPS_ALERT_EMAIL)
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: 宛先 OPS_ALERT_EMAIL (#1157)', () => {
  it('C-1: 未設定なら何もしない: 200 disabled。info ログが 1 回だけで、DB にもメールにも触れない', async () => {
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'disabled' });
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
    expectNothingTouched();
  });

  it('C-2: 空文字・空白だけも未設定と同じ扱い', async () => {
    for (const blank of ['', '   ', '\n\t']) {
      vi.stubEnv('OPS_ALERT_EMAIL', blank);
      mocks.logInfo.mockClear();

      const res = await GET(authed());

      await expect(res.json(), JSON.stringify(blank)).resolves.toEqual({ status: 'disabled' });
      expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    }
    expectNothingTouched();
  });

  it('C-3: メールアドレス (1 つ) の形でなければ送らない: 200 invalid_config。warn を残し、設定値はログに出さない', async () => {
    for (const invalid of ['not-an-email', 'ops@', 'a@example.test, b@example.test', 'ほめゴハン <ops@example.test>']) {
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

  it('C-4: 前後の空白は取り除いて宛先にする', async () => {
    vi.stubEnv('OPS_ALERT_EMAIL', `  ${OPS_EMAIL}\n`);

    await GET(authed());

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(OPS_EMAIL);
  });
});

// ---------------------------------------------------------------
// しきい値
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: しきい値 (#1157)', () => {
  it('H-1: 直近 15 分の窓・上位 10 関数で、error の件数を数える', async () => {
    await GET(authed());

    expect(rpcCalls('app_log_error_counts')).toEqual([
      ['app_log_error_counts', { p_window_minutes: 15, p_limit: 10 }],
    ]);
  });

  it('H-2: 20 件ちょうどは通知しない: below_threshold。権利も取らず、メールも送らない', async () => {
    setScenario({ counts: { data: rowsOf(20), error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'below_threshold', total: 20, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 何も起きなかった回は、ログを増やさない (15 分おきに積み上がらない)
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('H-3: 21 件から通知する: 権利を取り、メールを 1 通送る', async () => {
    setScenario({ counts: { data: rowsOf(21), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 21, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('H-4: error が 1 件も無ければ (DB が空の配列を返す) 通知しない', async () => {
    setScenario({ counts: { data: [], error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'below_threshold', total: 0, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('H-5: 関数ごとではなく全体の合計で判定する (5 件ずつ 5 関数 = 25 件なら通知する)', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      function_name: `fn-${i}`,
      error_count: 5,
      total_count: 25,
    }));
    setScenario({ counts: { data: rows, error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ status: 'sent', total: 25 });
  });

  it('H-6: 上位だけが返ってきても、全体の件数 (total_count) で判定する (上位の合計は 18 件でも、全体が 30 件なら通知する)', async () => {
    setScenario({
      counts: {
        data: [
          { function_name: 'a', error_count: 10, total_count: 30 },
          { function_name: 'b', error_count: 8, total_count: 30 },
        ],
        error: null,
      },
    });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ status: 'sent', total: 30 });
    const body = mocks.sendEmail.mock.calls[0][0].text as string;
    expect(body).toContain('直近 15 分で 30 件');
    expect(body).toContain('ほかの関数: 合計 12 件');
  });
});

// ---------------------------------------------------------------
// 重複の抑止
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: 同じアラートを 60 分は送り直さない (#1157)', () => {
  it('D-1: 権利は固定のキーとクールダウン 60 分で取る', async () => {
    await GET(authed());

    expect(rpcCalls('claim_ops_alert')).toEqual([
      ['claim_ops_alert', { p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 60 }],
    ]);
  });

  it('D-2: クールダウン中 (権利が取れない = NULL) なら送らない: deduped。権利を返す操作もしない', async () => {
    setScenario({ claim: { data: null, error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'deduped', total: 42, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });

  it('D-3: 急増が続いて何度呼ばれても、権利を取れた 1 回だけメールが出る', async () => {
    // DB の挙動を写す: 最初の 1 回だけ権利を取れて、以降はクールダウン中
    let claims = 0;
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'cron_failure_counts' || fn === 'pg_cron_last_run_at' || fn === 'cron_secret_probe_results' || fn === 'send_cron_secret_probe') return harness?.(fn, args);
      if (fn === 'app_log_error_counts') return scenario.counts;
      if (fn === 'app_log_client_error_counts') return scenario.clientCounts;
      if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;
      if (fn === 'claim_ops_alert') {
        claims += 1;
        return { data: claims === 1 ? CLAIMED_AT : null, error: null };
      }
      return scenario.release;
    });

    const statuses: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await (await GET(authed())).json()).status);
    }

    expect(statuses).toEqual(['sent', 'deduped', 'deduped', 'deduped']);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('D-4: 権利を取る前にはメールを送らない (数える → 権利を取る → 送る の順)。最後に届けられなかったメールを数える', async () => {
    const order: string[] = [];
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      order.push(fn);
      if (fn === 'cron_failure_counts' || fn === 'pg_cron_last_run_at' || fn === 'cron_secret_probe_results' || fn === 'send_cron_secret_probe') return harness?.(fn, args);
      if (fn === 'app_log_client_error_counts') return scenario.clientCounts;
      if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;
      return fn === 'app_log_error_counts' ? scenario.counts : fn === 'claim_ops_alert' ? scenario.claim : scenario.release;
    });
    mocks.sendEmail.mockImplementation(async () => {
      order.push('sendEmail');
      return sentResult;
    });

    await GET(authed());

    // サーバーの判定 (数える → 権利 → 送る) を済ませてから、クライアントの error を数える (#1493)
    // その後に届けられなかったメール (#1193) を数える
    expect(order).toEqual(['app_log_error_counts', 'claim_ops_alert', 'sendEmail', 'app_log_client_error_counts', 'email_outbox_dead_counts', 'cron_failure_counts', 'pg_cron_last_run_at', 'cron_secret_probe_results', 'send_cron_secret_probe']);
  });

  it('D-5: 送れたときは権利を返さない (60 分の抑止が効く)', async () => {
    await GET(authed());

    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// しきい値・クールダウンの上書き (環境変数)
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: しきい値とクールダウンを環境変数で変える (#1157)', () => {
  it('E-1: OPS_ALERT_ERROR_THRESHOLD でしきい値を変える (50 なら 50 件は通知せず、51 件から通知する)。応答にも新しい値が出る', async () => {
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', '50');

    setScenario({ counts: { data: rowsOf(50), error: null } });
    const atThreshold = await GET(authed());
    await expect(atThreshold.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 50,
      threshold: 50,
      window_minutes: 15,
      client: CLIENT_QUIET,
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    setScenario({ counts: { data: rowsOf(51), error: null } });
    const over = await GET(authed());
    await expect(over.json()).resolves.toEqual({ status: 'sent', total: 51, threshold: 50, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // メールの文面のしきい値も、上書きした値になる
    expect(mocks.sendEmail.mock.calls[0][0].text as string).toContain('15 分で 50 件を超えると');
    // 正しい値なら warn は残さない
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('E-2: しきい値を下げると、既定では通知しない件数でも通知する (5 なら 6 件で通知)', async () => {
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', ' 5 ');
    setScenario({ counts: { data: rowsOf(6), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 6, threshold: 5, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
  });

  it('E-3: OPS_ALERT_COOLDOWN_MINUTES で、権利を取るときのクールダウンを変える。メールの文面も同じ値', async () => {
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', '120');

    await GET(authed());

    expect(rpcCalls('claim_ops_alert')).toEqual([
      ['claim_ops_alert', { p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 120 }],
    ]);
    expect(mocks.sendEmail.mock.calls[0][0].text as string).toContain('同じ通知は 120 分以内には送り直しません');
  });

  it('E-4: 不正な値 (整数でない・範囲外) は既定値 (20 件・60 分) に戻して通知を続け、変数名だけを warn に残す (値は出さない)', async () => {
    const invalid: ReadonlyArray<readonly [string, string]> = [
      ['abc', 'x'],
      ['0', '0'],
      ['-5', '-1'],
      ['2.5', '1.5'],
      ['1e3', '1e2'],
      ['100001', '10081'],
    ];
    for (const [threshold, cooldown] of invalid) {
      vi.clearAllMocks();
      vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', threshold);
      vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', cooldown);
      setScenario({ counts: { data: rowsOf(21), error: null } });

      const res = await GET(authed());

      await expect(res.json(), threshold).resolves.toEqual({ status: 'sent', total: 21, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
      expect(rpcCalls('claim_ops_alert'), cooldown).toEqual([
        ['claim_ops_alert', { p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 60 }],
      ]);
      expect(mocks.logWarn, threshold).toHaveBeenCalledTimes(1);
      const [message, meta] = mocks.logWarn.mock.calls[0];
      expect(message).toContain('既定値を使います');
      expect(meta).toEqual({ ignored_env: ['OPS_ALERT_ERROR_THRESHOLD', 'OPS_ALERT_COOLDOWN_MINUTES'] });
      expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(`"${threshold}"`);
    }
  });

  it('E-5: 片方だけ不正なら、その変数だけを既定値に戻す (もう片方の上書きは効く)', async () => {
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', '30');
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', 'soon');
    setScenario({ counts: { data: rowsOf(31), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 31, threshold: 30, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('claim_ops_alert')[0][1]).toEqual({ p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 60 });
    expect(mocks.logWarn.mock.calls[0][1]).toEqual({ ignored_env: ['OPS_ALERT_COOLDOWN_MINUTES'] });
  });

  it('E-6: 空・空白だけは未設定と同じ (既定値。warn も残さない)', async () => {
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', '');
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', '   ');

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 42, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('claim_ops_alert')[0][1]).toEqual({ p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 60 });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('E-7: 権利を返せなかったときの warn は、上書きしたクールダウンの分数を書く', async () => {
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', '90');
    mocks.sendEmail.mockResolvedValue(failedResult);
    setScenario({ release: { data: null, error: { code: '57014', message: 'timeout' } } });

    await GET(authed());

    const warnMessages = mocks.logWarn.mock.calls.map(([message]) => String(message));
    expect(warnMessages).toContain('送る権利を返せませんでした。次の通知が最大 90 分遅れることがあります');
  });

  it('E-8: 宛先 (OPS_ALERT_EMAIL) が未設定なら、しきい値の値が不正でも warn を増やさない (何もしない回は静かに終わる)', async () => {
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', 'abc');

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'disabled' });
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// メールの内容
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: メールの内容 (#1157)', () => {
  it('M-1: 宛先は OPS_ALERT_EMAIL。件数・関数名・運用ログ画面へのリンクが載る', async () => {
    await GET(authed());

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0];
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.template).toBe('ops_app_log_error_spike');
    expect(envelope.subject).toBe('【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)');
    expect(envelope.text).toContain('POST /api/meals … 30 件');
    expect(envelope.text).toContain('cron/process-menu-queue … 8 件');
    expect(envelope.text).toContain('(関数名なし) … 4 件');
    expect(envelope.text).toContain(`${SITE_URL}/super-admin/logs`);
  });

  it('M-2: リンクはサイトの URL (NEXT_PUBLIC_APP_URL) に従う。末尾のスラッシュは重ねない', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://homegohan.example.test/');

    await GET(authed());

    const text = mocks.sendEmail.mock.calls[0][0].text as string;
    expect(text).toContain('https://homegohan.example.test/super-admin/logs');
    expect(text).not.toContain('//super-admin');
  });

  it('M-3: DB の応答にユーザー ID・ログの本文などの余分な列が混ざっても、メールには出ない', async () => {
    const withExtras = SURGE_ROWS.map((row, i) => ({
      ...row,
      user_id: `0000000${i}-1111-4222-8333-444444444444`,
      message: `SEED-MESSAGE-${i} (taro@example.test の注文に失敗)`,
      error_message: 'duplicate key value violates unique constraint',
      error_stack: 'at handler (/var/task/app.js:1:1)',
      email: 'someone@example.test',
    }));
    setScenario({ counts: { data: withExtras, error: null } });

    await GET(authed());

    const envelope = JSON.stringify(mocks.sendEmail.mock.calls[0][0]);
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);
    for (const leaked of ['0000000', 'SEED-MESSAGE', 'taro@', 'someone@', 'duplicate key', 'at handler']) {
      expect(envelope, `メール: ${leaked}`).not.toContain(leaked);
      expect(logged, `ログ: ${leaked}`).not.toContain(leaked);
    }
  });

  it('M-4: 関数名にユーザー ID・メールアドレスが含まれていても、メールにもログにも出ない', async () => {
    setScenario({
      counts: {
        data: [
          { function_name: 'GET /api/users/123e4567-e89b-12d3-a456-426614174000/notes', error_count: 25, total_count: 37 },
          { function_name: 'notify taro.yamada@example.test', error_count: 12, total_count: 37 },
        ],
        error: null,
      },
    });

    await GET(authed());

    const sentEnvelope = JSON.stringify(mocks.sendEmail.mock.calls[0][0]);
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);
    for (const text of [sentEnvelope, logged]) {
      expect(text).not.toContain('123e4567');
      expect(text).not.toContain('taro.yamada');
    }
    expect(sentEnvelope).toContain('GET /api/users/[id]/notes');
  });

  it('M-5: 応答の JSON とログに、通知先のメールアドレスは出ない', async () => {
    const res = await GET(authed());
    const body = JSON.stringify(await res.json());
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);

    expect(body).not.toContain(OPS_EMAIL);
    expect(body).not.toContain('ops-owner');
    expect(logged).not.toContain(OPS_EMAIL);
    expect(logged).not.toContain('ops-owner');
  });

  it('M-6: 送れたら info を 1 行残す (件数と関数名・メールの ID だけ。宛先は出さない)', async () => {
    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 42, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [, meta] = mocks.logInfo.mock.calls[0];
    expect(meta).toMatchObject({
      total: 42,
      threshold: 20,
      window_minutes: 15,
      other_count: 0,
      outbox_id: 'email-id-1',
    });
    expect(meta.functions).toEqual([
      { name: 'POST /api/meals', count: 30 },
      { name: 'cron/process-menu-queue', count: 8 },
      { name: '(関数名なし)', count: 4 },
    ]);
  });
});

// ---------------------------------------------------------------
// メールを送れなかったとき
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: メールが届かなくても壊れない (#1157)', () => {
  it('F-1: Resend が断った (送信失敗) → 取った権利を返し、200 send_failed。件数と関数名を warn に残す', async () => {
    mocks.sendEmail.mockResolvedValue(failedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'send_failed', total: 42, threshold: 20, window_minutes: 15, client: CLIENT_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    // claim が返した時刻をそのまま渡す (同じ時刻の行だけを消すため)
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'app_logs_error_spike', p_claimed_at: CLAIMED_AT }],
    ]);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [message, meta] = mocks.logWarn.mock.calls[0];
    expect(message).toContain('通知メールを送れませんでした');
    expect(meta).toMatchObject({ total: 42, error_code: 'validation_error' });
    expect(meta.functions).toHaveLength(3);
    expect(mocks.logInfo).not.toHaveBeenCalled();
  });

  it('F-2: RESEND_API_KEY 未設定で送らなかった (skipped) → 権利を返し、200 send_skipped', async () => {
    mocks.sendEmail.mockResolvedValue(skippedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'send_skipped', total: 42 });
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][0]).toContain('メールの送信設定が未完了');
  });

  it('F-3: 権利を返したあとの次の回 (15 分後) で、まだ急増していれば、もう一度送ろうとする', async () => {
    // 1 回目: 送信失敗 → 権利を返す。2 回目: DB は権利を渡し直す → 今度は送れる
    mocks.sendEmail.mockResolvedValueOnce(failedResult).mockResolvedValueOnce(sentResult);

    const first = await (await GET(authed())).json();
    const second = await (await GET(authed())).json();

    expect(first.status).toBe('send_failed');
    expect(second.status).toBe('sent');
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
  });

  it('F-4: sendEmail が想定外の例外を投げても、権利を返してから 500 (汎用メッセージ)', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('socket hang up while sending to ops-owner@example.test'));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('socket hang up');
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('F-4b: 文面を作る処理が権利を取ったあとに例外を投げても、権利を返してから 500 (60 分の沈黙を残さない)', async () => {
    mocks.renderThrows = true;

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'app_logs_error_spike', p_claimed_at: CLAIMED_AT }],
    ]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('F-5: 権利を返す操作が失敗しても、応答は send_failed のまま。warn を残す (例外にしない)', async () => {
    mocks.sendEmail.mockResolvedValue(failedResult);
    setScenario({ release: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'send_failed' });
    const warnMessages = mocks.logWarn.mock.calls.map(([message]) => String(message));
    expect(warnMessages.some((m) => m.includes('送る権利を返せませんでした'))).toBe(true);
  });

  it('F-6: 権利を返す RPC が例外を投げても、応答は send_failed のまま', async () => {
    mocks.sendEmail.mockResolvedValue(failedResult);
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'cron_failure_counts' || fn === 'pg_cron_last_run_at' || fn === 'cron_secret_probe_results' || fn === 'send_cron_secret_probe') return harness?.(fn, args);
      if (fn === 'app_log_error_counts') return scenario.counts;
      if (fn === 'app_log_client_error_counts') return scenario.clientCounts;
      if (fn === 'email_outbox_dead_counts') return scenario.deadCounts;
      if (fn === 'claim_ops_alert') return scenario.claim;
      throw new Error('network down');
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'send_failed' });
  });
});

// ---------------------------------------------------------------
// DB の失敗
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: DB の失敗は 500 (汎用メッセージ) (#1172)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  const RAW = 'relation "public.app_logs" does not exist (host=db.internal.example.test)';

  it('X-1: 数える RPC が失敗 → 500。DB の生のエラー文は返さず、app_logs に残す。権利も取らず、メールも送らない', async () => {
    setScenario({ counts: { data: null, error: { code: '42P01', message: RAW } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(GENERIC);
    expect(JSON.stringify(body)).not.toContain('app_logs');
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][1]).toBeInstanceOf(Error);
    expect(String((mocks.logError.mock.calls[0][1] as Error).message)).toContain('app_logs');
  });

  it('X-2: 権利を取る RPC が失敗 → 500。メールは送らない', async () => {
    setScenario({ claim: { data: null, error: { code: '42501', message: RAW } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });

  it('X-3: 数える RPC の応答の形が想定外 → 500 (黙って 0 件として扱わない)。メールは送らない', async () => {
    for (const data of [{ rows: [] }, 'oops', [{ function_name: 'a', error_count: -3, total_count: 1 }]]) {
      setScenario({ counts: { data, error: null } });
      mocks.logError.mockClear();

      const res = await GET(authed());

      expect(res.status, JSON.stringify(data)).toBe(500);
      await expect(res.json()).resolves.toEqual(GENERIC);
      expect(mocks.logError).toHaveBeenCalledTimes(1);
    }
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('X-4: Supabase の接続設定が無く、クライアントを作れない → 500', async () => {
    mocks.getSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual(GENERIC);
    expect(JSON.stringify(body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// そのほか
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: そのほか (#1157)', () => {
  it('O-1: infra_alerts を含め、表を直接読み書きしない (DB への入口は RPC だけ。既定の場面で呼ぶのは 9 つ)', async () => {
    await GET(authed());
    mocks.sendEmail.mockResolvedValue(failedResult);
    await GET(authed());

    expect(mocks.from).not.toHaveBeenCalled();
    const used = new Set(mocks.rpc.mock.calls.map(([fn]) => fn));
    expect([...used].sort()).toEqual([
      'app_log_client_error_counts',
      'app_log_error_counts',
      'claim_ops_alert',
      'cron_failure_counts',
      'cron_secret_probe_results',
      'email_outbox_dead_counts',
      'pg_cron_last_run_at',
      'release_ops_alert',
      'send_cron_secret_probe',
    ]);
  });

  it('O-2: vercel.json に 15 分おきで登録されていて、間隔が error を数える窓 (15 分) と同じ', async () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const entries = vercel.crons.filter((cron) => cron.path === '/api/cron/app-log-alerts');

    expect(entries).toEqual([{ path: '/api/cron/app-log-alerts', schedule: '*/15 * * * *' }]);
    const { APP_LOG_ALERT_WINDOW_MINUTES } = await import('@/lib/ops-alerts/app-log-error-spike');
    expect(APP_LOG_ALERT_WINDOW_MINUTES).toBe(15);
    // 既存の cron (献立生成のキュー) を壊していない
    expect(vercel.crons.some((cron) => cron.path === '/api/cron/process-menu-queue')).toBe(true);
  });

  it('O-3: GET だけを公開する (Vercel Cron は GET で呼ぶ)', async () => {
    const routeModule = await import('@/app/api/cron/app-log-alerts/route');

    expect(Object.keys(routeModule).filter((key) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(key))).toEqual(['GET']);
    // sendEmail が使う Resend の SDK と node:crypto は Node.js ランタイムでだけ動く
    expect(routeModule.runtime).toBe('nodejs');
  });

  it('O-4: ログの書き込みを書き切らせるため、応答を返したあとも関数を延命する (認証で断った要求は対象外)', async () => {
    await GET(makeRequest());
    expect(mocks.waitUntil).not.toHaveBeenCalled();

    await GET(authed());
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    // 延命は Promise を渡して行う (待つ時間は短い)
    expect(mocks.waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);

    // 宛先が未設定で info ログだけの回も、そのログを書き切らせる
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);
    await GET(authed());
    expect(mocks.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('O-5: fetch のキャッシュ (Next の Data Cache) を使わない設定になっている (外すと、件数も「送る権利」も毎回同じ古い値になる)', async () => {
    const routeModule = await import('@/app/api/cron/app-log-alerts/route');

    // Next 14 の route handler は、dynamic = 'force-dynamic' だけでは fetch をキャッシュし続けた。
    // supabase-js の RPC (POST) と Resend の呼び出しが、同じ内容なら前回の応答で返ってしまった
    // (ローカルの dev サーバーで、DB の状態を変えても応答が変わらないことで確認した)。
    // Next 15 (#1444) は既定でキャッシュしないが、既定が変わっても古い値を返さないよう、明示の設定を固定しておく。
    expect(routeModule.dynamic).toBe('force-dynamic');
    expect(routeModule.fetchCache).toBe('force-no-store');
  });
});

// ---------------------------------------------------------------
// #1493 ブラウザ・端末から届いた error (source = 'client') は、サーバーの error と別に数えて別に知らせる
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: ブラウザ・端末の error は別のキー・別のしきい値で数える (#1493)', () => {
  /** source='client' の error が total 件 (POST /api/log は function_name を書かないので、関数名なしの 1 グループ) */
  const clientRowsOf = (total: number): CountRow[] =>
    total === 0 ? [] : [{ function_name: null, error_count: total, total_count: total }];

  const claimKeys = () => rpcCalls('claim_ops_alert').map(([, args]) => (args as { p_alert_key: string }).p_alert_key);

  it('K-1: クライアントの error が 21 件 (サーバーの既定のしきい値を超える数) あっても、サーバーの通知は鳴らない。クライアントの 100 件にも届かない', async () => {
    // DB はサーバーの数え方 (app_log_error_counts) から source='client' を除く (結合テスト E-1 で確かめる)。サーバーの error は 0 件
    setScenario({ counts: { data: [], error: null }, clientCounts: { data: clientRowsOf(21), error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 0,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'below_threshold', total: 21, threshold: 100 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 2 つとも、同じ窓 (15 分)・同じ上位 10 件で数える
    expect(rpcCalls('app_log_client_error_counts')).toEqual([
      ['app_log_client_error_counts', { p_window_minutes: 15, p_limit: 10 }],
    ]);
  });

  it('K-2: クライアントの error は 100 件ちょうどでは通知せず、101 件から、クライアント用のキーで権利を取って 1 通送る', async () => {
    setScenario({ counts: { data: [], error: null }, clientCounts: { data: clientRowsOf(100), error: null } });
    const atThreshold = await GET(authed());
    await expect(atThreshold.json()).resolves.toMatchObject({ client: { status: 'below_threshold', total: 100, threshold: 100 } });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    setScenario({ counts: { data: [], error: null }, clientCounts: { data: clientRowsOf(101), error: null } });
    const over = await GET(authed());

    await expect(over.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 0,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'sent', total: 101, threshold: 100 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(rpcCalls('claim_ops_alert')).toEqual([
      ['claim_ops_alert', { p_alert_key: 'app_logs_client_error_spike', p_cooldown_minutes: 60 }],
    ]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0];
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン運用】ブラウザ・端末のエラーが急増しています (直近 15 分で 101 件)');
    expect(envelope.text).toContain('15 分で 100 件を超えると、この通知を送る設定です。');
    expect(envelope.text).toContain(' 1. (関数名なし) … 101 件');
    // 送れたら、クライアントの通知だと分かる info を 1 行残す
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [message, meta] = mocks.logInfo.mock.calls[0];
    expect(message).toBe('ブラウザ・端末のエラー急増を運用メールに知らせました');
    expect(meta).toMatchObject({ scope: 'client', total: 101, threshold: 100, outbox_id: 'email-id-1' });
  });

  it('K-3: クールダウンを共有しない: サーバーの通知がクールダウン中 (deduped) でも、クライアントの急増は知らせる', async () => {
    setScenario({
      claim: { data: null, error: null },
      clientCounts: { data: clientRowsOf(150), error: null },
    });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({
      status: 'deduped',
      total: 42,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'sent', total: 150, threshold: 100 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(claimKeys()).toEqual(['app_logs_error_spike', 'app_logs_client_error_spike']);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toContain('ブラウザ・端末のエラーが急増しています');
  });

  it('K-4: クールダウンを共有しない: クライアントの通知がクールダウン中 (利用者に鳴らされたあと) でも、サーバーの急増は知らせる', async () => {
    setScenario({
      clientCounts: { data: clientRowsOf(400), error: null },
      clientClaim: { data: null, error: null },
    });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({
      status: 'sent',
      total: 42,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'deduped', total: 400, threshold: 100 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(claimKeys()).toEqual(['app_logs_error_spike', 'app_logs_client_error_spike']);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe('【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)');
  });

  it('K-5: 両方が急増していれば、サーバー → クライアントの順に 1 通ずつ送る (キーはそれぞれ別)', async () => {
    setScenario({ clientCounts: { data: clientRowsOf(120), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({
      status: 'sent',
      total: 42,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'sent', total: 120, threshold: 100 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(claimKeys()).toEqual(['app_logs_error_spike', 'app_logs_client_error_spike']);
    expect(mocks.sendEmail.mock.calls.map(([envelope]) => envelope.subject)).toEqual([
      '【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)',
      '【ほめゴハン運用】ブラウザ・端末のエラーが急増しています (直近 15 分で 120 件)',
    ]);
  });

  it('K-6: OPS_ALERT_CLIENT_ERROR_THRESHOLD でクライアントのしきい値だけを変える (サーバーのしきい値は 20 のまま)', async () => {
    vi.stubEnv('OPS_ALERT_CLIENT_ERROR_THRESHOLD', '30');
    setScenario({ counts: { data: rowsOf(20), error: null }, clientCounts: { data: clientRowsOf(31), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 20,
      threshold: 20,
      window_minutes: 15,
      client: { status: 'sent', total: 31, threshold: 30 },
      email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(mocks.sendEmail.mock.calls[0][0].text as string).toContain('15 分で 30 件を超えると');
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('K-7: OPS_ALERT_CLIENT_ERROR_THRESHOLD が不正なら既定の 100 件に戻し、変数名だけを warn に残す (値は出さない)', async () => {
    vi.stubEnv('OPS_ALERT_CLIENT_ERROR_THRESHOLD', 'lots-of-errors');
    setScenario({ counts: { data: [], error: null }, clientCounts: { data: clientRowsOf(31), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ client: { status: 'below_threshold', total: 31, threshold: 100 } });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [, meta] = mocks.logWarn.mock.calls[0];
    expect(meta).toEqual({ ignored_env: ['OPS_ALERT_CLIENT_ERROR_THRESHOLD'] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('lots-of-errors');
  });

  it('K-8: クライアントの通知を送れなかったら、クライアントのキーで取った権利だけを返す (サーバーの抑止は触らない)', async () => {
    setScenario({ claim: { data: null, error: null }, clientCounts: { data: clientRowsOf(200), error: null } });
    mocks.sendEmail.mockResolvedValue(failedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'deduped', client: { status: 'send_failed', total: 200 } });
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'app_logs_client_error_spike', p_claimed_at: CLIENT_CLAIMED_AT }],
    ]);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [message, meta] = mocks.logWarn.mock.calls[0];
    expect(message).toBe('ブラウザ・端末のエラー急増を検知しましたが、通知メールを送れませんでした');
    expect(meta).toMatchObject({ scope: 'client', total: 200, error_code: 'validation_error' });
  });

  it('K-9: クライアントを数える RPC が失敗したら 500。サーバーの通知は、その前に送り終えている', async () => {
    setScenario({ clientCounts: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    // サーバーの急増 (42 件) の通知は届いている
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe('【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)');
    expect(claimKeys()).toEqual(['app_logs_error_spike']);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('K-10: サーバーの判定が 500 で止まったら、クライアントは数えない (応答は 1 つの 500)', async () => {
    setScenario({ counts: { data: null, error: { code: '42P01', message: 'relation missing' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(rpcCalls('app_log_client_error_counts')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// #1193 届けられなかったメール (email_outbox の dead) を 1 件から知らせる (3 つ目の種類 email_dead_letter)
// 設計: docs/design/operator/10-logs-and-mail-retry.md §8
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: 届けられなかったメール (email_dead_letter。#1193)', () => {
  /** サーバー・クライアントの error は 0 件 (急増の通知は送らない)。届けられなかったメールだけがある回 */
  const deadOnly = (overrides: Partial<Scenario> = {}) =>
    setScenario({ counts: { data: [], error: null }, deadCounts: { data: DEAD_ROWS, error: null }, ...overrides });
  const SERVER_QUIET = { status: 'below_threshold', total: 0, threshold: 20, window_minutes: 15, client: CLIENT_QUIET } as const;
  const suppressedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('suppressed', 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした', null, 0, false),
  } as const;
  const invalidEnvelopeResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('invalid_envelope', 'EMAIL_INVALID_ENVELOPE: subject: too long', null, 0, false),
  } as const;
  const outboxFailedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true),
  } as const;
  const outboxSentResult = { ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null } as const;
  const claimKeys = () => rpcCalls('claim_ops_alert').map(([, args]) => (args as { p_alert_key: string }).p_alert_key);
  const deadLetterCalls = () =>
    mocks.rpc.mock.calls
      .map(([fn, args]) => [fn, args] as const)
      .filter(
        ([fn, args]) =>
          String(fn).includes('email_outbox') ||
          ((fn === 'claim_ops_alert' || fn === 'release_ops_alert') && (args as { p_alert_key?: string })?.p_alert_key === 'email_dead_letter'),
      );

  it('T-1: まだ知らせていない dead が 1 件でもあれば知らせる。数える → 権利 (email_dead_letter) → 印を付ける → 印を付けた件数で送る', async () => {
    deadOnly();
    mocks.sendEmail.mockResolvedValue(outboxSentResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...SERVER_QUIET, email_dead_letter: { status: 'sent', total: 3, threshold: 0 }, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('email_outbox_dead_counts')).toEqual([['email_outbox_dead_counts', { p_limit: 10 }]]);
    expect(rpcCalls('claim_ops_alert')).toEqual([['claim_ops_alert', { p_alert_key: 'email_dead_letter', p_cooldown_minutes: 60 }]]);
    expect(rpcCalls('mark_email_outbox_dead_alerted')).toEqual([
      ['mark_email_outbox_dead_alerted', { p_alerted_at: DEAD_CLAIMED_AT, p_limit: 10 }],
    ]);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0];
    expect(envelope.template).toBe('ops_email_dead_letter');
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン運用】届けられなかったメールがあります (3 件)');
    expect(envelope.text).toContain(' 1. family_invite … 2 件');
    expect(envelope.text).toContain(' 2. support_ticket_reply … 1 件');
    expect((envelope.text as string).split('\n')).toContain(`${SITE_URL}/super-admin/email-outbox`);
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [message, meta] = mocks.logInfo.mock.calls[0];
    expect(message).toBe('届けられなかったメールを運用メールに知らせました');
    expect(meta).toMatchObject({ scope: 'email_dead_letter', total: 3, threshold: 0, outbox_id: 'outbox-id-1' });
    expect(meta).not.toHaveProperty('email_id');
  });

  it('T-1b: 文面の件数は数えた件数ではなく、印を付けた行の件数 (数えたあとに dead になった行も入る)', async () => {
    deadOnly({ deadMark: { data: [{ template: 'family_invite', dead_count: 5, total_count: 5 }], error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ email_dead_letter: { status: 'sent', total: 5, threshold: 0 } });
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe('【ほめゴハン運用】届けられなかったメールがあります (5 件)');
  });

  it('T-2: まだ知らせていない dead が 0 件なら below_threshold (claim_ops_alert をキー email_dead_letter で呼ばず、mark も呼ばない)', async () => {
    setScenario({ counts: { data: [], error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ ...SERVER_QUIET, email_dead_letter: DEAD_LETTER_QUIET, cron_failure: CRON_FAILURE_QUIET, pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(rpcCalls('email_outbox_dead_counts')).toHaveLength(1);
    expect(claimKeys()).not.toContain('email_dead_letter');
    expect(rpcCalls('mark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('T-3: server / client の通知を送ってから email_dead_letter を数える (呼び出しの順の末尾が 数える → 権利 → 印 → 送る)', async () => {
    setScenario({ deadCounts: { data: DEAD_ROWS, error: null } });
    const order: string[] = [];
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      order.push(fn === 'claim_ops_alert' ? `claim_ops_alert:${args?.p_alert_key}` : fn);
      return harness?.(fn, args);
    });
    mocks.sendEmail.mockImplementation(async (envelope: { template?: string }) => {
      order.push(`sendEmail:${envelope.template}`);
      return sentResult;
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(order).toEqual([
      'app_log_error_counts',
      'claim_ops_alert:app_logs_error_spike',
      'sendEmail:ops_app_log_error_spike',
      'app_log_client_error_counts',
      'email_outbox_dead_counts',
      'claim_ops_alert:email_dead_letter',
      'mark_email_outbox_dead_alerted',
      'sendEmail:ops_email_dead_letter',
      'cron_failure_counts',
      'pg_cron_last_run_at',
      'cron_secret_probe_results',
      'send_cron_secret_probe',
    ]);
  });

  it('T-3b: email_outbox_dead_counts の失敗は 500 で、server の通知はその前に済んでいる。印も権利も触らない', async () => {
    setScenario({ deadCounts: { data: null, error: { code: '42P01', message: 'relation "public.email_outbox" does not exist' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toBe('【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)');
    expect(claimKeys()).toEqual(['app_logs_error_spike']);
    expect(rpcCalls('mark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(0);
  });

  it('T-3c: 数えた応答の形が想定外・権利を取る RPC の失敗は 500 (印も権利も触らない)', async () => {
    deadOnly({ deadCounts: { data: { rows: [] }, error: null } });
    const malformed = await GET(authed());
    expect(malformed.status).toBe(500);

    vi.clearAllMocks();
    deadOnly({ deadClaim: { data: null, error: { code: '42501', message: 'permission denied' } } });
    const claimFailed = await GET(authed());
    expect(claimFailed.status).toBe(500);

    expect(rpcCalls('mark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['suppressed (宛先が停止リスト)', suppressedResult],
    ['invalid_envelope (文面の不備)', invalidEnvelopeResult],
  ])('T-4: sendEmail が %s なら、権利も印も返さない (release_ops_alert も unmark も呼ばない) で send_failed', async (_label, result) => {
    deadOnly();
    mocks.sendEmail.mockResolvedValue(result);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ email_dead_letter: { status: 'send_failed', total: 3, threshold: 0 } });
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(0);
    const [message, meta] = mocks.logWarn.mock.calls[0];
    expect(message).toBe('届けられなかったメールを検知しましたが、通知メールを送れませんでした');
    expect(meta).toMatchObject({ scope: 'email_dead_letter', total: 3, error_code: result.error.code });
  });

  it.each([
    ['outbox_failed (送信待ちへの登録の失敗)', outboxFailedResult, 'send_failed'],
    ['skipped (not_configured)', skippedResult, 'send_skipped'],
    ['Resend 由来のコード (validation_error。現行どおり返す)', failedResult, 'send_failed'],
  ])('T-5: sendEmail が %s なら、印を外して (unmark) から権利を返す (この順)', async (_label, result, status) => {
    deadOnly();
    mocks.sendEmail.mockResolvedValue(result);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ email_dead_letter: { status, total: 3, threshold: 0 } });
    expect(deadLetterCalls().map(([fn]) => fn)).toEqual([
      'email_outbox_dead_counts',
      'claim_ops_alert',
      'mark_email_outbox_dead_alerted',
      'unmark_email_outbox_dead_alerted',
      'release_ops_alert',
    ]);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toEqual([
      ['unmark_email_outbox_dead_alerted', { p_alerted_at: DEAD_CLAIMED_AT }],
    ]);
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'email_dead_letter', p_claimed_at: DEAD_CLAIMED_AT }],
    ]);
  });

  it('T-6: 抑止の間に dead になった行を取りこぼさない (R-13・S-18)。権利を取れた回だけ印を付け、取れない回は印を付けない', async () => {
    const SECOND_CLAIMED_AT = '2026-10-09T02:22:00.111111+00:00';
    const deadClaims = [DEAD_CLAIMED_AT, null, SECOND_CLAIMED_AT];
    let deadClaimIndex = 0;
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'claim_ops_alert' && args?.p_alert_key === 'email_dead_letter') {
        const data = deadClaims[deadClaimIndex];
        deadClaimIndex += 1;
        return { data, error: null };
      }
      return harness?.(fn, args);
    });

    // 1 回目: family_invite 1 件 → 権利を取り、印を付けて 1 通目
    deadOnly({
      deadCounts: { data: [{ template: 'family_invite', dead_count: 1, total_count: 1 }], error: null },
      deadMark: { data: [{ template: 'family_invite', dead_count: 1, total_count: 1 }], error: null },
    });
    const first = await (await GET(authed())).json();
    // 2 回目: 抑止の間に support_ticket_reply が 1 件 dead → 数えるが権利が取れない (deduped)。印は付けない
    deadOnly({
      deadCounts: { data: [{ template: 'support_ticket_reply', dead_count: 1, total_count: 1 }], error: null },
      deadMark: { data: [{ template: 'support_ticket_reply', dead_count: 1, total_count: 1 }], error: null },
    });
    const second = await (await GET(authed())).json();
    // 3 回目 (cron の発火が遅れた): 窓で区切らないので、2 回目に数えた行がまだ印なしで数えられ、2 通目になる
    const third = await (await GET(authed())).json();

    expect(first.email_dead_letter).toEqual({ status: 'sent', total: 1, threshold: 0 });
    expect(second.email_dead_letter).toEqual({ status: 'deduped', total: 1, threshold: 0 });
    expect(third.email_dead_letter).toEqual({ status: 'sent', total: 1, threshold: 0 });
    expect(rpcCalls('email_outbox_dead_counts')).toEqual([
      ['email_outbox_dead_counts', { p_limit: 10 }],
      ['email_outbox_dead_counts', { p_limit: 10 }],
      ['email_outbox_dead_counts', { p_limit: 10 }],
    ]);
    expect(rpcCalls('mark_email_outbox_dead_alerted')).toEqual([
      ['mark_email_outbox_dead_alerted', { p_alerted_at: DEAD_CLAIMED_AT, p_limit: 10 }],
      ['mark_email_outbox_dead_alerted', { p_alerted_at: SECOND_CLAIMED_AT, p_limit: 10 }],
    ]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail.mock.calls[0][0].text).toContain(' 1. family_invite … 1 件');
    expect(mocks.sendEmail.mock.calls[1][0].text).toContain(' 1. support_ticket_reply … 1 件');
    expect(mocks.sendEmail.mock.calls[1][0].text).not.toContain('family_invite');
  });

  it.each([
    ['{ error } を返す', { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }],
    ['配列でない応答を返す', { data: { template: 'family_invite' }, error: null }],
    ['件数が不正な行を返す', { data: [{ template: 'family_invite', dead_count: -1, total_count: 1 }], error: null }],
  ])('T-7: 印を付ける RPC が %s なら、unmark と release_ops_alert を呼んでから 500 (汎用メッセージ)。文面は送らない', async (_label, deadMark) => {
    deadOnly({ deadMark });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
    expect(deadLetterCalls().map(([fn]) => fn)).toEqual([
      'email_outbox_dead_counts',
      'claim_ops_alert',
      'mark_email_outbox_dead_alerted',
      'unmark_email_outbox_dead_alerted',
      'release_ops_alert',
    ]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('T-7b: 印を付ける RPC が例外を投げても、sendEmail が例外を投げても、印と権利を返してから 500', async () => {
    deadOnly();
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'mark_email_outbox_dead_alerted') throw new Error('network down');
      return harness?.(fn, args);
    });
    const thrownMark = await GET(authed());
    expect(thrownMark.status).toBe(500);
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(1);
    expect(rpcCalls('release_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => harness?.(fn, args));
    deadOnly();
    mocks.sendEmail.mockRejectedValue(new Error(`socket hang up while sending to ${OPS_EMAIL}`));
    const thrownSend = await GET(authed());
    expect(thrownSend.status).toBe(500);
    const body = await thrownSend.json();
    expect(JSON.stringify(body)).not.toContain('socket hang up');
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toEqual([
      ['unmark_email_outbox_dead_alerted', { p_alerted_at: DEAD_CLAIMED_AT }],
    ]);
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'email_dead_letter', p_claimed_at: DEAD_CLAIMED_AT }],
    ]);
  });

  it('T-8: 印を付けた行が 0 件 (数えたあとに再送・掃除で減った) なら、メールを送らず権利を返して below_threshold (total 0)。unmark は呼ばない', async () => {
    deadOnly({ deadMark: { data: [], error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ email_dead_letter: { status: 'below_threshold', total: 0, threshold: 0 } });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('unmark_email_outbox_dead_alerted')).toHaveLength(0);
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'email_dead_letter', p_claimed_at: DEAD_CLAIMED_AT }],
    ]);
  });

  it('T-9: 印を外す RPC が { error } を返しても例外を投げても、応答は send_failed のまま。warn (「印を外せませんでした」) を残す', async () => {
    deadOnly({ deadUnmark: { data: null, error: { code: '57014', message: 'timeout' } } });
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);
    const errored = await GET(authed());
    expect(errored.status).toBe(200);
    await expect(errored.json()).resolves.toMatchObject({ email_dead_letter: { status: 'send_failed' } });
    const erroredWarn = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('印を外せませんでした'));
    expect(erroredWarn?.[1]).toEqual({ scope: 'email_dead_letter', pg_code: '57014' });
    expect(rpcCalls('release_ops_alert')).toHaveLength(1); // 印を外せなくても権利は返す

    vi.clearAllMocks();
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'unmark_email_outbox_dead_alerted') throw new TypeError('network down');
      return harness?.(fn, args);
    });
    deadOnly();
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);
    const thrown = await GET(authed());
    expect(thrown.status).toBe(200);
    await expect(thrown.json()).resolves.toMatchObject({ email_dead_letter: { status: 'send_failed' } });
    const thrownWarn = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('印を外せませんでした'));
    expect(thrownWarn?.[1]).toEqual({ scope: 'email_dead_letter', error_name: 'TypeError' });
  });

  it('T-10: 急増の通知も、送信が suppressed / invalid_envelope なら権利を返さない (#1577 の 8)。outbox_failed は返す', async () => {
    mocks.sendEmail.mockResolvedValueOnce(suppressedResult);
    const suppressed = await (await GET(authed())).json();
    expect(suppressed.status).toBe('send_failed');
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);

    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValueOnce(invalidEnvelopeResult);
    await GET(authed());
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);

    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValueOnce(outboxFailedResult);
    await GET(authed());
    expect(rpcCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'app_logs_error_spike', p_claimed_at: CLAIMED_AT }],
    ]);
  });

  it('T-11: ログ・応答に宛先・件名・本文・ユーザー ID を出さない (件数と template だけ)', async () => {
    deadOnly();
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);

    const res = await GET(authed());
    const body = JSON.stringify(await res.json());
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);

    for (const text of [body, logged]) {
      expect(text).not.toContain(OPS_EMAIL);
    }
    expect(logged).toContain('family_invite');
  });
});

// ---------------------------------------------------------------
// 定期処理の失敗 (cron_failure) と pg_cron の停止 (pg_cron_stalled)。#1125 の B
// 設計: docs/design/operator/11-ops-batches-non-billing.md §4・§6.2・§7.1
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: 定期処理の失敗 (cron_failure。#1125 の B)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  /** まだ知らせていない (または印を付けた) 失敗の行 (cron_failure_counts / mark_cron_failures_alerted の形)。全体 3 件 */
  const FAILURE_ROWS = [
    { source: 'pg_cron', job_name: 'cleanup-old-app-logs', failed_count: 2, total_count: 3 },
    { source: 'vercel_cron', job_name: 'cron/email-outbox', failed_count: 1, total_count: 3 },
  ];
  /** サーバー・クライアントの error と dead は 0 件 (急増の通知は送らない)。定期処理の失敗だけがある回 */
  const failureOnly = (overrides: Partial<Scenario> = {}) =>
    setScenario({
      counts: { data: [], error: null },
      cronFailureCounts: { data: FAILURE_ROWS, error: null },
      cronFailureMark: { data: FAILURE_ROWS, error: null },
      ...overrides,
    });
  const outboxSentResult = { ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null } as const;
  const outboxFailedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true),
  } as const;
  const suppressedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('suppressed', 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした', null, 0, false),
  } as const;
  const invalidEnvelopeResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('invalid_envelope', 'EMAIL_INVALID_ENVELOPE: subject: too long', null, 0, false),
  } as const;
  const cronFailureKeyCalls = (fn: 'claim_ops_alert' | 'release_ops_alert') =>
    rpcCalls(fn).filter(([, args]) => (args as { p_alert_key?: string })?.p_alert_key === 'cron_failure');
  /** RPC と sendEmail の呼び出しの順 (RPC 名。claim / release はキーつき) を記録する */
  function recordOrder(): string[] {
    const order: string[] = [];
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      order.push(fn === 'claim_ops_alert' || fn === 'release_ops_alert' ? `${fn}:${args?.p_alert_key}` : fn);
      return harness?.(fn, args);
    });
    return order;
  }

  it('CF-1: 失敗が無ければ cron_failure_counts だけを呼び、below_threshold。権利を取らない', async () => {
    setScenario({ counts: { data: [], error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: CRON_FAILURE_QUIET });
    expect(rpcCalls('cron_failure_counts')).toEqual([['cron_failure_counts', { p_limit: 10 }]]);
    expect(cronFailureKeyCalls('claim_ops_alert')).toHaveLength(0);
    expect(rpcCalls('mark_cron_failures_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-2: 失敗が 1 件あれば権利 (キー cron_failure) を取り、mark で台帳に書き、書けた件数で ops_cron_failure を 1 通送る', async () => {
    failureOnly();
    mocks.sendEmail.mockResolvedValue(outboxSentResult);
    const order = recordOrder();
    mocks.sendEmail.mockImplementation(async () => {
      order.push('sendEmail');
      return outboxSentResult;
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 0,
      threshold: 20,
      window_minutes: 15,
      client: CLIENT_QUIET,
      email_dead_letter: DEAD_LETTER_QUIET,
      cron_failure: { status: 'sent', total: 3, threshold: 0 },
      pg_cron_stalled: PG_CRON_STALLED_QUIET, cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(rpcCalls('claim_ops_alert')).toContainEqual(['claim_ops_alert', { p_alert_key: 'cron_failure', p_cooldown_minutes: 60 }]);
    expect(rpcCalls('mark_cron_failures_alerted')).toEqual([
      ['mark_cron_failures_alerted', { p_alerted_at: CRON_FAILURE_CLAIMED_AT, p_limit: 10 }],
    ]);
    // 数える → 権利 → 台帳に書く → 送る の順 (権利を取る前に台帳へ書かず、台帳に書く前に送らない)
    const tail = order.slice(order.indexOf('cron_failure_counts'));
    expect(tail.slice(0, 4)).toEqual(['cron_failure_counts', 'claim_ops_alert:cron_failure', 'mark_cron_failures_alerted', 'sendEmail']);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0] as { template: string; to: string; subject: string; text: string };
    expect(envelope.template).toBe('ops_cron_failure');
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン運用】定期処理が失敗しています (3 件)');
    expect(envelope.text).toContain('pg_cron/cleanup-old-app-logs … 2 件');
    expect(envelope.text).toContain('vercel_cron/cron/email-outbox … 1 件');
    expect(envelope.text).toContain(`${SITE_URL}/super-admin/logs`);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(0);
  });

  it('CF-3: 抑止の間 (権利 NULL) は mark を呼ばず deduped', async () => {
    failureOnly({ cronFailureClaim: { data: null, error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: { status: 'deduped', total: 3, threshold: 0 } });
    expect(rpcCalls('mark_cron_failures_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-4: mark が 0 行なら権利を返して below_threshold', async () => {
    failureOnly({ cronFailureMark: { data: [], error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: { status: 'below_threshold', total: 0, threshold: 0 } });
    expect(cronFailureKeyCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'cron_failure', p_claimed_at: CRON_FAILURE_CLAIMED_AT }],
    ]);
    // 0 行しか書いていないので、印を外す操作は呼ばない
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-5: 送れなかった (outbox_failed) ときは unmark → release の順で返し、send_failed', async () => {
    failureOnly();
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);
    const order = recordOrder();

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: { status: 'send_failed', total: 3, threshold: 0 } });
    expect(rpcCalls('unmark_cron_failures_alerted')).toEqual([['unmark_cron_failures_alerted', { p_alerted_at: CRON_FAILURE_CLAIMED_AT }]]);
    expect(cronFailureKeyCalls('release_ops_alert')).toEqual([
      ['release_ops_alert', { p_alert_key: 'cron_failure', p_claimed_at: CRON_FAILURE_CLAIMED_AT }],
    ]);
    expect(order.indexOf('unmark_cron_failures_alerted')).toBeGreaterThan(order.indexOf('mark_cron_failures_alerted'));
    expect(order.indexOf('release_ops_alert:cron_failure')).toBeGreaterThan(order.indexOf('unmark_cron_failures_alerted'));
    // 件数と名前を warn に残す (メールが届かない間の手がかり)
    const warned = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('定期処理の失敗を検知しましたが、通知メールを送れませんでした'));
    expect(warned?.[1]).toMatchObject({ scope: 'cron_failure', total: 3, threshold: 0, error_code: 'outbox_failed' });

    // 送信設定が未完了 (skipped) でも同じく返す。応答は send_skipped
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(skippedResult);
    const skipped = await GET(authed());
    await expect(skipped.json()).resolves.toMatchObject({ cron_failure: { status: 'send_skipped', total: 3, threshold: 0 } });
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(1);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
  });

  it('CF-6: suppressed / invalid_envelope のときは unmark も release もしない', async () => {
    for (const result of [suppressedResult, invalidEnvelopeResult]) {
      vi.clearAllMocks();
      failureOnly();
      mocks.sendEmail.mockResolvedValue(result);

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json(), result.error.code).resolves.toMatchObject({ cron_failure: { status: 'send_failed', total: 3, threshold: 0 } });
      expect(rpcCalls('unmark_cron_failures_alerted'), result.error.code).toHaveLength(0);
      expect(cronFailureKeyCalls('release_ops_alert'), result.error.code).toHaveLength(0);
    }
  });

  it('CF-7: mark の RPC が error なら unmark → release のあと 500', async () => {
    failureOnly({ cronFailureMark: { data: null, error: { code: '42501', message: 'permission denied for table cron_failure_alerts' } } });
    const order = recordOrder();

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    // 印の RPC がエラーを返しても、DB では付いていることがあるので、外す操作は必ず呼ぶ
    expect(rpcCalls('unmark_cron_failures_alerted')).toEqual([['unmark_cron_failures_alerted', { p_alerted_at: CRON_FAILURE_CLAIMED_AT }]]);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
    expect(order.indexOf('release_ops_alert:cron_failure')).toBeGreaterThan(order.indexOf('unmark_cron_failures_alerted'));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-8: mark の応答の source が想定外 (形の誤り) なら unmark → release のあと 500 (黙って 0 件にしない。P-7)', async () => {
    failureOnly({ cronFailureMark: { data: [{ source: 'github_actions', job_name: 'x', failed_count: 1, total_count: 1 }], error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(1);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-9: メールと応答とログに、処理の名前と件数だけが出る (command・本文・ユーザー ID は出ない)', async () => {
    const rows = FAILURE_ROWS.map((row) => ({
      ...row,
      command: "SELECT net.http_post(url := 'https://example.test', headers := '{\"Authorization\": \"Bearer dummy-secret\"}')",
      return_message: 'ERROR: secret token dummy-secret leaked',
      message: 'user 123e4567-e89b-12d3-a456-426614174000 taro@example.com',
    }));
    failureOnly({ cronFailureCounts: { data: rows, error: null }, cronFailureMark: { data: rows, error: null } });
    mocks.sendEmail.mockResolvedValue(outboxSentResult);

    const res = await GET(authed());

    const body = JSON.stringify(await res.json());
    const logged = JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);
    const mailed = JSON.stringify(mocks.sendEmail.mock.calls);
    for (const text of [body, logged, mailed]) {
      expect(text).not.toContain('dummy-secret');
      expect(text).not.toContain('123e4567-e89b-12d3-a456-426614174000');
      expect(text).not.toContain('taro@example.com');
      expect(text).not.toContain('net.http_post');
    }
    expect(mailed).toContain('pg_cron/cleanup-old-app-logs');
    expect(logged).toContain('cleanup-old-app-logs');
    expect(body).not.toContain(OPS_EMAIL);
    expect(logged).not.toContain(OPS_EMAIL);
  });

  it('CF-10: claim_ops_alert が error なら 500。mark も unmark も release も呼ばない (P-21)', async () => {
    failureOnly({ cronFailureClaim: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(rpcCalls('mark_cron_failures_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-11: 送れなかったときに unmark が error を返しても、warn を 1 行残して release を呼び、応答は send_failed のまま (P-22)', async () => {
    failureOnly({ cronFailureUnmark: { data: null, error: { code: 'XX000', message: 'unmark failed' } } });
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: { status: 'send_failed' } });
    const warned = mocks.logWarn.mock.calls.filter(([message]) => String(message).includes('「知らせた」印を外せませんでした'));
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toEqual({ scope: 'cron_failure', pg_code: 'XX000' });
    // 印を外せなくても、権利は返す
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);

    // RPC が例外を投げた場合も同じ
    vi.clearAllMocks();
    failureOnly();
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      if (fn === 'unmark_cron_failures_alerted') throw new TypeError('network down');
      return harness?.(fn, args);
    });
    const thrown = await GET(authed());
    await expect(thrown.json()).resolves.toMatchObject({ cron_failure: { status: 'send_failed' } });
    const thrownWarn = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('「知らせた」印を外せませんでした'));
    expect(thrownWarn?.[1]).toEqual({ scope: 'cron_failure', error_name: 'TypeError' });
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
  });

  it('CF-12: cron_failure_counts が error、または応答の形が誤り (failed_count が整数でない・source が想定外) なら 500。claim_ops_alert (キー cron_failure) も mark も sendEmail (ops_cron_failure) も呼ばない (P-8)', async () => {
    const bad: ReadonlyArray<RpcResult> = [
      { data: null, error: { code: '42P01', message: 'relation "public.cron_failure_alerts" does not exist' } },
      { data: [{ source: 'pg_cron', job_name: 'a', failed_count: 'many', total_count: 1 }], error: null },
      { data: [{ source: 'github_actions', job_name: 'a', failed_count: 1, total_count: 1 }], error: null },
      { data: [{ source: 'pg_cron', job_name: 7, failed_count: 1, total_count: 1 }], error: null },
      { data: { rows: [] }, error: null },
    ];
    for (const cronFailureCounts of bad) {
      vi.clearAllMocks();
      setScenario({ counts: { data: [], error: null }, cronFailureCounts });

      const res = await GET(authed());

      expect(res.status, JSON.stringify(cronFailureCounts)).toBe(500);
      await expect(res.json()).resolves.toEqual(GENERIC);
      expect(cronFailureKeyCalls('claim_ops_alert')).toHaveLength(0);
      expect(rpcCalls('mark_cron_failures_alerted')).toHaveLength(0);
      expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
      expect(rpcCalls('release_ops_alert')).toHaveLength(0);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(mocks.logError).toHaveBeenCalledTimes(1);
    }
  });

  it('CF-13: 権利と印を取ったあとで文面の作成または sendEmail が例外を投げたら、unmark → release の順で返してから 500 (P-28)', async () => {
    // sendEmail が例外
    failureOnly();
    mocks.sendEmail.mockRejectedValue(new Error('unexpected'));
    let order = recordOrder();

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(1);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
    expect(order.indexOf('release_ops_alert:cron_failure')).toBeGreaterThan(order.indexOf('unmark_cron_failures_alerted'));

    // 文面の作成が例外 (mark で台帳に書いたあと)
    vi.clearAllMocks();
    failureOnly();
    mocks.sendEmail.mockResolvedValue(outboxSentResult);
    mocks.renderCronFailureThrows = true;
    order = recordOrder();

    const rendered = await GET(authed());

    expect(rendered.status).toBe(500);
    expect(order.filter((name) => name === 'mark_cron_failures_alerted')).toHaveLength(1);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(1);
    expect(cronFailureKeyCalls('release_ops_alert')).toHaveLength(1);
    expect(order.indexOf('release_ops_alert:cron_failure')).toBeGreaterThan(order.indexOf('unmark_cron_failures_alerted'));
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CF-14: cron_failure_counts に渡す引数は { p_limit: 10 } だけ (窓・時刻を渡さない。回の隙間の失敗も次の回で数える: S-04・R-03)', async () => {
    await GET(authed());
    await GET(authed());

    const calls = rpcCalls('cron_failure_counts');
    expect(calls).toHaveLength(2);
    for (const [, args] of calls) {
      expect(args).toStrictEqual({ p_limit: 10 });
    }
  });

  it('CF-15: 送れなかった (outbox_failed) ときに release_ops_alert が error を返しても、warn を 1 行残し、応答は send_failed のまま (P-26)', async () => {
    failureOnly({ release: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ cron_failure: { status: 'send_failed' } });
    const warned = mocks.logWarn.mock.calls.filter(([message]) => String(message).includes('送る権利を返せませんでした'));
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toEqual({ scope: 'cron_failure', pg_code: '57014' });
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(1);
  });

  it('CF-16: OPS_ALERT_EMAIL が未設定・形が不正の回は、失敗が有る場面 (cronFailureCounts に 1 件・pgCronLastRun が 61 分前) でも cron_failure_counts も pg_cron_last_run_at も呼ばず disabled / invalid_config (DB に触れない。S-05・P-15)', async () => {
    const stalled = { data: [{ cron_available: true, active_jobs: 17, last_run_at: new Date(Date.now() - 61 * 60_000).toISOString() }], error: null };
    for (const [value, status] of [
      [undefined, 'disabled'],
      ['', 'disabled'],
      ['not-an-address', 'invalid_config'],
    ] as const) {
      vi.clearAllMocks();
      vi.stubEnv('OPS_ALERT_EMAIL', value);
      failureOnly({ pgCronLastRun: stalled });

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json(), String(value)).resolves.toEqual({ status });
      expectNothingTouched();
      expect(rpcCalls('cron_failure_counts')).toHaveLength(0);
      expect(rpcCalls('pg_cron_last_run_at')).toHaveLength(0);
    }
  });
});

describe('GET /api/cron/app-log-alerts: pg_cron の停止 (pg_cron_stalled。#1125 の B)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const lastRun = (minutes: number | null, activeJobs = 17): RpcResult => ({
    data: [{ cron_available: true, active_jobs: activeJobs, last_run_at: minutes === null ? null : minutesAgo(minutes) }],
    error: null,
  });
  /** サーバー・クライアントの error と dead と失敗は 0 件。pg_cron の停止だけを見る回 */
  const stalledOnly = (overrides: Partial<Scenario> = {}) => setScenario({ counts: { data: [], error: null }, pgCronLastRun: lastRun(61), ...overrides });
  const outboxFailedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true),
  } as const;
  const suppressedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('suppressed', 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした', null, 0, false),
  } as const;
  const invalidEnvelopeResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('invalid_envelope', 'EMAIL_INVALID_ENVELOPE: subject: too long', null, 0, false),
  } as const;
  const stalledKeyCalls = (fn: 'claim_ops_alert' | 'release_ops_alert') =>
    rpcCalls(fn).filter(([, args]) => (args as { p_alert_key?: string })?.p_alert_key === 'pg_cron_stalled');

  it('ST-1: pg_cron_last_run_at が 61 分前なら権利 (キー pg_cron_stalled) を取り ops_pg_cron_stalled を送る。応答の total は分数', async () => {
    stalledOnly();

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'sent', total: 61, threshold: 60 } });
    expect(rpcCalls('pg_cron_last_run_at')).toEqual([['pg_cron_last_run_at']]);
    expect(stalledKeyCalls('claim_ops_alert')).toEqual([['claim_ops_alert', { p_alert_key: 'pg_cron_stalled', p_cooldown_minutes: 60 }]]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0] as { template: string; to: string; subject: string; text: string };
    expect(envelope.template).toBe('ops_pg_cron_stalled');
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン運用】pg_cron のジョブが 60 分以上動いていません');
    expect(envelope.text).toContain('有効なジョブが 17 本あるのに、最新の実行から 61 分');
    // 台帳は使わない
    expect(rpcCalls('mark_cron_failures_alerted')).toHaveLength(0);
    expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    expect(stalledKeyCalls('release_ops_alert')).toHaveLength(0);
  });

  it('ST-2: 60 分ちょうどは送らない', async () => {
    stalledOnly({ pgCronLastRun: lastRun(60) });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'below_threshold', total: 60, threshold: 60 } });
    expect(stalledKeyCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('ST-3: cron_available = false / active_jobs = 0 は below_threshold で権利を取らない', async () => {
    const cases: ReadonlyArray<RpcResult> = [
      { data: [{ cron_available: false, active_jobs: 0, last_run_at: null }], error: null },
      { data: [{ cron_available: false, active_jobs: 17, last_run_at: minutesAgo(600) }], error: null },
      { data: [{ cron_available: true, active_jobs: 0, last_run_at: minutesAgo(600) }], error: null },
    ];
    for (const pgCronLastRun of cases) {
      vi.clearAllMocks();
      stalledOnly({ pgCronLastRun });

      const res = await GET(authed());

      await expect(res.json(), JSON.stringify(pgCronLastRun)).resolves.toMatchObject({
        pg_cron_stalled: { status: 'below_threshold', total: 0, threshold: 60 },
      });
      expect(stalledKeyCalls('claim_ops_alert')).toHaveLength(0);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    }
  });

  it('ST-4: 履歴が無い (last_run_at null) のに有効なジョブがあれば送る', async () => {
    stalledOnly({ pgCronLastRun: lastRun(null, 5) });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'sent', total: 0, threshold: 60 } });
    const envelope = mocks.sendEmail.mock.calls[0][0] as { text: string };
    expect(envelope.text).toContain('最新の実行: 記録なし');
    expect(envelope.text).toContain('有効なジョブが 5 本あるのに');
  });

  it('ST-5: 送れなかったとき、outbox_failed / not_configured は権利を返し、suppressed / invalid_envelope は返さない (P-13)', async () => {
    for (const [result, released] of [
      [outboxFailedResult, true],
      [skippedResult, true],
      [suppressedResult, false],
      [invalidEnvelopeResult, false],
    ] as const) {
      vi.clearAllMocks();
      stalledOnly();
      mocks.sendEmail.mockResolvedValue(result);

      const res = await GET(authed());

      expect(res.status).toBe(200);
      await expect(res.json(), result.error.code).resolves.toMatchObject({
        pg_cron_stalled: { status: result.skipped ? 'send_skipped' : 'send_failed', total: 61, threshold: 60 },
      });
      expect(stalledKeyCalls('release_ops_alert'), result.error.code).toHaveLength(released ? 1 : 0);
      if (released) {
        expect(stalledKeyCalls('release_ops_alert')[0]).toEqual([
          'release_ops_alert',
          { p_alert_key: 'pg_cron_stalled', p_claimed_at: PG_CRON_STALLED_CLAIMED_AT },
        ]);
      }
      // 停止の通知は台帳を使わないので、印を外す操作は呼ばない
      expect(rpcCalls('unmark_cron_failures_alerted')).toHaveLength(0);
    }
  });

  it('ST-6: OPS_ALERT_PG_CRON_STALL_MINUTES でしきい値を変える。不正な値は既定に戻して warn', async () => {
    vi.stubEnv('OPS_ALERT_PG_CRON_STALL_MINUTES', '120');
    stalledOnly({ pgCronLastRun: lastRun(100) });
    const under = await GET(authed());
    await expect(under.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'below_threshold', total: 100, threshold: 120 } });
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    stalledOnly({ pgCronLastRun: lastRun(130) });
    const over = await GET(authed());
    await expect(over.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'sent', total: 130, threshold: 120 } });
    const envelope = mocks.sendEmail.mock.calls[0][0] as { subject: string };
    expect(envelope.subject).toContain('120 分以上');

    // 不正な値 (範囲外・整数でない) は既定の 60 分に戻し、変数名だけを warn に残す (値は出さない)
    for (const bad of ['5', '1441', 'abc', '1.5']) {
      vi.clearAllMocks();
      vi.stubEnv('OPS_ALERT_PG_CRON_STALL_MINUTES', bad);
      stalledOnly({ pgCronLastRun: lastRun(61) });

      const res = await GET(authed());

      await expect(res.json(), bad).resolves.toMatchObject({ pg_cron_stalled: { status: 'sent', total: 61, threshold: 60 } });
      const warned = mocks.logWarn.mock.calls.find(([message]) => String(message).includes('環境変数の値が正しくないため'));
      expect(warned?.[1], bad).toEqual({ ignored_env: ['OPS_ALERT_PG_CRON_STALL_MINUTES'] });
      expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain(`"${bad}"`);
    }
  });

  it('ST-7: 停止の回で claim_ops_alert が error なら 500 で、release を呼ばない (P-23)', async () => {
    stalledOnly({ pgCronStalledClaim: { data: null, error: { code: '42501', message: 'permission denied' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('ST-8: 停止の回で sendEmail が例外なら release を呼んでから 500 (P-24)', async () => {
    stalledOnly();
    mocks.sendEmail.mockRejectedValue(new Error('unexpected'));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(stalledKeyCalls('release_ops_alert')).toHaveLength(1);

    // 文面の作成が例外でも同じ
    vi.clearAllMocks();
    stalledOnly();
    mocks.renderPgCronStalledThrows = true;
    const rendered = await GET(authed());
    expect(rendered.status).toBe(500);
    expect(stalledKeyCalls('release_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('ST-9: pg_cron_last_run_at が error、または応答の形が誤り (cron_available が真偽値でない) なら 500。claim_ops_alert (キー pg_cron_stalled) も sendEmail (ops_pg_cron_stalled) も呼ばない (P-14)', async () => {
    const bad: ReadonlyArray<RpcResult> = [
      { data: null, error: { code: '42501', message: 'permission denied for schema cron' } },
      { data: [{ cron_available: 'yes', active_jobs: 17, last_run_at: minutesAgo(61) }], error: null },
      { data: [{ cron_available: true, active_jobs: -1, last_run_at: minutesAgo(61) }], error: null },
      { data: [{ cron_available: true, active_jobs: 17, last_run_at: 12345 }], error: null },
      { data: [], error: null },
      { data: [{ cron_available: true, active_jobs: 17, last_run_at: 'not-a-date' }], error: null },
    ];
    for (const pgCronLastRun of bad) {
      vi.clearAllMocks();
      stalledOnly({ pgCronLastRun });

      const res = await GET(authed());

      expect(res.status, JSON.stringify(pgCronLastRun)).toBe(500);
      await expect(res.json()).resolves.toEqual(GENERIC);
      expect(stalledKeyCalls('claim_ops_alert')).toHaveLength(0);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    }
  });

  it('ST-10: 61 分前で止まっていても、権利が NULL (抑止の間) なら deduped。sendEmail も release も呼ばない。権利はクールダウン (既定 60 分) で取る (止まっている間は 60 分ごとに 1 通: S-07・P-11)', async () => {
    stalledOnly({ pgCronStalledClaim: { data: null, error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ pg_cron_stalled: { status: 'deduped', total: 61, threshold: 60 } });
    expect(stalledKeyCalls('claim_ops_alert')).toEqual([['claim_ops_alert', { p_alert_key: 'pg_cron_stalled', p_cooldown_minutes: 60 }]]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });
});

describe('GET /api/cron/app-log-alerts: 5 種類の判定の順 (#1125 の B)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  const FAILURE_ROWS = [{ source: 'pg_cron', job_name: 'cleanup-old-app-logs', failed_count: 1, total_count: 1 }];
  const stalledRun = {
    data: [{ cron_available: true, active_jobs: 17, last_run_at: new Date(Date.now() - 90 * 60_000).toISOString() }],
    error: null,
  } as const;
  /** 5 種類ともに通知が要る場面 */
  const everything = (overrides: Partial<Scenario> = {}) =>
    setScenario({
      clientCounts: { data: rowsOf(101), error: null },
      deadCounts: { data: DEAD_ROWS, error: null },
      cronFailureCounts: { data: FAILURE_ROWS, error: null },
      cronFailureMark: { data: FAILURE_ROWS, error: null },
      pgCronLastRun: stalledRun,
      ...overrides,
    });

  it('ORD-1: server → client → email_dead_letter → cron_failure → pg_cron_stalled の順で、後ろの 500 は前の通知を止めない', async () => {
    everything();
    const order: string[] = [];
    mocks.sendEmail.mockImplementation(async (envelope: { template?: string }) => {
      order.push(`sendEmail:${envelope.template}`);
      return sentResult;
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: 'sent',
      client: { status: 'sent' },
      email_dead_letter: { status: 'sent' },
      cron_failure: { status: 'sent', total: 1, threshold: 0 },
      pg_cron_stalled: { status: 'sent', total: 90, threshold: 60 },
    });
    expect(order).toEqual([
      'sendEmail:ops_app_log_error_spike',
      'sendEmail:ops_app_log_error_spike',
      'sendEmail:ops_email_dead_letter',
      'sendEmail:ops_cron_failure',
      'sendEmail:ops_pg_cron_stalled',
    ]);
    expect(rpcCalls('claim_ops_alert').map(([, args]) => (args as { p_alert_key: string }).p_alert_key)).toEqual([
      'app_logs_error_spike',
      'app_logs_client_error_spike',
      'email_dead_letter',
      'cron_failure',
      'pg_cron_stalled',
    ]);

    // 最後の pg_cron_stalled が 500 でも、前の 4 つの通知は送り終えている
    vi.clearAllMocks();
    everything({ pgCronLastRun: { data: null, error: { code: '42501', message: 'permission denied for schema cron' } } });
    const failed = await GET(authed());
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual(GENERIC);
    expect(mocks.sendEmail.mock.calls.map(([envelope]) => (envelope as { template: string }).template)).toEqual([
      'ops_app_log_error_spike',
      'ops_app_log_error_spike',
      'ops_email_dead_letter',
      'ops_cron_failure',
    ]);
  });

  it('ORD-2: server の急増を送ったあと cron_failure_counts が error なら 500。server の sendEmail は 1 回呼ばれたまま (取り消さない)、client と email_dead_letter の数える RPC は呼ばれ、pg_cron_last_run_at と claim_ops_alert (キー cron_failure / pg_cron_stalled) は呼ばない (S-19・P-8)', async () => {
    setScenario({ cronFailureCounts: { data: null, error: { code: '57P01', message: 'terminating connection due to administrator command' } } });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect((mocks.sendEmail.mock.calls[0][0] as { template: string }).template).toBe('ops_app_log_error_spike');
    expect(rpcCalls('app_log_client_error_counts')).toHaveLength(1);
    expect(rpcCalls('email_outbox_dead_counts')).toHaveLength(1);
    expect(rpcCalls('pg_cron_last_run_at')).toHaveLength(0);
    const keys = rpcCalls('claim_ops_alert').map(([, args]) => (args as { p_alert_key: string }).p_alert_key);
    expect(keys).toEqual(['app_logs_error_spike']);
    // server の通知は済んでいるので、権利は返さない
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------
// #1560 cron の共有シークレットのずれ (cron_secret_drift) と入れ替えの途中 (cron_secret_rotation)
// 設計: docs/design/operator/12-cron-secret-drift-monitor.md §7.3・§8.1.2。CS- = ずれ / CR- = 入れ替え / CO- = 順と機械検査
// ---------------------------------------------------------------
describe('GET /api/cron/app-log-alerts: cron の共有シークレットのずれ・入れ替えの途中 (cron_secret_drift / cron_secret_rotation。#1560)', () => {
  const GENERIC = { error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const claimKeys = () => rpcCalls('claim_ops_alert').map(([, args]) => (args as { p_alert_key: string }).p_alert_key);
  const secretClaims = () => rpcCalls('claim_ops_alert').filter(([, args]) => /^cron_secret_/.test((args as { p_alert_key: string }).p_alert_key));
  const secretReleases = () => rpcCalls('release_ops_alert').filter(([, args]) => /^cron_secret_/.test((args as { p_alert_key: string }).p_alert_key));
  const CRON_SECRET_DRIFT_SUBJECT = (count: number) => `【ほめゴハン運用】cron の共有シークレットの確認が失敗しました (${count} 件)`;
  const CRON_SECRET_ROTATION_SUBJECT = (count: number) => `【ほめゴハン運用】cron の共有シークレットの入れ替えが途中です (${count} 件)`;

  /** ほかの 5 種類を静かにして、共有シークレットの判定だけを見る */
  const secretOnly = (overrides: Partial<Scenario> = {}) => setScenario({ counts: { data: [], error: null }, ...overrides });

  /** 前の回の確認の結果の 1 行。既定は 200 current (所見なし)。項目を変えて作る */
  const probeRow = (overrides: Record<string, unknown> = {}) => ({ ...probeRowOk()[0], ...overrides });
  /** 応答の無い行 (送れなかった確認・応答を待っている確認) */
  const unansweredRow = (overrides: Record<string, unknown> = {}) =>
    probeRow({
      answered: false,
      http_status: null,
      timed_out: null,
      has_error: null,
      matched: null,
      previous_configured: null,
      alias_used: null,
      body_error: null,
      body_code: null,
      ...overrides,
    });
  /** 401 Unauthorized (Edge と Vault の食い違い) */
  const mismatchRow = (overrides: Record<string, unknown> = {}) =>
    probeRow({ http_status: 401, matched: null, previous_configured: null, alias_used: null, body_error: 'Unauthorized', ...overrides });
  const resultsOf = (...rows: unknown[]): RpcResult => ({ data: rows, error: null });

  const sentTemplates = () => mocks.sendEmail.mock.calls.map(([envelope]) => (envelope as { template: string }).template);
  const sentSubjects = () => mocks.sendEmail.mock.calls.map(([envelope]) => (envelope as { subject: string }).subject);
  const sentTexts = () => mocks.sendEmail.mock.calls.map(([envelope]) => (envelope as { text: string }).text);
  const sendProbeCalls = () => rpcCalls('send_cron_secret_probe');

  const outboxFailedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true),
  } as const;
  const suppressedResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('suppressed', 'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした', null, 0, false),
  } as const;
  const invalidEnvelopeResult = {
    ok: false,
    id: null,
    attempts: 0,
    skipped: false,
    error: new EmailSendError('invalid_envelope', 'EMAIL_INVALID_ENVELOPE: subject: too long', null, 0, false),
  } as const;

  // ---- ずれ (fail。キー cron_secret_drift) ----

  it('CS-1: 確認の結果が 0 行なら両方 below_threshold。権利を取らず、send_cron_secret_probe を 1 回呼ぶ (最初の回)', async () => {
    secretOnly({ cronSecretResults: { data: [], error: null } });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 0,
      threshold: 20,
      window_minutes: 15,
      client: CLIENT_QUIET,
      email_dead_letter: DEAD_LETTER_QUIET,
      cron_failure: CRON_FAILURE_QUIET,
      pg_cron_stalled: PG_CRON_STALLED_QUIET,
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(secretClaims()).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('cron_secret_probe_results')).toEqual([['cron_secret_probe_results', { p_lookback_minutes: 60, p_limit: 8 }]]);
    expect(sendProbeCalls()).toHaveLength(1);
  });

  it('CS-2: 最新の決まった確認が 401 Unauthorized なら権利 (キー cron_secret_drift・既定の抑止 60 分) を取り、ops_cron_secret_drift (kind drift) を 1 通送る。応答 cron_secret_drift は sent・total 1。そのあと確認を送る', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    const order: string[] = [];
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      order.push(fn === 'claim_ops_alert' ? `claim_ops_alert:${args?.p_alert_key}` : fn);
      return harness?.(fn, args);
    });
    mocks.sendEmail.mockImplementation(async (envelope: { template?: string }) => {
      order.push(`sendEmail:${envelope.template}`);
      return sentResult;
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'below_threshold',
      total: 0,
      threshold: 20,
      window_minutes: 15,
      client: CLIENT_QUIET,
      email_dead_letter: DEAD_LETTER_QUIET,
      cron_failure: CRON_FAILURE_QUIET,
      pg_cron_stalled: PG_CRON_STALLED_QUIET,
      cron_secret_drift: { status: 'sent', total: 1, threshold: 0 },
      cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(secretClaims()).toEqual([['claim_ops_alert', { p_alert_key: 'cron_secret_drift', p_cooldown_minutes: 60 }]]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0] as { template: string; to: string; subject: string; text: string };
    expect(envelope.template).toBe('ops_cron_secret_drift');
    expect(envelope.to).toBe(OPS_EMAIL);
    expect(envelope.subject).toBe(CRON_SECRET_DRIFT_SUBJECT(1));
    expect(envelope.text).toContain(CRON_SECRET_FINDING_CATALOG['edge-vault-mismatch'].title);
    expect(envelope.text).toContain(CRON_SECRET_FINDING_CATALOG['edge-vault-mismatch'].action);
    expect(envelope.text).toContain(`${SITE_URL}/super-admin/logs`);
    // 読む → 権利 → 送る → 次の回のための確認を送る の順
    expect(order.slice(order.indexOf('cron_secret_probe_results'))).toEqual([
      'cron_secret_probe_results',
      'claim_ops_alert:cron_secret_drift',
      'sendEmail:ops_cron_secret_drift',
      'send_cron_secret_probe',
    ]);
    expect(secretReleases()).toHaveLength(0);
  });

  it('CS-3: 抑止の間 (権利 NULL) は deduped。sendEmail を呼ばず、確認は送る', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()), cronSecretDriftClaim: { data: null, error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'deduped', total: 1, threshold: 0 },
      cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(secretReleases()).toHaveLength(0);
    expect(sendProbeCalls()).toHaveLength(1);
  });

  /** fail の所見 13 種類のうち CS-2 の edge-vault-mismatch を除く 12 種類を起こす入力 (16 通り) */
  const FAIL_CASES: ReadonlyArray<[string, () => unknown, CronSecretFindingId]> = [
    ['send_state vault_missing', () => unansweredRow({ send_state: 'vault_missing' }), 'vault-missing'],
    ['send_state vault_empty', () => unansweredRow({ send_state: 'vault_empty' }), 'vault-empty'],
    ['send_state vault_unreadable', () => unansweredRow({ send_state: 'vault_unreadable' }), 'vault-unreadable'],
    ['send_state vault_unavailable', () => unansweredRow({ send_state: 'vault_unavailable' }), 'vault-unavailable'],
    ['send_state net_unavailable', () => unansweredRow({ send_state: 'net_unavailable' }), 'pg-net-unavailable'],
    ['未応答で猶予超え', () => unansweredRow({ requested_at: minutesAgo(15) }), 'probe-unanswered'],
    ['timed_out', () => probeRow({ http_status: null, timed_out: true, matched: null, previous_configured: null, alias_used: null }), 'probe-timeout'],
    ['has_error true', () => probeRow({ http_status: null, has_error: true, matched: null, previous_configured: null, alias_used: null }), 'probe-error'],
    ['http_status NULL', () => probeRow({ http_status: null, matched: null, previous_configured: null, alias_used: null }), 'probe-error'],
    ['200 で matched が想定外', () => probeRow({ matched: 'something-else' }), 'probe-unexpected-response'],
    ['401 でほかの本文', () => mismatchRow({ body_error: 'Something else' }), 'probe-unexpected-response'],
    ['503 でほかの本文', () => probeRow({ http_status: 503, matched: null, previous_configured: null, alias_used: null, body_error: 'SERVER_CONFIG_MISSING' }), 'probe-unexpected-response'],
    ['405', () => probeRow({ http_status: 405, matched: null, previous_configured: null, alias_used: null, body_error: 'Method not allowed' }), 'probe-unexpected-response'],
    ['401 に code (ゲートウェイの JWT 検証)', () => mismatchRow({ body_error: null, body_code: 'UNAUTHORIZED_INVALID_JWT_FORMAT' }), 'gateway-jwt'],
    ['503 Service not configured', () => probeRow({ http_status: 503, matched: null, previous_configured: null, alias_used: null, body_error: 'Service not configured' }), 'edge-not-configured'],
    ['404', () => probeRow({ http_status: 404, matched: null, previous_configured: null, alias_used: null, body_code: 'NOT_FOUND' }), 'probe-not-deployed'],
  ];

  it.each(FAIL_CASES)('CS-4: fail の所見が drift の通知 (キー cron_secret_drift・total 1・文面にその所見の題) になる: %s', async (_name, build, findingId) => {
    secretOnly({ cronSecretResults: resultsOf(build()) });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'sent', total: 1, threshold: 0 },
      cron_secret_rotation: CRON_SECRET_QUIET,
    });
    expect(secretClaims()).toEqual([['claim_ops_alert', { p_alert_key: 'cron_secret_drift', p_cooldown_minutes: 60 }]]);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(sentTemplates()).toEqual(['ops_cron_secret_drift']);
    expect(sentSubjects()).toEqual([CRON_SECRET_DRIFT_SUBJECT(1)]);
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG[findingId].title);
    expect(sendProbeCalls()).toHaveLength(1);
  });

  it('CS-5: 送れなかった (outbox_failed) ときは release (キー cron_secret_drift) → send_failed。suppressed / invalid_envelope は返さない', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    mocks.sendEmail.mockResolvedValue(outboxFailedResult);

    const failed = await GET(authed());

    await expect(failed.json()).resolves.toMatchObject({ cron_secret_drift: { status: 'send_failed', total: 1, threshold: 0 } });
    expect(secretReleases()).toEqual([['release_ops_alert', { p_alert_key: 'cron_secret_drift', p_claimed_at: CRON_SECRET_DRIFT_CLAIMED_AT }]]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'cron の共有シークレットのずれを検知しましたが、通知メールを送れませんでした',
      expect.objectContaining({ scope: 'cron_secret_drift', total: 1, threshold: 0, error_code: 'outbox_failed' }),
    );
    // 権利を返しても、次の回の確認は送る
    expect(sendProbeCalls()).toHaveLength(1);

    for (const result of [suppressedResult, invalidEnvelopeResult]) {
      vi.clearAllMocks();
      secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
      mocks.sendEmail.mockResolvedValue(result);

      const res = await GET(authed());

      await expect(res.json()).resolves.toMatchObject({ cron_secret_drift: { status: 'send_failed', total: 1, threshold: 0 } });
      expect(secretReleases(), result.error.code).toHaveLength(0);
    }

    // 送信設定が未完了 (not_configured) は skipped で返す・権利は返す
    vi.clearAllMocks();
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    mocks.sendEmail.mockResolvedValue(skippedResult);
    const skipped = await GET(authed());
    await expect(skipped.json()).resolves.toMatchObject({ cron_secret_drift: { status: 'send_skipped', total: 1, threshold: 0 } });
    expect(secretReleases()).toHaveLength(1);
  });

  it('CS-6: 文面の作成・sendEmail が例外なら release してから 500。確認は送らない', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    mocks.renderCronSecretDriftThrows = true;

    const renderFailed = await GET(authed());

    expect(renderFailed.status).toBe(500);
    await expect(renderFailed.json()).resolves.toEqual(GENERIC);
    expect(secretReleases()).toEqual([['release_ops_alert', { p_alert_key: 'cron_secret_drift', p_claimed_at: CRON_SECRET_DRIFT_CLAIMED_AT }]]);
    expect(sendProbeCalls()).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.renderCronSecretDriftThrows = false;
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    mocks.sendEmail.mockRejectedValue(new Error('send exploded'));

    const sendFailed = await GET(authed());

    expect(sendFailed.status).toBe(500);
    await expect(sendFailed.json()).resolves.toEqual(GENERIC);
    expect(secretReleases()).toHaveLength(1);
    expect(sendProbeCalls()).toHaveLength(0);
  });

  it('CS-7: claim_ops_alert が error なら 500。rotation の判定にも確認の送信にも進まない', async () => {
    secretOnly({
      cronSecretResults: resultsOf(mismatchRow()),
      cronSecretDriftClaim: { data: null, error: { code: '57P01', message: 'terminating connection due to administrator command' } },
    });
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    // rotation のキーでは権利を取っていない (warn の所見があっても、drift の失敗で止まる)
    expect(claimKeys()).toEqual(['cron_secret_drift']);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(sendProbeCalls()).toHaveLength(0);
    expect(secretReleases()).toHaveLength(0);
  });

  it('CS-8: cron_secret_probe_results が error・応答の形が誤り (send_state が想定外) なら 500。claim も send_cron_secret_probe も呼ばない', async () => {
    const bad: ReadonlyArray<RpcResult> = [
      { data: null, error: { code: '42883', message: 'function public.cron_secret_probe_results does not exist' } },
      { data: resultsOf(probeRow({ send_state: 'unexpected_state' })).data, error: null },
      { data: { not: 'an array' }, error: null },
      { data: resultsOf(probeRow({ requested_at: 'not-a-date' })).data, error: null },
    ];
    for (const cronSecretResults of bad) {
      vi.clearAllMocks();
      secretOnly({ cronSecretResults });

      const res = await GET(authed());

      expect(res.status, JSON.stringify(cronSecretResults)).toBe(500);
      await expect(res.json()).resolves.toEqual(GENERIC);
      expect(secretClaims()).toHaveLength(0);
      expect(sendProbeCalls()).toHaveLength(0);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    }
  });

  it('CS-9: send_cron_secret_probe が error・応答の形が誤り (sent なのに request_id 無し) なら 500。通知はその前に送信待ちに入っている (取り消さない)', async () => {
    const bad: ReadonlyArray<RpcResult> = [
      { data: null, error: { code: '42501', message: 'permission denied for function send_cron_secret_probe' } },
      { data: [{ probe_id: 42, send_state: 'sent', request_id: null }], error: null },
      { data: [], error: null },
      { data: [{ probe_id: 42, send_state: 'unexpected_state', request_id: null }], error: null },
    ];
    for (const cronSecretSend of bad) {
      vi.clearAllMocks();
      secretOnly({ cronSecretResults: resultsOf(mismatchRow()), cronSecretSend });

      const res = await GET(authed());

      expect(res.status, JSON.stringify(cronSecretSend)).toBe(500);
      await expect(res.json()).resolves.toEqual(GENERIC);
      // ずれの通知は、確認の送信より前に送信待ちに入っている。500 でも権利は返さない
      expect(sentTemplates()).toEqual(['ops_cron_secret_drift']);
      expect(secretReleases()).toHaveLength(0);
      expect(sendProbeCalls()).toHaveLength(1);
    }
    // 送れなかった確認 (vault_missing) は request_id 無しでよく、500 にならない
    vi.clearAllMocks();
    secretOnly({ cronSecretSend: { data: [{ probe_id: 43, send_state: 'vault_missing', request_id: null }], error: null } });
    const ok = await GET(authed());
    expect(ok.status).toBe(200);
  });

  it('CS-10: 直った (最新の決まった確認が 200 current) 回は所見なし。古い 401 の行が残っていても鳴らない', async () => {
    secretOnly({
      cronSecretResults: resultsOf(
        probeRow({ probe_id: 42, requested_at: minutesAgo(15) }),
        mismatchRow({ probe_id: 41, requested_at: minutesAgo(30) }),
        mismatchRow({ probe_id: 40, requested_at: minutesAgo(45) }),
      ),
    });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(secretClaims()).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(sendProbeCalls()).toHaveLength(1);
  });

  it('CS-10b: 送ったばかりの確認 (未応答・猶予内) は判定に使わず、その前の決まった確認で判定する。info の所見 (edge-alias-used) はメールにしない', async () => {
    secretOnly({
      cronSecretResults: resultsOf(
        unansweredRow({ probe_id: 42, requested_at: minutesAgo(1) }),
        probeRow({ probe_id: 41, requested_at: minutesAgo(16), alias_used: true }),
      ),
    });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({ cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(secretClaims()).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CS-11: canary: 環境変数 CRON_SECRET / CRON_SECRET_PREVIOUS と RPC の応答の body_error / body_code / matched に偽の秘密を入れても、メールの件名・本文、logger の全呼び出しの引数、応答の JSON のどこにもその文字列が現れない', async () => {
    const canaryCron = 'canary-cron-secret-aaaa1111bbbb2222';
    const canaryPrevious = 'canary-cron-previous-cccc3333dddd4444';
    const canaryBody = 'canary-body-eeee5555ffff6666';
    vi.stubEnv('CRON_SECRET', canaryCron);
    vi.stubEnv('CRON_SECRET_PREVIOUS', canaryPrevious);
    // 401 + code (gateway-jwt の fail) と、Vercel の CRON_SECRET_PREVIOUS (vercel-previous-set の warn) で、両方の通知を出す
    secretOnly({
      cronSecretResults: resultsOf(
        mismatchRow({ body_error: canaryBody, body_code: canaryBody, matched: canaryBody }),
      ),
    });

    const res = await GET(makeRequest(`Bearer ${canaryCron}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cron_secret_drift).toEqual({ status: 'sent', total: 1, threshold: 0 });
    expect(body.cron_secret_rotation).toEqual({ status: 'sent', total: 1, threshold: 0 });
    expect(sentTemplates()).toEqual(['ops_cron_secret_drift', 'ops_cron_secret_drift']);

    const everything = JSON.stringify({
      emails: mocks.sendEmail.mock.calls,
      logInfo: mocks.logInfo.mock.calls,
      logWarn: mocks.logWarn.mock.calls,
      logError: mocks.logError.mock.calls,
      consoleWarn: consoleWarn.mock.calls,
      consoleError: consoleError.mock.calls,
      response: body,
      rpc: mocks.rpc.mock.calls,
    });
    for (const secret of [canaryCron, canaryPrevious, canaryBody]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it('CS-12: ログに出すのは scope・total・threshold・finding_ids・outbox_id だけ (所見の題・対処も出さない)', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });

    await GET(authed());

    const logged = mocks.logInfo.mock.calls.filter(([, meta]) => (meta as { scope?: string } | undefined)?.scope === 'cron_secret_drift');
    expect(logged).toHaveLength(1);
    const [message, meta] = logged[0] as [string, Record<string, unknown>];
    expect(message).toBe('cron の共有シークレットのずれを運用メールに知らせました');
    expect(Object.keys(meta).sort()).toEqual(['finding_ids', 'outbox_id', 'scope', 'threshold', 'total']);
    expect(meta).toEqual({ scope: 'cron_secret_drift', total: 1, threshold: 0, finding_ids: ['edge-vault-mismatch'], outbox_id: 'email-id-1' });
    expect(JSON.stringify(mocks.logInfo.mock.calls)).not.toContain(CRON_SECRET_FINDING_CATALOG['edge-vault-mismatch'].title);
  });

  // ---- 入れ替えの途中 (warn。キー cron_secret_rotation) ----

  it('CR-1: 200 previous (previous_configured true) → warn → 権利 (キー cron_secret_rotation・既定の抑止 1440 分) を取り、ops_cron_secret_drift (kind rotation) を 1 通。cron_secret_drift は below_threshold', async () => {
    secretOnly({ cronSecretResults: resultsOf(probeRow({ matched: 'previous', previous_configured: true })) });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(secretClaims()).toEqual([['claim_ops_alert', { p_alert_key: 'cron_secret_rotation', p_cooldown_minutes: 1440 }]]);
    expect(sentTemplates()).toEqual(['ops_cron_secret_drift']);
    expect(sentSubjects()).toEqual([CRON_SECRET_ROTATION_SUBJECT(1)]);
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG['edge-previous-in-use'].title);
    expect(sendProbeCalls()).toHaveLength(1);
  });

  it('CR-2: 200 current・previous_configured → edge-previous-leftover で rotation の通知', async () => {
    secretOnly({ cronSecretResults: resultsOf(probeRow({ previous_configured: true })) });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(sentSubjects()).toEqual([CRON_SECRET_ROTATION_SUBJECT(1)]);
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG['edge-previous-leftover'].title);
  });

  it('CR-3: 200 service_role_key → vault-holds-service-role-key で rotation の通知', async () => {
    secretOnly({ cronSecretResults: resultsOf(probeRow({ matched: 'service_role_key' })) });

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(sentSubjects()).toEqual([CRON_SECRET_ROTATION_SUBJECT(1)]);
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG['vault-holds-service-role-key'].title);
  });

  it('CR-4: Vercel の CRON_SECRET_PREVIOUS が現行と同じ (vi.stubEnv) → vercel-previous-same で rotation の通知。違う値なら vercel-previous-set で rotation の通知 (題が違う)。cron_secret_drift はどちらも below_threshold', async () => {
    secretOnly();
    vi.stubEnv('CRON_SECRET_PREVIOUS', SECRET);

    const same = await GET(authed());

    await expect(same.json()).resolves.toMatchObject({
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-same'].title);
    expect(sentTexts()[0]).not.toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-set'].title);

    vi.clearAllMocks();
    secretOnly();
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);

    // 旧い値 (CRON_SECRET_PREVIOUS) でも認証は通る。違う値なので vercel-previous-set
    const set = await GET(makeRequest(`Bearer ${SECRET}`));

    await expect(set.json()).resolves.toMatchObject({
      cron_secret_drift: CRON_SECRET_QUIET,
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(sentTexts()[0]).toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-set'].title);
    expect(sentTexts()[0]).not.toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-same'].title);
  });

  it('CR-5: OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES で rotation の権利の抑止を変える。不正な値は既定 (1440) に戻して warn (変数名だけ)。drift の抑止 (OPS_ALERT_COOLDOWN_MINUTES) は変わらない', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);
    vi.stubEnv('OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES', '2880');
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', '120');

    await GET(authed());

    // drift は OPS_ALERT_COOLDOWN_MINUTES (120)・rotation は新しい変数 (2880)
    expect(secretClaims()).toEqual([
      ['claim_ops_alert', { p_alert_key: 'cron_secret_drift', p_cooldown_minutes: 120 }],
      ['claim_ops_alert', { p_alert_key: 'cron_secret_rotation', p_cooldown_minutes: 2880 }],
    ]);
    expect(mocks.logWarn).not.toHaveBeenCalledWith('しきい値・クールダウンの環境変数の値が正しくないため、既定値を使います', expect.anything());

    for (const bad of ['1439', '10081', 'abc', '2.5']) {
      vi.clearAllMocks();
      secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
      vi.stubEnv('OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES', bad);
      vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', undefined);

      await GET(authed());

      expect(secretClaims(), bad).toEqual([
        ['claim_ops_alert', { p_alert_key: 'cron_secret_drift', p_cooldown_minutes: 60 }],
        ['claim_ops_alert', { p_alert_key: 'cron_secret_rotation', p_cooldown_minutes: 1440 }],
      ]);
      expect(mocks.logWarn, bad).toHaveBeenCalledWith('しきい値・クールダウンの環境変数の値が正しくないため、既定値を使います', {
        ignored_env: ['OPS_ALERT_CRON_SECRET_ROTATION_COOLDOWN_MINUTES'],
      });
    }
  });

  it('CR-6: fail と warn が同時 (401 + Vercel の previous が同じ) なら、drift の通知 (fail だけを載せる) と rotation の通知 (warn だけ) が別のキーで 1 通ずつ出る。drift の total は 1・rotation の total は 1。drift の文面に warn の題が無い', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    vi.stubEnv('CRON_SECRET_PREVIOUS', SECRET);

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'sent', total: 1, threshold: 0 },
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(claimKeys().filter((key) => key.startsWith('cron_secret_'))).toEqual(['cron_secret_drift', 'cron_secret_rotation']);
    expect(sentSubjects()).toEqual([CRON_SECRET_DRIFT_SUBJECT(1), CRON_SECRET_ROTATION_SUBJECT(1)]);
    const [driftText, rotationText] = sentTexts();
    expect(driftText).toContain(CRON_SECRET_FINDING_CATALOG['edge-vault-mismatch'].title);
    expect(driftText).not.toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-same'].title);
    expect(rotationText).toContain(CRON_SECRET_FINDING_CATALOG['vercel-previous-same'].title);
    expect(rotationText).not.toContain(CRON_SECRET_FINDING_CATALOG['edge-vault-mismatch'].title);
  });

  it('CR-7: rotation の通知を送れなかったときは rotation のキーだけを返す (drift の抑止は触らない)', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    vi.stubEnv('CRON_SECRET_PREVIOUS', SECRET);
    mocks.sendEmail.mockResolvedValueOnce(sentResult).mockResolvedValueOnce(outboxFailedResult);

    const res = await GET(authed());

    await expect(res.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'sent', total: 1, threshold: 0 },
      cron_secret_rotation: { status: 'send_failed', total: 1, threshold: 0 },
    });
    expect(secretReleases()).toEqual([['release_ops_alert', { p_alert_key: 'cron_secret_rotation', p_claimed_at: CRON_SECRET_ROTATION_CLAIMED_AT }]]);
    expect(sendProbeCalls()).toHaveLength(1);
  });

  it('CR-8: Vercel と Supabase 側は比べない (Q-1・S-23): CRON_SECRET を別の値に stub し CRON_SECRET_PREVIOUS は無し・確認の結果は 200 current → 両方 below_threshold。send_cron_secret_probe は引数なしで呼ばれ、どの RPC の引数を JSON.stringify しても CRON_SECRET の値が現れない', async () => {
    const vercelOnly = 'dummy-vercel-only-cron-secret-9876543210';
    vi.stubEnv('CRON_SECRET', vercelOnly);
    secretOnly({ cronSecretResults: resultsOf(probeRow()) });

    const res = await GET(makeRequest(`Bearer ${vercelOnly}`));

    await expect(res.json()).resolves.toMatchObject({ cron_secret_drift: CRON_SECRET_QUIET, cron_secret_rotation: CRON_SECRET_QUIET });
    expect(secretClaims()).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 引数なし (rpc の第 2 引数が undefined。Vercel の値を Supabase 側へ送らない)
    expect(sendProbeCalls()).toHaveLength(1);
    expect(sendProbeCalls()[0]).toEqual(['send_cron_secret_probe']);
    expect(sendProbeCalls()[0][1]).toBeUndefined();
    for (const call of mocks.rpc.mock.calls) {
      expect(JSON.stringify(call[1] ?? null)).not.toContain(vercelOnly);
    }
  });

  // ---- 順と独立 ----

  it('CO-1: 順は server → client → email_dead_letter → cron_failure → pg_cron_stalled → cron_secret (results → claim → sendEmail → send)。後ろの 500 は前の通知を止めない', async () => {
    const stalledRun = {
      data: [{ cron_available: true, active_jobs: 17, last_run_at: minutesAgo(90) }],
      error: null,
    } as const;
    const FAILURE_ROWS = [{ source: 'pg_cron', job_name: 'cleanup-old-app-logs', failed_count: 1, total_count: 1 }];
    const everything = (overrides: Partial<Scenario> = {}) =>
      setScenario({
        clientCounts: { data: rowsOf(101), error: null },
        deadCounts: { data: DEAD_ROWS, error: null },
        cronFailureCounts: { data: FAILURE_ROWS, error: null },
        cronFailureMark: { data: FAILURE_ROWS, error: null },
        pgCronLastRun: stalledRun,
        cronSecretResults: resultsOf(mismatchRow()),
        ...overrides,
      });
    everything();
    vi.stubEnv('CRON_SECRET_PREVIOUS', SECRET);
    const order: string[] = [];
    const harness = mocks.rpc.getMockImplementation();
    mocks.rpc.mockImplementation(async (fn: string, args?: { p_alert_key?: string }) => {
      order.push(fn === 'claim_ops_alert' ? `claim_ops_alert:${args?.p_alert_key}` : fn);
      return harness?.(fn, args);
    });
    mocks.sendEmail.mockImplementation(async (envelope: { template?: string }) => {
      order.push(`sendEmail:${envelope.template}`);
      return sentResult;
    });

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(sentTemplates()).toEqual([
      'ops_app_log_error_spike',
      'ops_app_log_error_spike',
      'ops_email_dead_letter',
      'ops_cron_failure',
      'ops_pg_cron_stalled',
      'ops_cron_secret_drift',
      'ops_cron_secret_drift',
    ]);
    expect(order.slice(order.indexOf('pg_cron_last_run_at'))).toEqual([
      'pg_cron_last_run_at',
      'claim_ops_alert:pg_cron_stalled',
      'sendEmail:ops_pg_cron_stalled',
      'cron_secret_probe_results',
      'claim_ops_alert:cron_secret_drift',
      'sendEmail:ops_cron_secret_drift',
      'claim_ops_alert:cron_secret_rotation',
      'sendEmail:ops_cron_secret_drift',
      'send_cron_secret_probe',
    ]);

    // 最後の cron_secret が 500 でも、前の 5 種類の通知は送り終えている
    vi.clearAllMocks();
    everything({ cronSecretResults: { data: null, error: { code: '57P01', message: 'terminating connection due to administrator command' } } });
    const failed = await GET(authed());
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual(GENERIC);
    expect(sentTemplates()).toEqual([
      'ops_app_log_error_spike',
      'ops_app_log_error_spike',
      'ops_email_dead_letter',
      'ops_cron_failure',
      'ops_pg_cron_stalled',
    ]);
  });

  it('CO-2: pg_cron_stalled の通知を送ったあと cron_secret_probe_results が error なら 500。前の 5 種類の sendEmail は呼ばれたまま', async () => {
    setScenario({
      pgCronLastRun: { data: [{ cron_available: true, active_jobs: 17, last_run_at: minutesAgo(90) }], error: null },
      cronSecretResults: { data: null, error: { code: '42883', message: 'function public.cron_secret_probe_results does not exist' } },
    });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual(GENERIC);
    expect(sentTemplates()).toEqual(['ops_app_log_error_spike', 'ops_pg_cron_stalled']);
    expect(secretClaims()).toHaveLength(0);
    expect(sendProbeCalls()).toHaveLength(0);
    // 500 の内容は app_logs に残る (scope と RPC の名前)
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ scope: 'cron_secret_drift', rpc: 'cron_secret_probe_results' }),
    );
  });

  it('CO-3: OPS_ALERT_EMAIL が未設定・形が不正の回は、確認の結果に fail があっても cron_secret_probe_results も send_cron_secret_probe も呼ばない (disabled / invalid_config)', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    vi.stubEnv('OPS_ALERT_EMAIL', undefined);

    const disabled = await GET(authed());

    await expect(disabled.json()).resolves.toEqual({ status: 'disabled' });
    expect(rpcCalls('cron_secret_probe_results')).toHaveLength(0);
    expect(sendProbeCalls()).toHaveLength(0);

    vi.clearAllMocks();
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()) });
    vi.stubEnv('OPS_ALERT_EMAIL', 'not-an-email-address');

    const invalid = await GET(authed());

    await expect(invalid.json()).resolves.toEqual({ status: 'invalid_config' });
    expect(rpcCalls('cron_secret_probe_results')).toHaveLength(0);
    expect(sendProbeCalls()).toHaveLength(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('CO-4: 2 つのキーは独立: drift が抑止の間 (deduped) でも rotation は送れる。その逆も', async () => {
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()), cronSecretDriftClaim: { data: null, error: null } });
    vi.stubEnv('CRON_SECRET_PREVIOUS', OLD_SECRET);

    const driftDeduped = await GET(authed());

    await expect(driftDeduped.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'deduped', total: 1, threshold: 0 },
      cron_secret_rotation: { status: 'sent', total: 1, threshold: 0 },
    });
    expect(sentSubjects()).toEqual([CRON_SECRET_ROTATION_SUBJECT(1)]);

    vi.clearAllMocks();
    secretOnly({ cronSecretResults: resultsOf(mismatchRow()), cronSecretRotationClaim: { data: null, error: null } });

    const rotationDeduped = await GET(authed());

    await expect(rotationDeduped.json()).resolves.toMatchObject({
      cron_secret_drift: { status: 'sent', total: 1, threshold: 0 },
      cron_secret_rotation: { status: 'deduped', total: 1, threshold: 0 },
    });
    expect(sentSubjects()).toEqual([CRON_SECRET_DRIFT_SUBJECT(1)]);
  });
});
