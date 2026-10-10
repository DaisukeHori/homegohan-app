import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';

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

const { GET } = await import('@/app/api/cron/app-log-alerts/route');

const SECRET = 'dummy-cron-secret-0123456789abcdef';
const OLD_SECRET = 'dummy-old-cron-secret-fedcba9876543210';
const OPS_EMAIL = 'ops-owner@example.test';
const SITE_URL = 'https://app.example.test';
const CLAIMED_AT = '2026-10-09T01:15:00.123456+00:00';

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

/** 全体が total 件で、1 つの関数に集中している行 */
const rowsOf = (total: number): CountRow[] =>
  total === 0 ? [] : [{ function_name: 'POST /api/meals', error_count: total, total_count: total }];

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

interface Scenario {
  counts: RpcResult;
  claim: RpcResult;
  release: RpcResult;
}

let scenario: Scenario;

function setScenario(overrides: Partial<Scenario> = {}) {
  scenario = {
    counts: { data: SURGE_ROWS, error: null },
    claim: { data: CLAIMED_AT, error: null },
    release: { data: true, error: null },
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
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('OPS_ALERT_EMAIL', OPS_EMAIL);
  // しきい値・クールダウンの上書きは、既定では無し (実行環境に設定があっても、既定値で確かめる)
  vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', undefined);
  vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', undefined);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  setScenario();
  mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'app_log_error_counts') return scenario.counts;
    if (fn === 'claim_ops_alert') return scenario.claim;
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
    await expect(res.json()).resolves.toEqual({ status: 'below_threshold', total: 20, threshold: 20, window_minutes: 15 });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // 何も起きなかった回は、ログを増やさない (15 分おきに積み上がらない)
    expect(mocks.logInfo).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('H-3: 21 件から通知する: 権利を取り、メールを 1 通送る', async () => {
    setScenario({ counts: { data: rowsOf(21), error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 21, threshold: 20, window_minutes: 15 });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('H-4: error が 1 件も無ければ (DB が空の配列を返す) 通知しない', async () => {
    setScenario({ counts: { data: [], error: null } });

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'below_threshold', total: 0, threshold: 20, window_minutes: 15 });
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
    await expect(res.json()).resolves.toEqual({ status: 'deduped', total: 42, threshold: 20, window_minutes: 15 });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls('release_ops_alert')).toHaveLength(0);
  });

  it('D-3: 急増が続いて何度呼ばれても、権利を取れた 1 回だけメールが出る', async () => {
    // DB の挙動を写す: 最初の 1 回だけ権利を取れて、以降はクールダウン中
    let claims = 0;
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'app_log_error_counts') return scenario.counts;
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

  it('D-4: 権利を取る前にはメールを送らない (数える → 権利を取る → 送る の順)', async () => {
    const order: string[] = [];
    mocks.rpc.mockImplementation(async (fn: string) => {
      order.push(fn);
      return fn === 'app_log_error_counts' ? scenario.counts : fn === 'claim_ops_alert' ? scenario.claim : scenario.release;
    });
    mocks.sendEmail.mockImplementation(async () => {
      order.push('sendEmail');
      return sentResult;
    });

    await GET(authed());

    expect(order).toEqual(['app_log_error_counts', 'claim_ops_alert', 'sendEmail']);
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
    });
    expect(rpcCalls('claim_ops_alert')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    setScenario({ counts: { data: rowsOf(51), error: null } });
    const over = await GET(authed());
    await expect(over.json()).resolves.toEqual({ status: 'sent', total: 51, threshold: 50, window_minutes: 15 });
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

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 6, threshold: 5, window_minutes: 15 });
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

      await expect(res.json(), threshold).resolves.toEqual({ status: 'sent', total: 21, threshold: 20, window_minutes: 15 });
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

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 31, threshold: 30, window_minutes: 15 });
    expect(rpcCalls('claim_ops_alert')[0][1]).toEqual({ p_alert_key: 'app_logs_error_spike', p_cooldown_minutes: 60 });
    expect(mocks.logWarn.mock.calls[0][1]).toEqual({ ignored_env: ['OPS_ALERT_COOLDOWN_MINUTES'] });
  });

  it('E-6: 空・空白だけは未設定と同じ (既定値。warn も残さない)', async () => {
    vi.stubEnv('OPS_ALERT_ERROR_THRESHOLD', '');
    vi.stubEnv('OPS_ALERT_COOLDOWN_MINUTES', '   ');

    const res = await GET(authed());

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 42, threshold: 20, window_minutes: 15 });
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

    await expect(res.json()).resolves.toEqual({ status: 'sent', total: 42, threshold: 20, window_minutes: 15 });
    expect(mocks.logInfo).toHaveBeenCalledTimes(1);
    const [, meta] = mocks.logInfo.mock.calls[0];
    expect(meta).toMatchObject({
      total: 42,
      threshold: 20,
      window_minutes: 15,
      other_count: 0,
      email_id: 'email-id-1',
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
    await expect(res.json()).resolves.toEqual({ status: 'send_failed', total: 42, threshold: 20, window_minutes: 15 });
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
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'app_log_error_counts') return scenario.counts;
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
  it('O-1: infra_alerts を含め、表を直接読み書きしない (DB への入口は 3 つの RPC だけ)', async () => {
    await GET(authed());
    mocks.sendEmail.mockResolvedValue(failedResult);
    await GET(authed());

    expect(mocks.from).not.toHaveBeenCalled();
    const used = new Set(mocks.rpc.mock.calls.map(([fn]) => fn));
    expect([...used].sort()).toEqual(['app_log_error_counts', 'claim_ops_alert', 'release_ops_alert']);
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

    // Next 14 の route handler は、dynamic = 'force-dynamic' だけでは fetch をキャッシュし続ける。
    // supabase-js の RPC (POST) と Resend の呼び出しが、同じ内容なら前回の応答で返ってしまう
    // (ローカルの dev サーバーで、DB の状態を変えても応答が変わらないことで確認した)。
    expect(routeModule.dynamic).toBe('force-dynamic');
    expect(routeModule.fetchCache).toBe('force-no-store');
  });
});
