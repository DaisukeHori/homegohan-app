// src/lib/emails/membership/family-transfer-completed.ts
// (設計書 04-email-templates.md — 家族代表者変更完了メール)
import type { EmailEnvelope } from './templates';

export interface FamilyTransferCompletedEmailVars {
  to_email: string;
  new_representative_name: string;
  family_name: string;
  is_old_representative: boolean;
}

/**
 * 家族代表者変更完了メール
 * subject: 「【ほめゴハン】家族代表者が変更されました」
 */
export function renderFamilyTransferCompletedEmail(vars: FamilyTransferCompletedEmailVars): EmailEnvelope {
  const bodyText = vars.is_old_representative
    ? `「${vars.family_name}」の代表者を ${vars.new_representative_name} 様に譲渡しました。

今後は ${vars.new_representative_name} 様が家族グループの管理を担当します。
あなたは引き続き家族グループのメンバーとしてほめゴハンをご利用いただけます。`
    : `「${vars.family_name}」の代表者が ${vars.new_representative_name} 様に変更されました。

あなたは新しい代表者として家族グループの管理ができるようになりました。`;

  return {
    to: vars.to_email,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: '【ほめゴハン】家族代表者が変更されました',
    text: `ほめゴハンをご利用いただきありがとうございます。

${bodyText}

ご不明な点がございましたら support@homegohan.app までお問い合わせください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
