// src/lib/emails/account/login-locked.ts
// ログインに続けて失敗したため、しばらくログインを止めたことを本人に知らせるメール (#1165)。
// 送るのは、設計 docs/design/cross/01-auth-session.md §8 の「10 回 → 1 時間ロック + 本人へメール」に届いた 1 回だけ
// (src/lib/auth/login-lock-notification.ts)。
// 本人が気づかないうちに、誰かがパスワードを試し続けている可能性を知らせ、パスワードの再設定へ案内するのが目的。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSiteUrl, getSupportEmail } from '@/lib/site-config';

/** 本文に書く日時のタイムゾーン (利用者は日本向け。本文にも「日本時間」と書く) */
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

/** 例: 2026年10月10日 13:05 */
const LOCKED_UNTIL_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** パスワードの再設定の画面 (src/app/(auth)/auth/forgot-password) */
export const FORGOT_PASSWORD_PATH = '/auth/forgot-password';

export interface LoginLockedEmailVars {
  /** 宛先 (ロックしたアカウントの、auth.users の登録メールアドレス) */
  to_email: string;
  /** 続けて失敗した回数 */
  failure_count: number;
  /** ロックが外れる日時 */
  locked_until: Date;
}

/**
 * ログインを一時的に止めたことを本人に知らせるメール
 * subject: 「【ほめゴハン】ログインを一時的に止めました」
 *
 * 載せるのは回数・ロックが外れる日時 (日本時間)・パスワードの再設定の案内・問い合わせ先だけ。
 * 試した側の情報 (IP アドレスなど) は載せない。
 */
export function renderLoginLockedEmail(vars: LoginLockedEmailVars): EmailEnvelope {
  return {
    template: 'login_locked',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】ログインを一時的に止めました',
    text: `このメールアドレスで登録されているアカウントへのログインに、${vars.failure_count} 回続けて失敗しました。
アカウントを守るため、${LOCKED_UNTIL_FORMAT.format(vars.locked_until)} (日本時間) まで、ログインを止めています。
この間は、正しいパスワードを入れてもログインできません。

ご自身で試したのでなければ、ほかの誰かがパスワードを試している可能性があります。
次のページからパスワードを再設定してください。再設定すると、すぐにログインできるようになります。
${getSiteUrl()}${FORGOT_PASSWORD_PATH}

心当たりが無く、ご不明な点があれば、${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
