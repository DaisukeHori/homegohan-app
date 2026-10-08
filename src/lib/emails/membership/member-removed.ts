// src/lib/emails/membership/member-removed.ts
// (設計書 04-email-templates.md §6.1 — 家族グループ / 組織から外されたメンバー本人への通知メール、#1160)
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';
import {
  describeScope,
  describeScopeForSubject,
  membershipScopeLabel,
  type MembershipScope,
} from './scope-label';

export interface MemberRemovedEmailVars {
  /** 宛先 (外された本人の登録メールアドレス) */
  to_email: string;
  scope: MembershipScope;
  /** 家族グループ名 / 組織名。読めなかったときは null (名前を省いた文面にする) */
  scope_name: string | null;
}

/**
 * 家族グループ / 組織から外されたメンバー本人への通知メール
 * subject: 「【ほめゴハン】家族グループ「山田家」から外されました」
 *
 * 載せるのは所属先の名前と、何が起きたか (と、本人のアカウントへの影響) だけ。
 * 外した人や、ほかのメンバーなど、本人以外の個人情報は載せない。
 */
export function renderMemberRemovedEmail(vars: MemberRemovedEmailVars): EmailEnvelope {
  const label = membershipScopeLabel(vars.scope);

  return {
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン】${describeScopeForSubject(vars.scope, vars.scope_name)}から外されました`,
    text: `ほめゴハンをご利用いただきありがとうございます。

${describeScope(vars.scope, vars.scope_name)}のメンバーから外されました。

あなたのほめゴハンの個人アカウントは、引き続きご利用いただけます。
${label}で記録した個人データも、あなたのアカウントに残ります。

心当たりがない場合や、ご不明な点がございましたら ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
