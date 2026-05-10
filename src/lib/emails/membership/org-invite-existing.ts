// src/lib/emails/membership/org-invite-existing.ts
// (設計書 04-email-templates.md §2)
import type { InviteEmailVars } from './templates';
import type { EmailEnvelope } from '@/lib/emails/send';

export function renderOrgInviteExistingEmail(vars: InviteEmailVars): EmailEnvelope {
  const greeting = vars.display_name ?? vars.email_address;
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.scope_name} からメンバー招待が届きました`,
    text: `${greeting} 様

${vars.scope_name} の ${vars.inviter_name} 様から、ほめゴハンの組織メンバーとして招待が届きました。
${customSection}
▼ 招待を承諾する
${vars.invite_url}

このリンクは ${vars.expires_at} まで有効です。
期限切れの場合は、招待者に再送を依頼してください。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
