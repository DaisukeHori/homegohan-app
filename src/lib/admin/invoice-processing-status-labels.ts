// src/lib/admin/invoice-processing-status-labels.ts
// 運営の画面で、請求書 (stripe_webhook_events の行) の処理の状態 (processing_status) を日本語の表示名で出すための表 (#2112 Z3)。
//
// 以前、請求書の詳細 (src/app/admin/finance/invoices/[id]/page.tsx) の見出しの札は、状態を英字の内部の値 (completed など) のまま出していた。
// 値の一覧は src/lib/admin/finance-schemas.ts の INVOICE_PROCESSING_STATUSES (DB の CHECK と同じ 4 値)。
// finance-schemas は zod とサーバー向けの部品を読むので、クライアントの画面から値を import しないよう、表は型だけを読んでここに置く
// (subscription-status-labels.ts と同じ形)。キーの型を InvoiceProcessingStatus にして、値を足すと表示名の漏れが型の誤りになる。

import type { InvoiceProcessingStatus } from '@/lib/admin/finance-schemas';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 請求書の処理の状態の、運営の画面の表示名 */
export const INVOICE_PROCESSING_STATUS_LABELS: Readonly<Record<InvoiceProcessingStatus, string>> = {
  pending: '未処理',
  processing: '処理中',
  completed: '処理済み',
  failed: '失敗',
};

/** 請求書の処理の状態の表示名。表に無い値 (将来の値・壊れた応答) はそのまま */
export function invoiceProcessingStatusLabel(status: string): string {
  return labelOrRaw(INVOICE_PROCESSING_STATUS_LABELS, status);
}
