// src/lib/emails/membership/family-promote.ts
// #1232: 「アカウント発行通知」から「家族グループ参加の本人同意依頼」へ書換え。
// 書式は family-transfer-proposed.ts (accept_url + 依頼元名) に合わせる。
import type { EmailEnvelope } from './templates';

export interface FamilyPromoteEmailVars {
  email_address: string; // 宛先 (対象者本人)
  family_name: string; // 家族グループ名
  member_display_name: string; // 紐付け先の子供メンバー表示名
  requester_name: string; // 依頼者 (rep/adult) の表示名
  accept_url: string; // token を含む承認ページ URL
  expires_at: string; // ISO 文字列
}

/**
 * 家族グループ参加 (子供メンバー枠への紐付け) の本人同意依頼メール
 * subject: 「【ほめゴハン】家族グループへの参加確認のお願い」
 */
export function renderFamilyPromoteEmail(vars: FamilyPromoteEmailVars): EmailEnvelope {
  // サーバー (UTC) のタイムゾーンで日付にすると日本時間と 1 日ずれることがあるため、日本時間で表す
  const expiresDate = new Date(vars.expires_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: '【ほめゴハン】家族グループへの参加確認のお願い',
    text: `${vars.email_address} 様

${vars.requester_name} さんが、あなたを家族グループ「${vars.family_name}」の
メンバー「${vars.member_display_name}」として登録しようとしています。

参加を承認する場合のみ、下記リンクから内容をご確認ください。
あなたが承認するまで、家族グループへの追加や、あなたの食事記録などの
共有は一切行われません。

▼ 内容を確認して承認 / 拒否する
${vars.accept_url}

このリンクは ${expiresDate} まで有効です。
心当たりがない場合は、このメールを無視してください(何も起こりません)。
不審に感じた場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
