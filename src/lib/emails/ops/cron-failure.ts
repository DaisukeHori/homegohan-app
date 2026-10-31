/**
 * 定期処理の失敗 (pg_cron の失敗した実行・Vercel Cron の route の 500) を、運用のメールアドレス (OPS_ALERT_EMAIL) へ知らせる文面 (#1125 の B)。
 * 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts の checkCronFailures)。ここは文面を作るだけ。
 * 載せるのは件数・名前 (pg_cron のジョブ名 / Vercel Cron の route 名)・運用ログ画面へのリンクだけ。
 * cron.job_run_details の command / return_message・ログの本文・ユーザー ID は載せない (送信先の Resend は米国の事業者)。
 * 利用者向けではないので署名は付けない。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';
import { sanitizeFunctionNameForAlert } from '@/lib/ops-alerts/app-log-error-spike';

export interface CronFailureEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  /** この通知で知らせる (台帳に書いた) 失敗の件数 */
  total: number;
  /** 失敗を見る範囲 (日)。文面に書くだけ */
  lookback_days: number;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 「<source>/<名前>」ごとの件数 (多い順。summarizeErrorCounts の functions) */
  failures: ReadonlyArray<{ name: string; count: number }>;
  /** failures に載せなかった件数 (0 なら行を出さない) */
  other_count: number;
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

/** 一覧の番号の幅 (載せるのは最大 10 件なので 2 桁にそろえる) */
const LIST_NUMBER_WIDTH = 2;

/** 1,234 のように桁区切りにする (実行環境のロケールに左右されないよう ja-JP を指定) */
function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** subject: 「【ほめゴハン運用】定期処理が失敗しています (3 件)」 */
export function renderCronFailureEmail(vars: CronFailureEmailVars): EmailEnvelope {
  const failureLines = vars.failures.map(
    (f, index) => `${String(index + 1).padStart(LIST_NUMBER_WIDTH, ' ')}. ${sanitizeFunctionNameForAlert(f.name)} … ${formatCount(f.count)} 件`,
  );
  if (vars.other_count > 0) {
    failureLines.push(`    ほかの処理: 合計 ${formatCount(vars.other_count)} 件`);
  }
  return {
    template: 'ops_cron_failure',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】定期処理が失敗しています (${formatCount(vars.total)} 件)`,
    text: [
      'ほめゴハンの運用アラートです。',
      '',
      `定期処理 (pg_cron のジョブ・Vercel Cron) の失敗した実行が ${formatCount(vars.total)} 件あります。`,
      `直近 ${vars.lookback_days} 日のうち、まだ知らせていないものだけを数えています (同じ失敗を 2 回は数えません)。`,
      '',
      '▼ 処理ごとの件数 (多い順。pg_cron/<ジョブ名> は DB の定期処理、vercel_cron/<route 名> は Vercel Cron)',
      ...failureLines,
      '',
      '▼ 確認のしかた',
      'pg_cron: Supabase の SQL エディタで cron.job_run_details の status = failed の行の return_message を見る (手順は docs/design/operator/09-runbook.md §5.1)。',
      `Vercel Cron: 運用ログの画面 (${SUPER_ADMIN_ONLY_NOTE}) で function_name を route 名に絞る。`,
      vars.logs_url,
      '',
      `確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)`,
      '',
      `このメールは自動で送られています。同じ通知は ${vars.cooldown_minutes} 分以内には送り直しません (その間に起きた失敗は、次の通知で知らせます)。`,
      'このメールに、処理の中身・エラーの本文・利用者の情報は含めていません。',
      '',
    ].join('\n'),
  };
}
