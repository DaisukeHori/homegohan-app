// src/lib/emails/membership/family-parental-consent-recorded.ts
// #1173: 保護者の同意を記録したことの控え (署名した本人宛)。生年月日・年齢・署名の氏名は載せない (メールは転送されうる)
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { emailSignature } from '@/lib/emails/common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';

export interface FamilyParentalConsentRecordedEmailVars {
  email_address: string; // 宛先 = 署名した本人 (ログイン中の利用者の auth.users.email)
  family_name: string; // 家族グループ名
  child_display_name: string; // 追加した子供の呼び名 (生年月日・年齢は載せない)
  consent_version: string; // PARENTAL_CONSENT_DOCUMENT.version
  signed_at: string; // ISO 文字列 (parental_consents.signed_at)
  document_url: string; // `${getSiteUrl()}${PARENTAL_CONSENT_DOCUMENT_PATH}` (route が作る)
  members_url: string; // buildFamilyMembersUrl() (route が作る)
}

/**
 * 保護者の同意を記録したことの控え (COPPA の「保護者への直接の通知」に当たるもの)。
 * subject: 「【ほめゴハン】保護者の同意を記録しました」
 */
export function renderFamilyParentalConsentRecordedEmail(vars: FamilyParentalConsentRecordedEmailVars): EmailEnvelope {
  const signedDate = new Date(vars.signed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  return {
    template: 'family_parental_consent_recorded',
    to: vars.email_address,
    from: getEmailFrom(),
    subject: '【ほめゴハン】保護者の同意を記録しました',
    text: `${vars.email_address} 様

家族グループ「${vars.family_name}」に「${vars.child_display_name}」さんを追加した際の、
保護者の同意を記録しました。

同意日時: ${signedDate}
同意書の版: ${vars.consent_version}

▼ 同意書の全文
${vars.document_url}

同意を取り消すには、家族のメンバー管理画面からお子さまを家族から外してください。
▼ メンバー管理画面
${vars.members_url}

心当たりがない場合は、すぐに ${getSupportEmail()} までご連絡ください。

${emailSignature()}
`,
  };
}
