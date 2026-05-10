// src/lib/emails/membership/family-invite-new.ts
// (設計書 04-email-templates.md §4 テンプレート C: 家族招待 — 新規ユーザー向け)
import type { InviteEmailVars, EmailEnvelope } from './templates';

/**
 * 家族招待メール (新規ユーザー向け)
 * subject: 「【ほめゴハン】{family_name}に家族として招待されました — アカウントを作成して参加」
 */
export function renderFamilyInviteNewEmail(vars: InviteEmailVars): EmailEnvelope {
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `【ほめゴハン】${vars.scope_name}に家族として招待されました — アカウントを作成して参加`,
    text: `${vars.email_address} 様

${vars.inviter_name} 様からほめゴハンの家族グループ「${vars.scope_name}」にあなたを招待しています。

ほめゴハンは、栄養管理と健康記録をサポートするサービスです。
下記リンクからアカウントを作成して、家族グループのメンバーとして参加できます。

家族グループに参加すると、献立や買い物リスト、栄養記録を家族と共有できます。
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
