// src/lib/emails/membership/family-transfer-proposed.ts
// (設計書 04-email-templates.md — 家族代表者譲渡提案メール)
import type { EmailEnvelope } from './templates';

export interface FamilyTransferProposedEmailVars {
  to_email: string;
  from_name: string;
  family_name: string;
  accept_url: string;
  reason?: string;
}

/**
 * 家族代表者譲渡提案メール
 * subject: 「【ほめゴハン】家族代表者譲渡の提案」
 */
export function renderFamilyTransferProposedEmail(vars: FamilyTransferProposedEmailVars): EmailEnvelope {
  const reasonSection = vars.reason
    ? `\n理由:\n「${vars.reason}」\n`
    : '';

  return {
    to: vars.to_email,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: '【ほめゴハン】家族代表者譲渡の提案',
    text: `ほめゴハンをご利用いただきありがとうございます。

「${vars.family_name}」の現在の代表者 ${vars.from_name} 様から、あなたに代表者を譲渡したいというご提案があります。
${reasonSection}
代表者になると、家族グループの管理（メンバーの追加・除名など）ができるようになります。

▼ 提案を確認する
${vars.accept_url}

このリンクから承諾または拒否を選択できます。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
