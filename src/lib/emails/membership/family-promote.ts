// src/lib/emails/membership/family-promote.ts
// (設計書 02-flow-spec.md §9 — 子供 promote メール)
import type { EmailEnvelope } from './templates';

export interface FamilyPromoteEmailVars {
  email_address: string;
  child_name: string;
}

/**
 * 子供メンバーのアカウント発行通知メール
 * subject: 「【ほめゴハン】アカウントが発行されました」
 */
export function renderFamilyPromoteEmail(vars: FamilyPromoteEmailVars): EmailEnvelope {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://homegohan.app';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: '【ほめゴハン】アカウントが発行されました',
    text: `${vars.email_address} 様

ほめゴハンのアカウントが発行されました。

「${vars.child_name}」として家族グループに参加されています。
以下のリンクからパスワードを設定してほめゴハンをご利用ください。

▼ ほめゴハンにログイン
${baseUrl}/login

これまでの食事記録は引き続きご確認いただけます。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
