// src/lib/emails/membership/org-invite-new.ts
// (設計書 04-email-templates.md §3)
import type { InviteEmailVars } from './templates';
import type { EmailEnvelope } from '@/lib/emails/send';

export function renderOrgInviteNewEmail(vars: InviteEmailVars): EmailEnvelope {
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.scope_name} があなたを招待しています — アカウントを作成して参加`,
    text: `${vars.email_address} 様

${vars.scope_name} の ${vars.inviter_name} 様からほめゴハンへのご招待が届きました。

ほめゴハンは、栄養管理と健康記録をサポートするサービスです。
下記リンクからアカウントを作成して、組織メンバーとして参加できます。
${customSection}
▼ アカウントを作成して招待を承諾する
${vars.invite_url}

このリンクは ${vars.expires_at} まで有効です。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
