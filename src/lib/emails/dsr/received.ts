// src/lib/emails/dsr/received.ts
// #1178 個人情報の請求を受け付けたこと (本人確認が済んだこと) と、応答期限を本人へ知らせる。
// 本文に請求の内容 (details) は載せない (設計 cross/15 §10)。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom } from '@/lib/site-config';
import type { DsrRequestType } from '@/lib/data-subject-requests/core';
import { dsrSummaryLines, formatDsrDueDate } from './format';

export interface DsrReceivedEmailVars {
  /** 宛先 (請求した本人の auth.users の登録メールアドレス) */
  to_email: string;
  request_type: DsrRequestType;
  request_id: string;
  /** 応答期限 (data_subject_requests.due_at) */
  due_at: string | Date | null;
  /** 設定画面 (自分の請求の一覧) の絶対 URL */
  settings_url: string;
}

/**
 * subject: 「【ほめゴハン】個人情報の請求を受け付けました」
 * 載せるもの: 種類・受付番号・応答期限 (日本時間の日付)・設定画面のリンク
 */
export function renderDsrReceivedEmail(vars: DsrReceivedEmailVars): EmailEnvelope {
  return {
    template: 'dsr_received',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: '【ほめゴハン】個人情報の請求を受け付けました',
    text: `いつもほめゴハンをご利用いただきありがとうございます。

本人確認が済み、個人情報についての次の請求を受け付けました。

${dsrSummaryLines(vars.request_type, vars.request_id)}
応答の期限: ${formatDsrDueDate(vars.due_at)} (日本時間)

対応の状況と応答は、設定画面で確かめられます。
${vars.settings_url}

${emailSignature()}
`,
  };
}
