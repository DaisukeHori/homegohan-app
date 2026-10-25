// src/lib/emails/account/account-frozen.ts
// 運営がアカウントを凍結したことを、凍結された本人に知らせるメール (#2026。設計の正典 docs/design/cross/24-freeze-notify-mail.md §7.2)。
// 送るのは運営の凍結の API (POST /api/admin/users/[id]/freeze) が notify_user: true で凍結に成功した直後の 1 通だけ
// (src/lib/admin/send-freeze-notification-email.ts)。sendEmail は送信待ち (email_outbox) に登録して返り、届けるのは GET /api/cron/email-outbox の worker。
// 文面は秘密 (受け取った人だけが使えるトークンを含むリンク #1708) を含まないので contains_secret を書かない (false も書かない)。
// 本文に入る値は、凍結の日時・解除の予定の日時 (日本時間)・運営が書いたメッセージだけ。理由カテゴリ・詳細理由・運営者の名前・本人の名前は入れない
// (利用規約第16条 4 項: 凍結の判断の根拠を開示する義務は無い。伝えたいことは運営がメッセージに書く)。
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { emailSignature } from '@/lib/emails/common';
import { getEmailFrom, getSiteUrl, getSupportEmail } from '@/lib/site-config';

/** 本文に書く日時のタイムゾーン (利用者は日本向け。本文にも「日本時間」と書く) */
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';
/** 例: 2026年10月25日 10:00 */
const FROZEN_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 文面の名前 (email_outbox.template)。封筒の template の literal と同じ値 (src/__tests__/lib/emails/account/account-frozen.test.ts が確かめる) */
export const ACCOUNT_FROZEN_EMAIL_TEMPLATE = 'account_frozen';
/** 件名 (EmailEnvelopeSchema の上限 100 字以内) */
export const ACCOUNT_FROZEN_EMAIL_SUBJECT = '【ほめゴハン】アカウントが凍結されました';
/** 凍結中の利用者の画面。ログインすると middleware がここへ移す (lib/supabase/middleware.ts) */
export const FROZEN_PAGE_PATH = '/frozen';
/** お問い合わせの画面。未ログインでも、凍結中でも開ける (#1871) */
export const CONTACT_PAGE_PATH = '/contact';

export interface AccountFrozenEmailVars {
  /** 宛先 (凍結された本人の auth.users の登録メールアドレス) */
  to_email: string;
  /** 凍結した日時 (user_profiles.frozen_at に書いた値) */
  frozen_at: Date;
  /** 一時 BAN の解除の予定 (user_profiles.unban_at)。永久 BAN は null */
  unban_at: Date | null;
  /** 運営が凍結の画面で書いた任意のメッセージ (前後の空白を除いたもの)。無ければ null */
  operator_message: string | null;
}

/** 日時を日本時間の「2026年10月25日 10:00」の形にする */
export function formatAccountFrozenAt(date: Date): string {
  return FROZEN_AT_FORMAT.format(date);
}

/** 凍結の種類と解除の予定の段 (一時 BAN は解除の予定の日時と自動解除の説明、永久 BAN は予定が無いこと) */
export function accountFrozenPeriodLines(unbanAt: Date | null): string {
  if (unbanAt === null) {
    return `凍結の種類: 無期限の凍結
解除の予定はありません。`;
  }
  return `凍結の種類: 一時的な凍結
解除の予定: ${formatAccountFrozenAt(unbanAt)} (日本時間)
解除の予定の日時が過ぎると、自動的に解除されます。`;
}

/**
 * アカウントの凍結を本人に知らせるメール
 * subject: 「【ほめゴハン】アカウントが凍結されました」
 *
 * 載せるのは凍結の日時・種類と解除の予定・運営からのメッセージ (あるときだけ)・凍結中にできること (利用規約第16条 2 項の語)・
 * 凍結中の画面とお問い合わせのリンク・問い合わせ先だけ。
 */
export function renderAccountFrozenEmail(vars: AccountFrozenEmailVars): EmailEnvelope {
  const operatorMessage = vars.operator_message === null ? '' : `
▼ 運営からのメッセージ
${vars.operator_message}
`;
  return {
    template: 'account_frozen',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: ACCOUNT_FROZEN_EMAIL_SUBJECT,
    text: `${formatAccountFrozenAt(vars.frozen_at)} (日本時間) に、このメールアドレスで登録されているほめゴハンのアカウントは、利用規約に基づき凍結されました。

${accountFrozenPeriodLines(vars.unban_at)}
${operatorMessage}
凍結中は、ほめゴハンの機能をご利用いただけません。ただし、データの書き出し・退会・有料プランの解約・お問い合わせの送信は、凍結中も行えます。
ログインすると凍結中のご案内の画面が開きます: ${getSiteUrl()}${FROZEN_PAGE_PATH}

凍結に心当たりがない場合や、詳細を確認したい場合は、お問い合わせからご連絡ください。
お問い合わせ: ${getSiteUrl()}${CONTACT_PAGE_PATH}
メール: ${getSupportEmail()}

${emailSignature()}
`,
  };
}
