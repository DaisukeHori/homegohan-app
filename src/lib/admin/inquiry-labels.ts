// src/lib/admin/inquiry-labels.ts
// 問い合わせ (inquiries) の対応の状態の、画面に出す日本語の名前 (#2112 Z3)。
//
// 値の一覧は src/lib/admin/inquiries.ts の INQUIRY_STATUSES (inquiries.status の CHECK と同じ 4 値)。あのファイルはサーバーの部品
// (next/server・Supabase の client) を import するのでブラウザの画面から読めない。そのため表示名はこのファイルに分け、
// キーの型を InquiryStatus (型だけの import) にして、値を足すと表示名の漏れが型の誤りになる形にする (USER_LIST_STATUS_LABELS と同じ形)。
// 以前、サポートの利用者の画面 (src/app/(support)/support/users/page.tsx) の問い合わせの履歴は、状態を英字の内部の値 (pending など) のまま出していた。
// 語は問い合わせの画面 (src/app/(support)/support/inquiries/page.tsx) の状態の選択肢と同じ。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import type { InquiryStatus } from '@/lib/admin/inquiries';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 問い合わせの対応の状態の表示名 */
export const INQUIRY_STATUS_LABELS: Readonly<Record<InquiryStatus, string>> = {
  pending: '未対応',
  in_progress: '対応中',
  resolved: '解決済',
  closed: '完了',
};

/** 問い合わせの対応の状態の表示名。表に無い値 (将来の値・壊れた応答) は、知らない値を隠さないようそのまま返す */
export function inquiryStatusLabel(value: string): string {
  return labelOrRaw(INQUIRY_STATUS_LABELS, value);
}
