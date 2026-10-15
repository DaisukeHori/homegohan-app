// src/lib/emails/dsr/operator-notice.ts
// #1178 個人情報の請求を受け付けた (本人確認が済んだ) ことを運営 (ADMIN_NOTIFICATION_EMAIL) へ知らせる。
// 請求者の情報 (user_id・ニックネーム・メールアドレス・請求の内容) は入れない。運営画面で、監査つきで見る (設計 cross/15 §10・§11)。
import type { EmailEnvelope } from '../envelope';
import { emailSignature } from '../common';
import { getEmailFrom } from '@/lib/site-config';
import { DSR_REQUEST_TYPE_LABELS, type DsrRequestType } from '@/lib/data-subject-requests/core';
import { dsrSummaryLines, formatDsrDueDate } from './format';

export interface DsrOperatorNoticeEmailVars {
  /** 宛先 (環境変数 ADMIN_NOTIFICATION_EMAIL) */
  to_email: string;
  request_type: DsrRequestType;
  request_id: string;
  /** 応答期限 (data_subject_requests.due_at) */
  due_at: string | Date | null;
  /** 運営画面の請求の詳細の絶対 URL (`${siteUrl}${DSR_ADMIN_PATH}/${id}`) */
  admin_url: string;
}

/**
 * subject: 「【運営】個人情報の請求 (種類) を受け付けました」
 * 載せるもの: 種類・受付番号・期限・運営画面のリンク
 */
export function renderDsrOperatorNoticeEmail(vars: DsrOperatorNoticeEmailVars): EmailEnvelope {
  return {
    template: 'dsr_operator_notice',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【運営】個人情報の請求 (${DSR_REQUEST_TYPE_LABELS[vars.request_type]}) を受け付けました`,
    text: `個人情報の請求を受け付けました (本人確認済み)。応答の期限までに対応してください。

${dsrSummaryLines(vars.request_type, vars.request_id)}
応答の期限: ${formatDsrDueDate(vars.due_at)} (日本時間)

運営画面:
${vars.admin_url}

${emailSignature()}
`,
  };
}
