// src/lib/emails/membership/member-left.ts
// (設計書 04-email-templates.md §6.2 — メンバーが自分で脱退したときの、家族グループの代表者 / 組織のオーナーへの通知メール、#1160)
import type { EmailEnvelope } from './templates';
import {
  describeScope,
  describeScopeForSubject,
  membershipScopeLabel,
  type MembershipScope,
} from './scope-label';

export interface MemberLeftEmailVars {
  /** 宛先 (家族グループの代表者 / 組織のオーナーの登録メールアドレス) */
  to_email: string;
  scope: MembershipScope;
  /** 家族グループ名 / 組織名。読めなかったときは null (名前を省いた文面にする) */
  scope_name: string | null;
  /** メンバー管理画面の絶対 URL */
  members_url: string;
}

/**
 * メンバーが自分で脱退したことを、家族グループの代表者 / 組織のオーナーに知らせるメール
 * subject: 「【ほめゴハン】家族グループ「山田家」からメンバーが脱退しました」
 *
 * 載せるのは所属先の名前と、何が起きたかだけ。脱退した人の名前などの個人情報は載せない
 * (誰がいなくなったかは、メンバー管理画面で確認できる)。
 */
export function renderMemberLeftEmail(vars: MemberLeftEmailVars): EmailEnvelope {
  const recipientRole = vars.scope === 'organization' ? 'オーナー' : '代表者';

  return {
    to: vars.to_email,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `【ほめゴハン】${describeScopeForSubject(vars.scope, vars.scope_name)}からメンバーが脱退しました`,
    text: `ほめゴハンをご利用いただきありがとうございます。

${describeScope(vars.scope, vars.scope_name)}のメンバーが 1 人、ご本人の操作で脱退しました。
このメールは、${membershipScopeLabel(vars.scope)}の${recipientRole}にお送りしています。

現在のメンバーは、メンバー管理画面で確認できます。
${vars.members_url}

ご不明な点がございましたら support@homegohan.app までお問い合わせください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
