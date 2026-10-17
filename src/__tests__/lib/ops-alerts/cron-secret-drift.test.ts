import { describe, expect, it } from 'vitest';
import { APP_LOG_ALERT_KEYS } from '@/lib/ops-alerts/app-log-error-spike';
import {
  CRON_SECRET_ALERT_THRESHOLD,
  CRON_SECRET_DRIFT_ALERT_KEY,
  CRON_SECRET_FINDING_CATALOG,
  CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES,
  CRON_SECRET_PROBE_LOOKBACK_MINUTES,
  CRON_SECRET_PROBE_MATCHES,
  CRON_SECRET_PROBE_RESULT_LIMIT,
  CRON_SECRET_PROBE_RESULTS_RPC,
  CRON_SECRET_PROBE_SEND_RPC,
  CRON_SECRET_PROBE_SEND_STATES,
  CRON_SECRET_ROTATION_ALERT_KEY,
  CRON_SECRET_ROTATION_COOLDOWN_MINUTES,
  CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MAX,
  CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MIN,
  EDGE_NOT_CONFIGURED_BODY_ERROR,
  EDGE_UNAUTHORIZED_BODY_ERROR,
  cronSecretFinding,
  cronSecretFindingIds,
  isDecidedProbe,
  judgeCronSecretProbe,
  judgeProbeRow,
  judgeVercelRotation,
  parseCronSecretProbeRows,
  parseCronSecretProbeSendResult,
  partitionCronSecretFindings,
  selectDecidedProbe,
  type CronSecretFindingId,
  type CronSecretProbeResultRow,
} from '@/lib/ops-alerts/cron-secret-drift';
import { BACKUP_STALE_ALERT_KEY } from '@/lib/backups/core';

// #1560 cron の共有シークレットのずれの自動・定期の検知: 純粋な関数と定数。
// 設計: docs/design/operator/12-cron-secret-drift-monitor.md §7.1・§8.1.1。DB・メール送信は route のテスト
// (src/__tests__/api/cron/app-log-alerts.test.ts の CS- / CR- / CO-) で確かめる。

const NOW = new Date('2026-10-17T01:30:00.000Z');
const MS_PER_MINUTE = 60_000;
/** 「いま」から分だけ前の ISO 時刻 */
const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * MS_PER_MINUTE).toISOString();

/** 応答のある 200 current の行 (所見なし) を元に、項目を変えて作る */
function row(overrides: Partial<CronSecretProbeResultRow> = {}): CronSecretProbeResultRow {
  return {
    probe_id: 41,
    requested_at: minutesAgo(15),
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
    ...overrides,
  };
}

/** 応答の無い行 (送れなかった確認を含む) */
function unansweredRow(overrides: Partial<CronSecretProbeResultRow> = {}): CronSecretProbeResultRow {
  return row({
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
}

function idsOf(rows: readonly CronSecretProbeResultRow[]): CronSecretFindingId[] {
  return cronSecretFindingIds(judgeCronSecretProbe(rows, NOW).findings);
}

describe('定数 (#1560)', () => {
  it('K-1: 定数: しきい値 0・見る範囲 60 分・8 行・猶予 5 分・rotation の抑止 1440 (1440〜10080)', () => {
    expect(CRON_SECRET_ALERT_THRESHOLD).toBe(0);
    expect(CRON_SECRET_PROBE_LOOKBACK_MINUTES).toBe(60);
    expect(CRON_SECRET_PROBE_RESULT_LIMIT).toBe(8);
    expect(CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES).toBe(5);
    expect(CRON_SECRET_ROTATION_COOLDOWN_MINUTES).toBe(1440);
    expect(CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MIN).toBe(1440);
    expect(CRON_SECRET_ROTATION_COOLDOWN_MINUTES_MAX).toBe(10080);
    expect(CRON_SECRET_PROBE_RESULTS_RPC).toBe('cron_secret_probe_results');
    expect(CRON_SECRET_PROBE_SEND_RPC).toBe('send_cron_secret_probe');
    expect(CRON_SECRET_PROBE_SEND_STATES).toEqual(['sent', 'vault_missing', 'vault_empty', 'vault_unreadable', 'vault_unavailable', 'net_unavailable']);
    expect(CRON_SECRET_PROBE_MATCHES).toEqual(['current', 'previous', 'service_role_key']);
    expect(EDGE_UNAUTHORIZED_BODY_ERROR).toBe('Unauthorized');
    expect(EDGE_NOT_CONFIGURED_BODY_ERROR).toBe('Service not configured');
  });

  it('K-2: 権利のキーは互いに独立: APP_LOG_ALERT_KEYS の 7 つの値と BACKUP_STALE_ALERT_KEY はすべて異なる', () => {
    const keys = [...Object.values(APP_LOG_ALERT_KEYS), BACKUP_STALE_ALERT_KEY];
    expect(Object.values(APP_LOG_ALERT_KEYS)).toHaveLength(7);
    expect(CRON_SECRET_DRIFT_ALERT_KEY).toBe('cron_secret_drift');
    expect(CRON_SECRET_ROTATION_ALERT_KEY).toBe('cron_secret_rotation');
    expect(APP_LOG_ALERT_KEYS.cron_secret_drift).toBe(CRON_SECRET_DRIFT_ALERT_KEY);
    expect(APP_LOG_ALERT_KEYS.cron_secret_rotation).toBe(CRON_SECRET_ROTATION_ALERT_KEY);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('K-3: 所見の表は 21 件で、id と level の内訳 (fail 13 / warn 5 / info 3) が設計 §8.1.1 のとおり。cronSecretFinding(id) は表の文をそのまま返す', () => {
    const entries = Object.entries(CRON_SECRET_FINDING_CATALOG);
    expect(entries).toHaveLength(21);
    const idsByLevel = (level: string) => entries.filter(([, text]) => text.level === level).map(([id]) => id).sort();
    expect(idsByLevel('fail')).toEqual(
      [
        'edge-vault-mismatch',
        'edge-not-configured',
        'vault-missing',
        'vault-empty',
        'vault-unreadable',
        'vault-unavailable',
        'pg-net-unavailable',
        'gateway-jwt',
        'probe-not-deployed',
        'probe-timeout',
        'probe-error',
        'probe-unanswered',
        'probe-unexpected-response',
      ].sort(),
    );
    expect(idsByLevel('warn')).toEqual(
      ['edge-previous-in-use', 'edge-previous-leftover', 'vault-holds-service-role-key', 'vercel-previous-same', 'vercel-previous-set'].sort(),
    );
    expect(idsByLevel('info')).toEqual(['edge-alias-used', 'no-probe-yet', 'probe-pending'].sort());
    for (const [id, text] of entries) {
      expect(cronSecretFinding(id as CronSecretFindingId), id).toEqual({ id, level: text.level, title: text.title, action: text.action });
      expect(text.title.length, id).toBeGreaterThan(0);
      expect(text.action.length, id).toBeGreaterThan(0);
    }
  });
});

describe('parseCronSecretProbeRows / parseCronSecretProbeSendResult (#1560)', () => {
  it('N-1: parseCronSecretProbeRows は配列の各行を型付きにし、bigint が文字列でも受ける。NULL の項目は null', () => {
    const parsed = parseCronSecretProbeRows([
      { ...row({ probe_id: 41 }), probe_id: '41', http_status: '200' },
      unansweredRow({ probe_id: 42, send_state: 'vault_missing' }),
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(row({ probe_id: 41, requested_at: parsed[0].requested_at }));
    expect(parsed[0].probe_id).toBe(41);
    expect(parsed[0].http_status).toBe(200);
    expect(parsed[1]).toMatchObject({
      probe_id: 42,
      send_state: 'vault_missing',
      answered: false,
      http_status: null,
      timed_out: null,
      has_error: null,
      matched: null,
      previous_configured: null,
      alias_used: null,
      body_error: null,
      body_code: null,
    });
    // undefined の項目も null として受ける
    const { http_status: _omitted, ...withoutStatus } = unansweredRow();
    void _omitted;
    expect(parseCronSecretProbeRows([withoutStatus])[0].http_status).toBeNull();
    expect(parseCronSecretProbeRows([])).toEqual([]);
  });

  it('N-2: 配列でない・行がオブジェクトでない・requested_at が日時でない・send_state が 6 値の外・answered が真偽値でない・http_status が負・timed_out が真偽値でない・matched が文字列でないときは例外', () => {
    expect(() => parseCronSecretProbeRows(null)).toThrow();
    expect(() => parseCronSecretProbeRows({})).toThrow();
    expect(() => parseCronSecretProbeRows(['x'])).toThrow();
    expect(() => parseCronSecretProbeRows([null])).toThrow();
    expect(() => parseCronSecretProbeRows([row({ requested_at: 'not a date' })])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), requested_at: 123 }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), send_state: 'unknown_state' }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), answered: 'true' }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), http_status: -1 }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), http_status: 'abc' }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), probe_id: null }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), timed_out: 'false' }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), has_error: 0 }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), previous_configured: 'yes' }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), alias_used: 1 }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), matched: 7 }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), body_error: {} }])).toThrow();
    expect(() => parseCronSecretProbeRows([{ ...row(), body_code: 7 }])).toThrow();
    // 例外の文に RPC の名前は入るが、入力の値は入らない
    const canary = 'canary-secret-value-0123456789';
    try {
      parseCronSecretProbeRows([{ ...row(), matched: { leaked: canary } }]);
      throw new Error('例外にならなかった');
    } catch (error) {
      expect(String((error as Error).message)).toContain(CRON_SECRET_PROBE_RESULTS_RPC);
      expect(String((error as Error).message)).not.toContain(canary);
    }
  });

  it('N-3: parseCronSecretProbeSendResult は配列 1 行を受け、sent なのに request_id が無ければ例外。sent でなければ request_id は null でよい', () => {
    expect(parseCronSecretProbeSendResult([{ probe_id: 42, send_state: 'sent', request_id: 9002 }])).toEqual({
      probe_id: 42,
      send_state: 'sent',
      request_id: 9002,
    });
    // 配列でない 1 行も受ける・bigint が文字列でも受ける
    expect(parseCronSecretProbeSendResult({ probe_id: '43', send_state: 'sent', request_id: '9003' })).toEqual({
      probe_id: 43,
      send_state: 'sent',
      request_id: 9003,
    });
    expect(parseCronSecretProbeSendResult([{ probe_id: 44, send_state: 'vault_missing', request_id: null }])).toEqual({
      probe_id: 44,
      send_state: 'vault_missing',
      request_id: null,
    });
    expect(() => parseCronSecretProbeSendResult([{ probe_id: 42, send_state: 'sent', request_id: null }])).toThrow();
    expect(() => parseCronSecretProbeSendResult([{ probe_id: 42, send_state: 'sent' }])).toThrow();
    expect(() => parseCronSecretProbeSendResult([])).toThrow();
    expect(() => parseCronSecretProbeSendResult(null)).toThrow();
    expect(() => parseCronSecretProbeSendResult(['x'])).toThrow();
    expect(() => parseCronSecretProbeSendResult([{ probe_id: 42, send_state: 'unknown_state', request_id: null }])).toThrow();
    expect(() => parseCronSecretProbeSendResult([{ send_state: 'vault_missing', request_id: null }])).toThrow();
  });
});

describe('決まった確認の選び方 (#1560)', () => {
  it('D-1: isDecidedProbe: send_state ≠ sent は決まっている。sent は応答ありか、猶予 (5 分) を 1 ミリ秒でも超えたら決まっている。猶予ちょうどは決まっていない', () => {
    for (const state of CRON_SECRET_PROBE_SEND_STATES.filter((s) => s !== 'sent')) {
      expect(isDecidedProbe(unansweredRow({ send_state: state, requested_at: minutesAgo(0) }), NOW), state).toBe(true);
    }
    // 応答あり
    expect(isDecidedProbe(row({ requested_at: minutesAgo(0) }), NOW)).toBe(true);
    // 応答なし: 猶予ちょうどは決まっていない・1 ミリ秒超えたら決まっている
    const graceMs = CRON_SECRET_PROBE_ANSWER_GRACE_MINUTES * MS_PER_MINUTE;
    const justGrace = unansweredRow({ requested_at: new Date(NOW.getTime() - graceMs).toISOString() });
    const overGrace = unansweredRow({ requested_at: new Date(NOW.getTime() - graceMs - 1).toISOString() });
    expect(isDecidedProbe(justGrace, NOW)).toBe(false);
    expect(isDecidedProbe(overGrace, NOW)).toBe(true);
    expect(isDecidedProbe(unansweredRow({ requested_at: minutesAgo(1) }), NOW)).toBe(false);
    // 猶予を引数で変えられる
    expect(isDecidedProbe(unansweredRow({ requested_at: minutesAgo(2) }), NOW, 1)).toBe(true);
  });

  it('D-2: selectDecidedProbe は requested_at の新しい順で最初の決まった確認を返す (入力の順に依らない)。同時刻は probe_id の大きい方', () => {
    const newestPending = unansweredRow({ probe_id: 44, requested_at: minutesAgo(1) });
    const decidedNew = row({ probe_id: 43, requested_at: minutesAgo(15) });
    const decidedOld = row({ probe_id: 42, requested_at: minutesAgo(30), http_status: 401, matched: null, body_error: 'Unauthorized' });
    const rows = [decidedOld, newestPending, decidedNew];
    expect(selectDecidedProbe(rows, NOW)?.probe_id).toBe(43);
    expect(selectDecidedProbe([...rows].reverse(), NOW)?.probe_id).toBe(43);
    // 決まった確認が無ければ null
    expect(selectDecidedProbe([newestPending], NOW)).toBeNull();
    expect(selectDecidedProbe([], NOW)).toBeNull();
    // 同時刻は probe_id の大きい方
    const sameTime = minutesAgo(15);
    expect(selectDecidedProbe([row({ probe_id: 50, requested_at: sameTime }), row({ probe_id: 51, requested_at: sameTime })], NOW)?.probe_id).toBe(51);
    expect(selectDecidedProbe([row({ probe_id: 51, requested_at: sameTime }), row({ probe_id: 50, requested_at: sameTime })], NOW)?.probe_id).toBe(51);
    // 入力の配列は変えない
    expect(rows.map((r) => r.probe_id)).toEqual([42, 44, 43]);
  });
});

/** 設計 §8.1.1 の判定表 P-1〜P-23 を 1 行ずつ。入力は決まった確認 1 行 (P-1・P-2 だけ行の集合) */
const JUDGEMENT_CASES: ReadonlyArray<{ name: string; rows: CronSecretProbeResultRow[]; expected: CronSecretFindingId[] }> = [
  { name: 'J-1 / P-1: 見る範囲に確認が 0 行 → no-probe-yet', rows: [], expected: ['no-probe-yet'] },
  {
    name: 'J-2 / P-2: 確認はあるが、どれも決まっていない (sent・未応答・猶予内) → probe-pending',
    rows: [unansweredRow({ requested_at: minutesAgo(1) })],
    expected: ['probe-pending'],
  },
  { name: 'J-3 / P-3: vault_missing → vault-missing', rows: [unansweredRow({ send_state: 'vault_missing' })], expected: ['vault-missing'] },
  { name: 'J-4 / P-4: vault_empty → vault-empty', rows: [unansweredRow({ send_state: 'vault_empty' })], expected: ['vault-empty'] },
  { name: 'J-5 / P-5: vault_unreadable → vault-unreadable', rows: [unansweredRow({ send_state: 'vault_unreadable' })], expected: ['vault-unreadable'] },
  { name: 'J-6 / P-6: vault_unavailable → vault-unavailable', rows: [unansweredRow({ send_state: 'vault_unavailable' })], expected: ['vault-unavailable'] },
  { name: 'J-7 / P-7: net_unavailable → pg-net-unavailable', rows: [unansweredRow({ send_state: 'net_unavailable' })], expected: ['pg-net-unavailable'] },
  {
    name: 'J-8 / P-8: sent・未応答・猶予超え → probe-unanswered',
    rows: [unansweredRow({ requested_at: minutesAgo(6) })],
    expected: ['probe-unanswered'],
  },
  {
    name: 'J-9 / P-9: timed_out true (has_error も true でもこの行) → probe-timeout',
    rows: [row({ http_status: null, timed_out: true, has_error: true, matched: null, previous_configured: null, alias_used: null })],
    expected: ['probe-timeout'],
  },
  {
    name: 'J-10 / P-10: timed_out が true でなく has_error true → probe-error (状態コードがあっても)',
    rows: [row({ http_status: 200, timed_out: false, has_error: true })],
    expected: ['probe-error'],
  },
  {
    name: 'J-10b / P-10: timed_out NULL・http_status NULL → probe-error',
    rows: [row({ http_status: null, timed_out: null, has_error: false, matched: null })],
    expected: ['probe-error'],
  },
  { name: 'J-11 / P-11: 200 current・previous なし・alias なし → 所見なし', rows: [row()], expected: [] },
  { name: 'J-12 / P-12: 200 current・previous_configured → edge-previous-leftover', rows: [row({ previous_configured: true })], expected: ['edge-previous-leftover'] },
  { name: 'J-13 / P-13: 200 previous → edge-previous-in-use', rows: [row({ matched: 'previous', previous_configured: true })], expected: ['edge-previous-in-use'] },
  { name: 'J-14 / P-14: 200 service_role_key → vault-holds-service-role-key', rows: [row({ matched: 'service_role_key' })], expected: ['vault-holds-service-role-key'] },
  { name: 'J-15 / P-15: 200 で matched が NULL → probe-unexpected-response', rows: [row({ matched: null })], expected: ['probe-unexpected-response'] },
  { name: 'J-15b / P-15: 200 で matched が想定外の文字列 → probe-unexpected-response', rows: [row({ matched: 'other' })], expected: ['probe-unexpected-response'] },
  {
    name: 'J-17 / P-17: 401 で body_code あり (ゲートウェイの JWT 検証) → gateway-jwt',
    rows: [row({ http_status: 401, matched: null, previous_configured: null, alias_used: null, body_code: 'UNAUTHORIZED_INVALID_JWT_FORMAT' })],
    expected: ['gateway-jwt'],
  },
  {
    name: 'J-18 / P-18: 401・body_code NULL・Unauthorized → edge-vault-mismatch',
    rows: [row({ http_status: 401, matched: null, previous_configured: null, alias_used: null, body_error: 'Unauthorized' })],
    expected: ['edge-vault-mismatch'],
  },
  {
    name: 'J-19 / P-19: 401 でそれ以外の本文 → probe-unexpected-response',
    rows: [row({ http_status: 401, matched: null, previous_configured: null, alias_used: null, body_error: 'Something else' })],
    expected: ['probe-unexpected-response'],
  },
  {
    name: 'J-19b / P-19: 401 で本文なし → probe-unexpected-response',
    rows: [row({ http_status: 401, matched: null, previous_configured: null, alias_used: null })],
    expected: ['probe-unexpected-response'],
  },
  {
    name: 'J-20 / P-20: 503・Service not configured → edge-not-configured',
    rows: [row({ http_status: 503, matched: null, previous_configured: null, alias_used: null, body_error: 'Service not configured' })],
    expected: ['edge-not-configured'],
  },
  {
    name: 'J-21 / P-21: 503 でそれ以外の本文 → probe-unexpected-response',
    rows: [row({ http_status: 503, matched: null, previous_configured: null, alias_used: null, body_error: 'SERVER_CONFIG_MISSING' })],
    expected: ['probe-unexpected-response'],
  },
  {
    name: 'J-22 / P-22: 404 → probe-not-deployed',
    rows: [row({ http_status: 404, matched: null, previous_configured: null, alias_used: null, body_code: 'NOT_FOUND' })],
    expected: ['probe-not-deployed'],
  },
  {
    name: 'J-23 / P-23: ほかの状態コード (405) → probe-unexpected-response',
    rows: [row({ http_status: 405, matched: null, previous_configured: null, alias_used: null, body_error: 'Method not allowed' })],
    expected: ['probe-unexpected-response'],
  },
  {
    name: 'J-23b / P-23: ほかの状態コード (500) → probe-unexpected-response',
    rows: [row({ http_status: 500, matched: null, previous_configured: null, alias_used: null })],
    expected: ['probe-unexpected-response'],
  },
];

describe('judgeCronSecretProbe: 設計 §8.1.1 の判定表 P-1〜P-23 (#1560)', () => {
  it.each(JUDGEMENT_CASES)('$name', ({ rows, expected }) => {
    expect(idsOf(rows)).toEqual(expected);
  });

  it('J-16 / P-16: alias_used true は P-11〜P-14 のそれぞれに重なって edge-alias-used (info) が 1 つ足される', () => {
    const aliasCases: ReadonlyArray<[string, Partial<CronSecretProbeResultRow>, CronSecretFindingId[]]> = [
      ['P-11', {}, ['edge-alias-used']],
      ['P-12', { previous_configured: true }, ['edge-previous-leftover', 'edge-alias-used']],
      ['P-13', { matched: 'previous', previous_configured: true }, ['edge-previous-in-use', 'edge-alias-used']],
      ['P-14', { matched: 'service_role_key' }, ['vault-holds-service-role-key', 'edge-alias-used']],
    ];
    for (const [label, overrides, expected] of aliasCases) {
      expect(idsOf([row({ ...overrides, alias_used: true })]), label).toEqual(expected);
      // 足されるのは info が 1 つだけ
      const findings = judgeCronSecretProbe([row({ ...overrides, alias_used: true })], NOW).findings;
      expect(findings.filter((f) => f.id === 'edge-alias-used'), label).toHaveLength(1);
      expect(findings.find((f) => f.id === 'edge-alias-used')?.level, label).toBe('info');
    }
    // 想定外の matched・401・503 には足さない
    expect(idsOf([row({ matched: 'other', alias_used: true })])).toEqual(['probe-unexpected-response']);
    expect(idsOf([row({ http_status: 401, matched: null, body_error: 'Unauthorized', alias_used: true })])).toEqual(['edge-vault-mismatch']);
  });

  it('J-9b: timed_out / has_error が NULL (応答の行の列が空) は false と同じに扱う (=== true で見る)', () => {
    expect(judgeProbeRow(row({ timed_out: null, has_error: null }))).toEqual([]);
  });

  it('J-24: judgeVercelRotation: P-24〜P-26', () => {
    expect(judgeVercelRotation({ previous_configured: false, previous_same_as_current: false })).toEqual([]);
    expect(cronSecretFindingIds(judgeVercelRotation({ previous_configured: true, previous_same_as_current: true }))).toEqual(['vercel-previous-same']);
    expect(cronSecretFindingIds(judgeVercelRotation({ previous_configured: true, previous_same_as_current: false }))).toEqual(['vercel-previous-set']);
    // 旧い値が無いなら、現行と同じかどうかは見ない
    expect(judgeVercelRotation({ previous_configured: false, previous_same_as_current: true })).toEqual([]);
    for (const finding of [
      ...judgeVercelRotation({ previous_configured: true, previous_same_as_current: true }),
      ...judgeVercelRotation({ previous_configured: true, previous_same_as_current: false }),
    ]) {
      expect(finding.level).toBe('warn');
    }
  });

  it('J-25: judgeCronSecretProbe は古い確認の結果を見ない (最新の決まった確認が 200 current なら、その前の 401 は所見にならない)', () => {
    const rows = [
      row({ probe_id: 40, requested_at: minutesAgo(45), http_status: 401, matched: null, body_error: 'Unauthorized' }),
      row({ probe_id: 41, requested_at: minutesAgo(30), http_status: 503, matched: null, body_error: 'Service not configured' }),
      row({ probe_id: 42, requested_at: minutesAgo(15) }),
    ];
    const judgement = judgeCronSecretProbe(rows, NOW);
    expect(judgement.decided?.probe_id).toBe(42);
    expect(judgement.findings).toEqual([]);
    // 最新が決まっていなければ、その前の決まった確認を使う
    const withPending = [...rows, unansweredRow({ probe_id: 43, requested_at: minutesAgo(1) })];
    expect(judgeCronSecretProbe(withPending, NOW).decided?.probe_id).toBe(42);
    // 古い 401 が最新の決まった確認なら所見になる
    expect(idsOf([rows[0]])).toEqual(['edge-vault-mismatch']);
  });

  it('J-26: body_error / body_code / matched に秘密らしい文字列 (canary) が入っていても、所見の title / action に現れない (所見は表の文だけ)', () => {
    const canary = 'canary-secret-value-0123456789';
    const hostileRows = [
      row({ http_status: 401, matched: canary, previous_configured: null, alias_used: null, body_error: canary, body_code: canary }),
      row({ http_status: 401, matched: null, previous_configured: null, alias_used: null, body_error: canary, body_code: null }),
      row({ http_status: 503, matched: null, body_error: canary }),
      row({ http_status: 200, matched: canary }),
      row({ http_status: 404, matched: null, body_code: canary }),
      row({ http_status: 418, matched: canary, body_error: canary, body_code: canary }),
    ];
    for (const hostile of hostileRows) {
      const findings = judgeCronSecretProbe([hostile], NOW).findings;
      expect(findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(findings)).not.toContain(canary);
      for (const finding of findings) {
        expect(finding).toEqual(cronSecretFinding(finding.id));
      }
    }
  });
});

describe('partitionCronSecretFindings / cronSecretFindingIds (#1560)', () => {
  it('Q-1: partitionCronSecretFindings は順を保って level で分け、cronSecretFindingIds は id だけを返す', () => {
    const findings = [
      cronSecretFinding('edge-previous-leftover'),
      cronSecretFinding('vault-missing'),
      cronSecretFinding('edge-alias-used'),
      cronSecretFinding('probe-timeout'),
      cronSecretFinding('vercel-previous-set'),
    ];
    const { fails, warns, infos } = partitionCronSecretFindings(findings);
    expect(cronSecretFindingIds(fails)).toEqual(['vault-missing', 'probe-timeout']);
    expect(cronSecretFindingIds(warns)).toEqual(['edge-previous-leftover', 'vercel-previous-set']);
    expect(cronSecretFindingIds(infos)).toEqual(['edge-alias-used']);
    expect(partitionCronSecretFindings([])).toEqual({ fails: [], warns: [], infos: [] });
    // id だけ (題・対処・level は含まない)
    expect(cronSecretFindingIds(findings)).toEqual(['edge-previous-leftover', 'vault-missing', 'edge-alias-used', 'probe-timeout', 'vercel-previous-set']);
  });
});
