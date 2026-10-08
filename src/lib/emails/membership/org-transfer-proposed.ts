// src/lib/emails/membership/org-transfer-proposed.ts
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';

export interface OrgTransferProposedVars {
  to_email: string;
  to_name: string | null;
  from_name: string;
  org_name: string;
  accept_url: string;
  expires_at: string; // 'YYYY-MM-DD'
  reason?: string | null;
}

export function renderOrgTransferProposedEmail(vars: OrgTransferProposedVars): EmailEnvelope {
  const greeting = vars.to_name ?? vars.to_email;
  const reasonSection = vars.reason
    ? `\n理由:\n「${vars.reason}」\n`
    : '';

  return {
    template: 'org_transfer_proposed',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン】組織オーナー譲渡の提案を受信しました`,
    text: `${greeting} 様

${vars.from_name} 様から、「${vars.org_name}」のオーナー権限の譲渡提案が届いています。
${reasonSection}
▼ 譲渡を承諾する
${vars.accept_url}

このリンクは ${vars.expires_at} まで有効です。
承諾しない場合、この提案は自動的に期限切れとなります。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は ${getSupportEmail()} までご連絡ください。

${emailSignature()}
`,
  };
}
