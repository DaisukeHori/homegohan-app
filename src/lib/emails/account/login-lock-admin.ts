// src/lib/emails/account/login-lock-admin.ts
// ログインに 20 回続けて失敗したアカウントを、運営へ知らせるメール (#1165)。
// 設計 docs/design/cross/01-auth-session.md §8 の「20 回 → 24 時間ロック + 管理者へ通知」に届いた 1 回だけ送る
// (src/lib/auth/login-lock-notification.ts)。宛先は ADMIN_NOTIFICATION_EMAIL (運営の固定アドレス)。
// メールアドレスそのものは載せない (伏せた形と user_id だけ)。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom } from '@/lib/site-config';

const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

const LOCKED_UNTIL_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export interface LoginLockAdminEmailVars {
  /** 宛先 (ADMIN_NOTIFICATION_EMAIL) */
  to_email: string;
  /** ロックしたアカウントの user_id。アカウントが無いメールアドレスなら null */
  user_id: string | null;
  /** 伏せたメールアドレス (例: t***@example.com) */
  masked_email: string;
  /** 続けて失敗した回数 */
  failure_count: number;
  /** ロックが外れる日時 */
  locked_until: Date;
}

/**
 * 運営への通知
 * subject: 「[ほめゴハン] ログインの連続失敗で 24 時間ロックしました」
 */
export function renderLoginLockAdminEmail(vars: LoginLockAdminEmailVars): EmailEnvelope {
  const account = vars.user_id ? `user_id: ${vars.user_id}` : 'アカウント: 登録されていないメールアドレス';
  return {
    template: 'login_lock_admin',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '[ほめゴハン] ログインの連続失敗で 24 時間ロックしました',
    text: `ログインに ${vars.failure_count} 回続けて失敗したメールアドレスを、${LOCKED_UNTIL_FORMAT.format(vars.locked_until)} (日本時間) までロックしました。

${account}
メールアドレス (伏せ字): ${vars.masked_email}

パスワードを試し続ける攻撃の可能性があります。同じ時間帯に、ほかのアカウントでも続いていないかを確かめてください。
ロックは、本人がパスワードを再設定すると外れます。

${emailSignature()}
`,
  };
}
