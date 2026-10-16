/**
 * 定期処理の失敗 (pg_cron の失敗した実行・Vercel Cron の route の 500) と pg_cron の停止を運用メールに知らせる (#1125 の B) —
 * 純粋な関数と定数だけ (DB・メール送信・環境変数は読まない)。実際の処理は GET /api/cron/app-log-alerts
 * (src/app/api/cron/app-log-alerts/route.ts の checkCronFailures / checkPgCronStalled) が行い、ここの関数を呼ぶ。
 *
 * 仕組み (設計 docs/design/operator/11-ops-batches-non-billing.md §4):
 *   1. DB の cron_failure_counts が、直近 7 日の失敗した実行のうち、まだ知らせていない (台帳 cron_failure_alerts に無い) ものを
 *      (source, job_name) ごとに数える。窓は持たない (抑止の間・cron の発火の遅れの間の失敗も取りこぼさない)。
 *   2. 1 件からで、権利 (claim_ops_alert) を取れた回だけ、mark_cron_failures_alerted で台帳に書き、書けた件数で 1 通送る。
 *      送れなければ unmark_cron_failures_alerted で台帳の行を消し、権利を返す (次の回に持ち越す)。
 *   3. pg_cron の停止: pg_cron_last_run_at が返す最新の実行の時刻から、しきい値 (既定 60 分。OPS_ALERT_PG_CRON_STALL_MINUTES) を超えていたら知らせる。
 *      有効なジョブが無い・pg_cron が無い DB では判定しない。
 *
 * メールに載せるのは「名前」と「件数」だけ。cron.job_run_details の command / return_message・app_logs の本文・ユーザー ID は読まない。
 */

/** 失敗の出どころ。DB の cron_failure_alerts.source の CHECK と同じ 2 つ (tests/cron-failure-monitoring-contract.test.ts が突き合わせる) */
export const CRON_FAILURE_SOURCES = ['pg_cron', 'vercel_cron'] as const;
export type CronFailureSource = (typeof CRON_FAILURE_SOURCES)[number];

/** 失敗を見る範囲 (日)。DB の cron_failure_candidates() の c_lookback と同じ値 (文面に書くだけ。数えるのは DB。tests/cron-failure-monitoring-contract.test.ts が突き合わせる) */
export const CRON_FAILURE_LOOKBACK_DAYS = 7;

/**
 * pg_cron が止まっていると判定する、最新の実行からの分数 (既定値。この分数を超えたら通知する)。
 * migration が登録するジョブには 5 分おきのもの (requeue-stale-meal-image-jobs / process-pending-meal-image-jobs。#1561) と
 * 毎時 5 分のもの (calculate-segment-stats。#1406) があるので、60 分で 1 つも動いていなければ worker が止まっている。
 * 運用で変えるときは環境変数 OPS_ALERT_PG_CRON_STALL_MINUTES で上書きする (resolveAppLogAlertSettings)。
 * 1 時間より短い間隔のジョブが無くなったら、この値を見直す (tests/cron-failure-monitoring-contract.test.ts が見張る)
 */
export const PG_CRON_STALL_MINUTES = 60;
/** OPS_ALERT_PG_CRON_STALL_MINUTES で受け付ける最小値 (分)。5 分おきのジョブの 2 回分 */
export const PG_CRON_STALL_MINUTES_MIN = 10;
/** OPS_ALERT_PG_CRON_STALL_MINUTES で受け付ける最大値 (分)。1 日 */
export const PG_CRON_STALL_MINUTES_MAX = 1440;

/** 1 分のミリ秒 */
const MS_PER_MINUTE = 60_000;

/** 名前の区切り。メールには「pg_cron/cleanup-old-app-logs」「vercel_cron/cron/email-outbox」の形で載せる */
const SOURCE_NAME_SEPARATOR = '/';

function isCronFailureSource(value: unknown): value is CronFailureSource {
  return typeof value === 'string' && (CRON_FAILURE_SOURCES as readonly string[]).includes(value);
}

/**
 * cron_failure_counts / mark_cron_failures_alerted の行 (source / job_name / failed_count / total_count) を
 * ErrorCountRow の形 (function_name / error_count / total_count) にそろえてから parseErrorCountRows に渡す。
 * function_name は「<source>/<job_name>」。配列でない応答はそのまま返す (parseErrorCountRows が例外にする)。
 * source が想定の 2 つでなければ例外にする (黙って別の名前で数えると、どの仕組みの失敗か分からなくなる)
 */
export function normalizeCronFailureRows(data: unknown, rpcName: string): unknown {
  if (!Array.isArray(data)) return data;
  return data.map((row) => {
    if (row === null || typeof row !== 'object') return row;
    const { source, job_name: jobName, failed_count: failedCount, total_count: totalCount } = row as Record<string, unknown>;
    if (!isCronFailureSource(source)) {
      throw new Error(`${rpcName} の応答の source が想定外です`);
    }
    if (typeof jobName !== 'string') {
      throw new Error(`${rpcName} の応答の job_name が文字列ではありません`);
    }
    return { function_name: `${source}${SOURCE_NAME_SEPARATOR}${jobName}`, error_count: failedCount, total_count: totalCount };
  });
}

/** pg_cron_last_run_at (DB の関数) が返す 1 行 */
export interface PgCronLastRun {
  /** cron スキーマ (pg_cron) がある DB か。false なら停止は判定しない */
  cron_available: boolean;
  /** 有効なジョブの数。0 なら何も動かなくて正しい */
  active_jobs: number;
  /** 最新の実行の開始時刻 (ISO 8601)。実行履歴が 1 行も無ければ null */
  last_run_at: string | null;
}

/** 0 以上の整数 (PostgREST は bigint を数値で返すが、設定によっては文字列で来る) */
function toNonNegativeInteger(value: unknown, field: string, rpcName: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${rpcName} の応答の ${field} が 0 以上の整数ではありません`);
  }
  return n;
}

/**
 * pg_cron_last_run_at の応答 (RETURNS TABLE なので配列 1 行) を検証して型付きにする。
 * 形が想定と違うときは例外にする (黙って「動いている」と扱うと、停止の検知が静かに止まる)
 */
export function parsePgCronLastRun(data: unknown, rpcName: string): PgCronLastRun {
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined || typeof row !== 'object') {
    throw new Error(`${rpcName} の応答が行ではありません`);
  }
  const { cron_available: cronAvailable, active_jobs: activeJobs, last_run_at: lastRunAt } = row as Record<string, unknown>;
  if (typeof cronAvailable !== 'boolean') {
    throw new Error(`${rpcName} の応答の cron_available が真偽値ではありません`);
  }
  if (lastRunAt !== null && lastRunAt !== undefined && typeof lastRunAt !== 'string') {
    throw new Error(`${rpcName} の応答の last_run_at が文字列でも null でもありません`);
  }
  return {
    cron_available: cronAvailable,
    active_jobs: toNonNegativeInteger(activeJobs, 'active_jobs', rpcName),
    last_run_at: lastRunAt ?? null,
  };
}

export interface PgCronStallJudgement {
  /** 通知すべきか */
  stalled: boolean;
  /** 最新の実行からの分数 (切り捨て)。判定しないとき・実行履歴が無いときは 0 */
  minutes_since_last_run: number;
}

/**
 * pg_cron が止まっているか。有効なジョブが無い・pg_cron が無い DB では止まっていない扱い。
 * 実行履歴が 1 行も無いのに有効なジョブがあるときは止まっている扱い (保持 30 日の間に 1 回も動いていない)。
 * 分数がしきい値「を超えた」ときに通知する (ちょうどは通知しない。exceedsErrorThreshold と同じ向き)
 */
export function judgePgCronStall(run: PgCronLastRun, now: Date, stallMinutes: number = PG_CRON_STALL_MINUTES): PgCronStallJudgement {
  if (!run.cron_available || run.active_jobs === 0) {
    return { stalled: false, minutes_since_last_run: 0 };
  }
  if (run.last_run_at === null) {
    return { stalled: true, minutes_since_last_run: 0 };
  }
  const lastRun = new Date(run.last_run_at);
  if (Number.isNaN(lastRun.getTime())) {
    throw new Error('pg_cron_last_run_at の応答の last_run_at が日時ではありません');
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - lastRun.getTime()) / MS_PER_MINUTE));
  return { stalled: minutes > stallMinutes, minutes_since_last_run: minutes };
}
