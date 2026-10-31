/**
 * 届けられなかったメール (email_outbox の dead) を、運用のメールアドレス (OPS_ALERT_EMAIL) へ知らせる文面 (#1193)。
 * 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts の checkEmailDeadLetters)。ここは文面を作るだけ。
 * 載せるのは件数・文面の名前 (template)・送信待ちの画面へのリンクだけ。宛先・件名・本文・ユーザー ID は載せない
 * (送信先の Resend は米国の事業者。急増の通知 src/lib/emails/ops/app-log-error-spike.ts と同じ考え方)。利用者向けではないので署名は付けない。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';
import { sanitizeFunctionNameForAlert } from '@/lib/ops-alerts/app-log-error-spike';

export interface EmailDeadLetterEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  /** この通知で知らせる (印を付けた) dead の件数 */
  total: number;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 文面の名前 (template) ごとの件数 (多い順。summarizeErrorCounts の functions) */
  templates: ReadonlyArray<{ name: string; count: number }>;
  /** templates に載せなかった件数 (0 なら行を出さない) */
  other_count: number;
  /** 送信待ちの画面 (/super-admin/email-outbox) の絶対 URL */
  outbox_url: string;
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

/** subject: 「【ほめゴハン運用】届けられなかったメールがあります (3 件)」 */
export function renderEmailDeadLetterEmail(vars: EmailDeadLetterEmailVars): EmailEnvelope {
  const templateLines = vars.templates.map(
    (t, index) => `${String(index + 1).padStart(LIST_NUMBER_WIDTH, ' ')}. ${sanitizeFunctionNameForAlert(t.name)} … ${formatCount(t.count)} 件`,
  );
  if (vars.other_count > 0) {
    templateLines.push(`    ほかの文面: 合計 ${formatCount(vars.other_count)} 件`);
  }
  return {
    template: 'ops_email_dead_letter',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】届けられなかったメールがあります (${formatCount(vars.total)} 件)`,
    text: [
      'ほめゴハンの運用アラートです。',
      '',
      `アプリが送ろうとしたメールのうち、届けられなかったもの (送信待ち email_outbox の dead) が ${formatCount(vars.total)} 件あります。`,
      '前回のこの通知のあとに届けられなかったもので、まだ知らせていないものだけを数えています (同じメールを 2 回は数えません)。',
      '宛先停止リスト・退会で送らなかったものと、運用メール自身は数えていません。',
      '',
      '▼ 文面の名前 (template) ごとの件数 (多い順)',
      ...templateLines,
      '',
      '▼ 確認と再送',
      `送信待ちの画面 (${SUPER_ADMIN_ONLY_NOTE})`,
      vars.outbox_url,
      '状態を「届けられなかった」にすると、失敗の理由を確認できます。原因 (送信元ドメインの検証・API キーなど) を直してから、1 行ずつ「再送」してください。',
      '',
      `確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)`,
      '',
      `このメールは自動で送られています。同じ通知は ${vars.cooldown_minutes} 分以内には送り直しません (その間に届けられなかったメールは、次の通知で知らせます)。`,
      'このメールに、宛先・件名・本文・利用者の情報は含めていません。',
      '',
    ].join('\n'),
  };
}
