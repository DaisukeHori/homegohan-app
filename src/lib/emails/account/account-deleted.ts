// src/lib/emails/account/account-deleted.ts
// 退会 (アカウント削除) が完了したことを、本人に知らせるメール (#1152)。
// 送るのは退会が成功したときの 1 通だけ (src/lib/account-deletion-notification.ts)。退会の受付時のメールは送らない。
// セッションを盗んだ第三者が退会させた場合に、本来の利用者が気づけるようにするのが目的。
// その本人は退会の確認の文 (STORE_SUBSCRIPTION_DELETION_NOTICE。billing/03 §10.4) を見ていないので、
// App Store / Google Play の購読が退会では解約されない (課金が続く) ことと、各ストアの定期購読の管理のページをこのメールにも書く。
import {
  IAP_STORE_LABELS,
  PURCHASE_STORES,
  STORE_SUBSCRIPTION_DELETION_NOTICE,
  STORE_SUBSCRIPTION_MANAGEMENT_URL,
} from '@homegohan/shared';
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';

/** 本文に書く日時のタイムゾーン (利用者は日本向け。本文にも「日本時間」と書く) */
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

/** 例: 2026年10月10日 00:05 */
const DELETED_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface AccountDeletedEmailVars {
  /** 宛先 (退会した本人の、削除前の auth.users の登録メールアドレス) */
  to_email: string;
  /** 退会が完了した日時 */
  deleted_at: Date;
}

/** 退会日時を日本時間の「2026年10月10日 00:05」の形にする */
export function formatAccountDeletedAt(date: Date): string {
  return DELETED_AT_FORMAT.format(date);
}

/**
 * ストアの購読は退会で解約されないことの注意と、各ストアの定期購読の管理のページ (1 行に 1 ストア)。
 * 文と行き先は @homegohan/shared の定数から組み、ここに手で書かない (退会の確認の 4 つの入口と同じ文になる)。
 * ストアの購読の有無で出し分けない: 退会の後は本人の購読の行が消えていて (CASCADE)、有無を読めないため。全員に出す
 */
export function accountDeletedStoreSubscriptionNotice(): string {
  const links = PURCHASE_STORES.map((store) => `${IAP_STORE_LABELS[store]}: ${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}`);
  return [STORE_SUBSCRIPTION_DELETION_NOTICE, ...links].join('\n');
}

/**
 * 退会の完了を本人に知らせるメール
 * subject: 「【ほめゴハン】退会が完了しました」
 *
 * 載せるのは退会の日時 (日本時間)・ストアの購読の注意と管理のページ・問い合わせ先だけ。アカウントの中身 (名前・記録) は載せない。
 */
export function renderAccountDeletedEmail(vars: AccountDeletedEmailVars): EmailEnvelope {
  return {
    template: 'account_deleted',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】退会が完了しました',
    text: `ほめゴハンをご利用いただきありがとうございました。

${formatAccountDeletedAt(vars.deleted_at)} (日本時間) に、このメールアドレスで登録されていたアカウントの退会が完了しました。
アカウントと記録は削除され、元に戻すことはできません。

${accountDeletedStoreSubscriptionNotice()}

心当たりが無い場合は、${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
