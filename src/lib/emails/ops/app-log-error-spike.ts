// src/lib/emails/ops/app-log-error-spike.ts
// #1157: app_logs の error が急に増えたときに、運用のメールアドレス (OPS_ALERT_EMAIL) へ送る通知。
// 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts)。ここは文面を作るだけ。
//
// 載せるのは「件数」「関数名」「運用ログ画面へのリンク」だけ。ユーザー ID・メールアドレス・ログの本文 (message / error_*) は
// 載せない (送信先の Resend は米国の事業者。個人情報を国外へ出さない)。関数名もここで念のためもう一度マスクする
// (sanitizeFunctionNameForAlert。ID やメールアドレスを含む名前が渡されても、そのままは載らない)。
// 利用者向けではない運用メールなので、署名 (emailSignature) は付けない。
import type { EmailEnvelope } from '../envelope';
import { getEmailFrom } from '@/lib/site-config';
import { sanitizeFunctionNameForAlert } from '@/lib/ops-alerts/app-log-error-spike';

export interface AppLogErrorSpikeEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  /** 窓の中の error の全体の件数 */
  total: number;
  /** 数えた窓 (分) */
  window_minutes: number;
  /** しきい値 (この件数を超えると通知する) */
  threshold: number;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 関数名ごとの件数 (多い順) */
  functions: ReadonlyArray<{ name: string; count: number }>;
  /** functions に載せなかった error の件数 (0 なら行を出さない) */
  other_count: number;
  /** 運用ログ画面 (/super-admin/logs) の絶対 URL */
  logs_url: string;
  /** 検知した時刻 (日本時間で表示する) */
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

/** 1,234 のように桁区切りにする (実行環境のロケールに左右されないよう ja-JP を指定) */
function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/**
 * subject: 「【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)」
 */
export function renderAppLogErrorSpikeEmail(vars: AppLogErrorSpikeEmailVars): EmailEnvelope {
  const functionLines = vars.functions.map(
    (f, index) => `${String(index + 1).padStart(2, ' ')}. ${sanitizeFunctionNameForAlert(f.name)} … ${formatCount(f.count)} 件`,
  );
  if (vars.other_count > 0) {
    functionLines.push(`    ほかの関数: 合計 ${formatCount(vars.other_count)} 件`);
  }

  return {
    template: 'ops_app_log_error_spike',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】エラーが急増しています (直近 ${vars.window_minutes} 分で ${formatCount(vars.total)} 件)`,
    text: `ほめゴハンの運用アラートです。

アプリのエラーログ (app_logs の level=error) が、直近 ${vars.window_minutes} 分で ${formatCount(vars.total)} 件ありました。
${vars.window_minutes} 分で ${formatCount(vars.threshold)} 件を超えると、この通知を送る設定です。

▼ 関数名ごとの件数 (多い順)
${functionLines.join('\n')}

▼ 詳しく見る
運用ログ画面 (super_admin のみ)
${vars.logs_url}
レベルを error、期間を直近 ${vars.window_minutes} 分ごろに絞ると、同じログを確認できます。

確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)

このメールは自動で送られています。同じ通知は ${vars.cooldown_minutes} 分以内には送り直しません。
このメールに、利用者の情報やログの本文は含めていません。
`,
  };
}
