/**
 * pg_cron の停止 (有効なジョブがあるのに、一定時間 1 つも動いていない) を、運用のメールアドレス (OPS_ALERT_EMAIL) へ知らせる文面 (#1125 の B)。
 * 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts の checkPgCronStalled)。ここは文面を作るだけ。
 * 載せるのは最新の実行の時刻・有効なジョブの数・しきい値だけ。利用者の情報は載せない。利用者向けではないので署名は付けない。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';

export interface PgCronStalledEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  /** 最新の実行からの分数 (実行履歴が無ければ 0) */
  minutes_since_last_run: number;
  /** 最新の実行の開始時刻。実行履歴が無ければ null */
  last_run_at: Date | null;
  /** 有効なジョブの数 */
  active_jobs: number;
  /** しきい値 (この分数を超えると通知する) */
  stall_minutes: number;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 運用ログ画面 (/super-admin/logs) の絶対 URL */
  logs_url: string;
  /** 確認した時刻 (日本時間で表示する) */
  detected_at: Date;
}

const JST_MINUTE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 実行履歴が 1 行も無いときの表示 */
const NO_HISTORY_LABEL = '記録なし';

/** 1,234 のように桁区切りにする (実行環境のロケールに左右されないよう ja-JP を指定) */
function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** subject: 「【ほめゴハン運用】pg_cron のジョブが 60 分以上動いていません」 */
export function renderPgCronStalledEmail(vars: PgCronStalledEmailVars): EmailEnvelope {
  const lastRun = vars.last_run_at === null ? NO_HISTORY_LABEL : `${JST_MINUTE_FORMAT.format(vars.last_run_at)} (日本時間)`;
  return {
    template: 'ops_pg_cron_stalled',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】pg_cron のジョブが ${formatCount(vars.stall_minutes)} 分以上動いていません`,
    text: [
      'ほめゴハンの運用アラートです。',
      '',
      `DB の定期処理 (pg_cron) に有効なジョブが ${formatCount(vars.active_jobs)} 本あるのに、最新の実行から ${formatCount(vars.minutes_since_last_run)} 分、1 つも動いていません (しきい値 ${formatCount(vars.stall_minutes)} 分)。`,
      `最新の実行: ${lastRun}`,
      '',
      '▼ 確認のしかた',
      'Supabase の SQL エディタで次を確かめる (手順は docs/design/operator/09-runbook.md §5.1):',
      '  SELECT jobname, schedule, active FROM cron.job ORDER BY jobid;',
      '  SELECT jobid, status, start_time, end_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;',
      'DB の再起動の直後や、pg_cron の worker が止まったときに起きます。直らなければ Supabase のサポートへ。',
      `運用ログの画面 (${SUPER_ADMIN_ONLY_NOTE}):`,
      vars.logs_url,
      '',
      `確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)`,
      '',
      `このメールは自動で送られています。止まったままなら ${vars.cooldown_minutes} 分ごとにもう一度お知らせします。`,
      'このメールに、利用者の情報は含めていません。',
      '',
    ].join('\n'),
  };
}
