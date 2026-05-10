// src/lib/emails/membership/family-invite-existing.ts
// (設計書 04-email-templates.md §4 テンプレート C: 家族招待 — 既存ユーザー向け)
import type { InviteEmailVars, EmailEnvelope } from './templates';

/**
 * 家族招待メール (既存ユーザー向け)
 * subject: 「【ほめゴハン】{family_name}に家族として招待されました」
 */
export function renderFamilyInviteExistingEmail(vars: InviteEmailVars): EmailEnvelope {
  const greeting = vars.display_name ?? vars.email_address;
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `【ほめゴハン】${vars.scope_name}に家族として招待されました`,
    text: `${greeting} 様

${vars.inviter_name} 様からほめゴハンの家族グループ「${vars.scope_name}」にあなたを招待しています。

家族グループに参加すると、献立や買い物リスト、栄養記録を共有できます。
過去の個人記録はあなただけが閲覧でき、新しい記録から家族との共有を選べます。
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
