// src/lib/emails/membership/org-transfer-completed.ts
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom } from '@/lib/site-config';

export type TransferCompletedRecipient = 'old_owner' | 'new_owner' | 'member';

export interface OrgTransferCompletedVars {
  to_email: string;
  to_name: string | null;
  old_owner_name: string;
  new_owner_name: string;
  org_name: string;
  recipient: TransferCompletedRecipient;
}

export function renderOrgTransferCompletedEmail(vars: OrgTransferCompletedVars): EmailEnvelope {
  const greeting = vars.to_name ?? vars.to_email;

  let body: string;
  switch (vars.recipient) {
    case 'old_owner':
      body = `あなたは「${vars.org_name}」のオーナー権限を ${vars.new_owner_name} 様に譲渡しました。\nあなたの役割は管理者に変更されています。`;
      break;
    case 'new_owner':
      body = `あなたは「${vars.org_name}」の新しいオーナーになりました。\n旧オーナー: ${vars.old_owner_name} 様`;
      break;
    default:
      body = `「${vars.org_name}」のオーナーが変更されました。\n旧オーナー: ${vars.old_owner_name} 様\n新オーナー: ${vars.new_owner_name} 様`;
  }

  return {
    template: 'org_transfer_completed',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン】組織オーナーが変更されました`,
    text: `${greeting} 様

${body}

ほめゴハンをご利用いただきありがとうございます。

${emailSignature()}
`,
  };
}
