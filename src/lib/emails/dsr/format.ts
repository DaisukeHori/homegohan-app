// src/lib/emails/dsr/format.ts
// #1178 個人情報の請求 (DSR) のメール 4 通で共通の書き方 (日時の表示・種類と受付番号の行)。
// 文面そのもの (render*Email) は verification.ts / received.ts / operator-notice.ts / resolved.ts。
import { DSR_REQUEST_TYPE_LABELS, shortDsrId, type DsrRequestType } from '@/lib/data-subject-requests/core';

/** 本文に書く日時のタイムゾーン (利用者は日本向け。本文にも「日本時間」と書く。account-deleted.ts と同じ) */
const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

/** 例: 2026年11月14日 (応答期限は日付で伝える) */
const DUE_DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** 期限が無い (本人確認の前の行が渡された) ときの表示。受付のあとのメールでは起きない */
const DUE_DATE_UNSET = '未定';

/** 応答期限 (due_at) を日本時間の日付「2026年11月14日」にする。null・日時として読めない値は「未定」 */
export function formatDsrDueDate(dueAt: string | Date | null): string {
  if (dueAt === null) return DUE_DATE_UNSET;
  const date = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(date.getTime())) return DUE_DATE_UNSET;
  return DUE_DATE_FORMAT.format(date);
}

/** 本文の「種類」「受付番号」の 2 行 */
export function dsrSummaryLines(requestType: DsrRequestType, requestId: string): string {
  return `種類: ${DSR_REQUEST_TYPE_LABELS[requestType]}
受付番号: #${shortDsrId(requestId)}`;
}
