/**
 * 運営強制解散 通知メールテンプレート
 * docs/design/membership/05-operator-emergency-ui.md §8 準拠
 */

import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';

export type ForceDissolveEmailVars = {
  recipient_email: string;
  recipient_name?: string | null;
  scope: 'organization' | 'family';
  scope_name: string;
  reason: string;
};

/**
 * 強制解散 通知メールを構築する。
 */
export function renderForceDissolveEmail(vars: ForceDissolveEmailVars): EmailEnvelope {
  const scopeLabel = vars.scope === 'organization' ? '組織' : '家族グループ';
  const greeting = vars.recipient_name ?? vars.recipient_email;

  const body = `${greeting} 様

ほめゴハン運営事務局よりご連絡いたします。

あなたが所属していた${scopeLabel}「${vars.scope_name}」が、運営側の判断により解散されました。

▼ 解散理由
${vars.reason}

メンバーシップは自動的に解除されています。
今後も引き続きほめゴハンを個人でご利用いただけます。

ご不明な点がございましたら ${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`;

  const subjectScope = vars.scope === 'organization' ? '組織' : '家族グループ';
  return {
    template: 'operator_force_dissolve',
    to: vars.recipient_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン】運営により${subjectScope}「${vars.scope_name}」が解散されました`,
    text: body,
  };
}
