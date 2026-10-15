// src/lib/emails/dsr/resolved.ts
// #1178 個人情報の請求への対応が終わった (対応済み / 対応できず) ことを本人へ知らせる。
// 応答 (response_note) と請求の内容 (details) は本文に載せない。本人は設定画面で応答を読む (設計 cross/15 §10)。
// 請求の後に凍結された本人は設定画面に入れないので、問い合わせ先も書く (S-13)。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom, getSupportEmail } from '@/lib/site-config';
import { DSR_STATUS_LABELS, type DsrRequestType } from '@/lib/data-subject-requests/core';
import { dsrSummaryLines } from './format';

export interface DsrResolvedEmailVars {
  /** 宛先 (請求した本人の auth.users の登録メールアドレス) */
  to_email: string;
  request_type: DsrRequestType;
  request_id: string;
  /** 結果 (対応済み / 対応できず) */
  status: 'fulfilled' | 'rejected';
  /** 設定画面 (自分の請求の一覧) の絶対 URL */
  settings_url: string;
}

/**
 * subject: 「【ほめゴハン】個人情報の請求への対応が完了しました」
 * 載せるもの: 種類・受付番号・結果・設定画面で応答を読む案内・設定画面を開けないときの問い合わせ先
 */
export function renderDsrResolvedEmail(vars: DsrResolvedEmailVars): EmailEnvelope {
  return {
    template: 'dsr_resolved',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】個人情報の請求への対応が完了しました',
    text: `いつもほめゴハンをご利用いただきありがとうございます。

個人情報についての次の請求への対応が完了しました。

${dsrSummaryLines(vars.request_type, vars.request_id)}
結果: ${DSR_STATUS_LABELS[vars.status]}

応答の内容は、設定画面でご確認ください。
${vars.settings_url}

設定画面を開けない場合は、${getSupportEmail()} までお問い合わせください。

${emailSignature()}
`,
  };
}
