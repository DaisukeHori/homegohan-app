/**
 * 運営強制譲渡 通知メールテンプレート
 * docs/design/membership/05-operator-emergency-ui.md §8 準拠
 */

import type { EmailEnvelope } from './templates';

export type ForceTransferEmailVars = {
  recipient_email: string;
  recipient_name?: string | null;
  scope: 'organization' | 'family';
  scope_name: string;
  old_owner_email: string;
  new_owner_email: string;
  reason: string;
  /** 受信者の立場 */
  recipient_role: 'old_owner' | 'new_owner' | 'member';
};

/**
 * 強制譲渡 通知メールを構築する。
 * 旧 owner / 新 owner / 一般メンバで本文を切り替える。
 */
export function renderForceTransferEmail(vars: ForceTransferEmailVars): EmailEnvelope {
  const scopeLabel = vars.scope === 'organization' ? '組織' : '家族グループ';
  const greeting = vars.recipient_name ?? vars.recipient_email;

  let body: string;
  switch (vars.recipient_role) {
    case 'old_owner':
      body = `${greeting} 様

ほめゴハン運営事務局よりご連絡いたします。

あなたが管理していた${scopeLabel}「${vars.scope_name}」のオーナー権限が、以下の理由により運営側で移譲されました。

▼ 移譲先
${vars.new_owner_email}

▼ 移譲理由
${vars.reason}

ご不明な点がございましたら support@homegohan.app までお問い合わせください。

─────────────────
ほめゴハン
https://homegohan.app
`;
      break;

    case 'new_owner':
      body = `${greeting} 様

ほめゴハン運営事務局よりご連絡いたします。

${scopeLabel}「${vars.scope_name}」のオーナー権限が、運営側の判断により以下の通りあなたに移譲されました。

▼ 旧オーナー
${vars.old_owner_email}

▼ 移譲理由
${vars.reason}

${scopeLabel}の管理をよろしくお願いいたします。
ご不明な点がございましたら support@homegohan.app までお問い合わせください。

─────────────────
ほめゴハン
https://homegohan.app
`;
      break;

    default:
      body = `${greeting} 様

ほめゴハン運営事務局よりご連絡いたします。

あなたが所属する${scopeLabel}「${vars.scope_name}」のオーナーが、運営側の判断により変更されました。

▼ 新オーナー
${vars.new_owner_email}

▼ 変更理由
${vars.reason}

ご不明な点がございましたら support@homegohan.app までお問い合わせください。

─────────────────
ほめゴハン
https://homegohan.app
`;
  }

  const subjectScope = vars.scope === 'organization' ? '組織' : '家族グループ';
  return {
    to: vars.recipient_email,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `【ほめゴハン】運営により${subjectScope}の所有権が移譲されました`,
    text: body,
  };
}
