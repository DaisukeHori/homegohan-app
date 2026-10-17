import { describe, expect, it } from 'vitest';
import {
  CRON_FAILURE_LOOKBACK_DAYS,
  CRON_FAILURE_SOURCES,
  PG_CRON_STALL_MINUTES,
  PG_CRON_STALL_MINUTES_MAX,
  PG_CRON_STALL_MINUTES_MIN,
  judgePgCronStall,
  normalizeCronFailureRows,
  parsePgCronLastRun,
  type PgCronLastRun,
} from '@/lib/ops-alerts/cron-failure';
import {
  APP_LOG_ALERT_KEYS,
  CRON_FAILURE_ALERT_KEY,
  CRON_FAILURE_ALERT_THRESHOLD,
  PG_CRON_STALLED_ALERT_KEY,
  parseErrorCountRows,
} from '@/lib/ops-alerts/app-log-error-spike';
import { BACKUP_STALE_ALERT_KEY } from '@/lib/backups/core';

// #1125 (B) 定期処理の失敗 (pg_cron の失敗した実行・Vercel Cron の route の 500) と pg_cron の停止の運用メール: 純粋な関数と定数。
// 設計: docs/design/operator/11-ops-batches-non-billing.md §6.1。DB・メール送信は route のテスト
// (src/__tests__/api/cron/app-log-alerts.test.ts の CF- / ST-) で確かめる。

const RPC = 'cron_failure_counts';

describe('定数 (#1125 の B)', () => {
  it('K-1: 定数: しきい値 0・停止 60 分 (10〜1440)・見る範囲 7 日', () => {
    expect(CRON_FAILURE_ALERT_THRESHOLD).toBe(0);
    expect(CRON_FAILURE_ALERT_KEY).toBe('cron_failure');
    expect(PG_CRON_STALLED_ALERT_KEY).toBe('pg_cron_stalled');
    expect(PG_CRON_STALL_MINUTES).toBe(60);
    expect(PG_CRON_STALL_MINUTES_MIN).toBe(10);
    expect(PG_CRON_STALL_MINUTES_MAX).toBe(1440);
    expect(CRON_FAILURE_LOOKBACK_DAYS).toBe(7);
    expect(CRON_FAILURE_SOURCES).toEqual(['pg_cron', 'vercel_cron']);
  });

  it('K-2: 権利のキーは互いに独立: APP_LOG_ALERT_KEYS の 7 つの値と src/lib/backups/core.ts の BACKUP_STALE_ALERT_KEY (backup_stale) はすべて異なる (S-20)', () => {
    const keys = [...Object.values(APP_LOG_ALERT_KEYS), BACKUP_STALE_ALERT_KEY];
    expect(Object.values(APP_LOG_ALERT_KEYS)).toHaveLength(7);
    expect(BACKUP_STALE_ALERT_KEY).toBe('backup_stale');
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('normalizeCronFailureRows (#1125 の B)', () => {
  it('N-1: source/job_name を function_name (<source>/<job_name>) にそろえ、件数をそのまま渡す', () => {
    const normalized = normalizeCronFailureRows(
      [
        { source: 'pg_cron', job_name: 'cleanup-old-app-logs', failed_count: 2, total_count: 3 },
        { source: 'vercel_cron', job_name: 'cron/email-outbox', failed_count: '1', total_count: '3' },
      ],
      RPC,
    );

    expect(normalized).toEqual([
      { function_name: 'pg_cron/cleanup-old-app-logs', error_count: 2, total_count: 3 },
      { function_name: 'vercel_cron/cron/email-outbox', error_count: '1', total_count: '3' },
    ]);
    // parseErrorCountRows に渡すと、文字列の bigint も整数にそろう
    expect(parseErrorCountRows(normalized, RPC)).toEqual([
      { function_name: 'pg_cron/cleanup-old-app-logs', error_count: 2, total_count: 3 },
      { function_name: 'vercel_cron/cron/email-outbox', error_count: 1, total_count: 3 },
    ]);
  });

  it('N-2: source が pg_cron / vercel_cron 以外なら例外 (黙って別の名前にしない)。job_name が文字列でないときも例外', () => {
    expect(() => normalizeCronFailureRows([{ source: 'github_actions', job_name: 'x', failed_count: 1, total_count: 1 }], RPC)).toThrow(
      `${RPC} の応答の source が想定外です`,
    );
    expect(() => normalizeCronFailureRows([{ job_name: 'x', failed_count: 1, total_count: 1 }], RPC)).toThrow('source が想定外');
    expect(() => normalizeCronFailureRows([{ source: 'pg_cron', job_name: null, failed_count: 1, total_count: 1 }], RPC)).toThrow(
      `${RPC} の応答の job_name が文字列ではありません`,
    );
  });

  it('N-3: 配列でない応答はそのまま返す (parseErrorCountRows が例外にする)。行がオブジェクトでなければその行もそのまま', () => {
    const notArray = { rows: [] };
    expect(normalizeCronFailureRows(notArray, RPC)).toBe(notArray);
    expect(normalizeCronFailureRows(null, RPC)).toBeNull();
    expect(() => parseErrorCountRows(normalizeCronFailureRows(notArray, RPC), RPC)).toThrow(`${RPC} の応答が配列ではありません`);
    expect(normalizeCronFailureRows(['x'], RPC)).toEqual(['x']);
    expect(normalizeCronFailureRows([], RPC)).toEqual([]);
  });
});

describe('parsePgCronLastRun (#1125 の B)', () => {
  const RUN_RPC = 'pg_cron_last_run_at';

  it('L-1: 配列 1 行を型付きにし、bigint が文字列でも受ける。last_run_at が無ければ null', () => {
    expect(parsePgCronLastRun([{ cron_available: true, active_jobs: 17, last_run_at: '2026-10-17T10:00:00+00:00' }], RUN_RPC)).toEqual({
      cron_available: true,
      active_jobs: 17,
      last_run_at: '2026-10-17T10:00:00+00:00',
    });
    expect(parsePgCronLastRun([{ cron_available: true, active_jobs: '17', last_run_at: null }], RUN_RPC)).toEqual({
      cron_available: true,
      active_jobs: 17,
      last_run_at: null,
    });
    expect(parsePgCronLastRun([{ cron_available: false, active_jobs: 0 }], RUN_RPC)).toEqual({
      cron_available: false,
      active_jobs: 0,
      last_run_at: null,
    });
    // 配列でなく 1 行のオブジェクトで来ても受ける
    expect(parsePgCronLastRun({ cron_available: true, active_jobs: 1, last_run_at: null }, RUN_RPC).active_jobs).toBe(1);
  });

  it('L-2: cron_available が真偽値でない・active_jobs が負・last_run_at が文字列でも null でもないときは例外', () => {
    expect(() => parsePgCronLastRun([{ cron_available: 'true', active_jobs: 1, last_run_at: null }], RUN_RPC)).toThrow(
      `${RUN_RPC} の応答の cron_available が真偽値ではありません`,
    );
    expect(() => parsePgCronLastRun([{ cron_available: true, active_jobs: -1, last_run_at: null }], RUN_RPC)).toThrow(
      `${RUN_RPC} の応答の active_jobs が 0 以上の整数ではありません`,
    );
    expect(() => parsePgCronLastRun([{ cron_available: true, active_jobs: 1.5, last_run_at: null }], RUN_RPC)).toThrow('active_jobs');
    expect(() => parsePgCronLastRun([{ cron_available: true, active_jobs: 1, last_run_at: 123 }], RUN_RPC)).toThrow(
      `${RUN_RPC} の応答の last_run_at が文字列でも null でもありません`,
    );
    // 行が無い・行がオブジェクトでない
    expect(() => parsePgCronLastRun([], RUN_RPC)).toThrow(`${RUN_RPC} の応答が行ではありません`);
    expect(() => parsePgCronLastRun(null, RUN_RPC)).toThrow('行ではありません');
    expect(() => parsePgCronLastRun('oops', RUN_RPC)).toThrow('行ではありません');
  });
});

describe('judgePgCronStall (#1125 の B)', () => {
  const NOW = new Date('2026-10-17T12:00:00Z');
  const minutesBefore = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
  const run = (overrides: Partial<PgCronLastRun>): PgCronLastRun => ({ cron_available: true, active_jobs: 17, last_run_at: minutesBefore(5), ...overrides });

  it('J-1: cron が無い・有効なジョブ 0 なら止まっていない扱い (分数 0)', () => {
    expect(judgePgCronStall(run({ cron_available: false, active_jobs: 0, last_run_at: null }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 0 });
    expect(judgePgCronStall(run({ cron_available: false, last_run_at: minutesBefore(999) }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 0 });
    expect(judgePgCronStall(run({ active_jobs: 0, last_run_at: minutesBefore(999) }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 0 });
  });

  it('J-2: 履歴が無いのに有効なジョブがあれば止まっている扱い', () => {
    expect(judgePgCronStall(run({ last_run_at: null }), NOW)).toEqual({ stalled: true, minutes_since_last_run: 0 });
  });

  it('J-3: しきい値ちょうどは通知せず、1 分でも超えたら通知する (60 分は対象外、61 分から)', () => {
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(59) }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 59 });
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(60) }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 60 });
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(61) }), NOW)).toEqual({ stalled: true, minutes_since_last_run: 61 });
    // 秒は切り捨てる (60 分 59 秒はまだ 60 分)
    const justUnder = new Date(NOW.getTime() - (60 * 60_000 + 59_000)).toISOString();
    expect(judgePgCronStall(run({ last_run_at: justUnder }), NOW).stalled).toBe(false);
    // 時計のずれで最新の実行が未来でも、分数は 0 未満にしない
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(-5) }), NOW)).toEqual({ stalled: false, minutes_since_last_run: 0 });
  });

  it('J-4: しきい値を引数で変えられる。日時でない last_run_at は例外 (黙って「動いている」と扱わない)', () => {
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(100) }), NOW, 120).stalled).toBe(false);
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(121) }), NOW, 120).stalled).toBe(true);
    expect(judgePgCronStall(run({ last_run_at: minutesBefore(11) }), NOW, 10).stalled).toBe(true);
    expect(() => judgePgCronStall(run({ last_run_at: 'not-a-date' }), NOW)).toThrow('last_run_at が日時ではありません');
  });
});
