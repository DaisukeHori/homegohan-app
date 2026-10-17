// src/lib/emails/account/login-new-device.ts
// 新しい端末・地域からのログインを本人に知らせるメール (#1190)。設計の正典 docs/design/cross/16-auth-history-sessions.md §18。
// 送るのは不審なログインの通知の worker (src/lib/auth/sessions/login-alert-worker.ts の createLoginAlertWorkerDeps の send) だけ。
// sendEmail は送信待ち (email_outbox) に登録して返り、届けるのは GET /api/cron/email-outbox の worker。
// 文面は秘密 (受け取った人だけが使えるトークンを含むリンク #1708) を含まないので contains_secret を書かない (false も書かない)。
// 本文に入る利用者の値は、UA から決まる端末の言葉・IP・国だけ (生の UA・session_id・端末名・メールアドレスは入れない §7.1)。
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { emailSignature } from '@/lib/emails/common';
import { getEmailFrom, getSiteUrl, getSupportEmail } from '@/lib/site-config';

/** 本文に書く日時のタイムゾーン (利用者は日本向け。本文にも「日本時間」と書く) */
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';
/** 例: 2026年10月15日 10:00 */
const LOGGED_IN_AT_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** 見覚えの無い端末をログアウトさせる画面 (Web の /settings/security/sessions) */
export const SESSIONS_SETTINGS_PATH = '/settings/security/sessions';
/** パスワードを変える画面 */
export const ACCOUNT_SETTINGS_PATH = '/settings/account';

export interface LoginNewDeviceEmailVars {
  to_email: string;
  logged_in_at: Date;
  /** deviceLabelOf(deviceFamilyOf(user_agent)) (決まった言葉だけ)。利用者が書ける device_name は入れない (§7.1・§13.4) */
  device_label: string;
  /** user_sessions_metadata.ip_address (完全な IP。一覧 §14.1 と同じ値。範囲 ip_network ではない) */
  ip_address: string | null;
  country_code: string | null;
}

/**
 * 新しい端末・地域からのログインの通知
 * subject: 「【ほめゴハン】新しい端末からのログインがありました」
 */
export function renderLoginNewDeviceEmail(vars: LoginNewDeviceEmailVars): EmailEnvelope {
  const where = [vars.ip_address ? `IP アドレス: ${vars.ip_address}` : null, vars.country_code ? `国: ${vars.country_code}` : null]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    template: 'login_new_device',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】新しい端末からのログインがありました',
    text: `${LOGGED_IN_AT_FORMAT.format(vars.logged_in_at)} (日本時間) に、これまでと違う端末または地域から、このメールアドレスのアカウントへのログインがありました。

端末: ${vars.device_label}
${where}

ご自身の操作であれば、このメールは無視してください。

心当たりが無い場合は、すぐに次の対応をお願いします。
1. パスワードを変更する: ${getSiteUrl()}${ACCOUNT_SETTINGS_PATH}
2. 見覚えの無い端末をログアウトさせる: ${getSiteUrl()}${SESSIONS_SETTINGS_PATH}
3. 解決しないときは ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
