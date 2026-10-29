// src/lib/admin/moderation-labels.ts
// 運営の審査の画面 (/admin/moderation の一覧・/admin/moderation/{type}/{id} の詳細と審査の欄) で、
// 通報の状態 (moderation_flags.status / recipe_flags.status) と種類 (type) を、画面に出す日本語の名前にする (#2080 U6)。
//
// 以前、審査の欄は審査済みのアイテムの状態を「ステータス: rejected」と内部の英字の値のまま出していた。一覧のステータスの列・件数の見出し、
// 詳細の「ステータス」の項目、タイプの札 (food / recipe) も内部の値のままだった。対応表をここに 1 つにまとめ、どの画面も同じ語を出す。
// 状態は pending / approved / rejected / escalated の 4 つ (src/lib/admin/moderation-schemas.ts の一覧の絞り込みの z.enum と、
// src/app/api/admin/moderation/[type]/[id]/route.ts の審査の確定が書く値)。種類は MODERATION_TYPES (同じファイル)。
// 語は一覧の絞り込みの選択肢 (src/app/admin/moderation/page.tsx) と同じにする。
// 表に無い値 (将来の値・壊れた応答) は、内部の値を画面に出さず固定の文を出す (src/lib/membership/role-labels.ts と同じ考え方)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

import type { ModerationType } from '@/lib/admin/moderation-schemas';

/** 通報の状態の表示名 */
export const MODERATION_STATUS_LABELS = {
  pending: '未審査',
  approved: '承認済み',
  rejected: '却下済み',
  escalated: 'エスカレーション',
} as const;

/** 表に無い状態に出す固定の文 (内部の英字の値は出さない) */
export const MODERATION_STATUS_UNKNOWN_LABEL = '不明な状態';

/** 通報の種類の表示名 */
export const MODERATION_TYPE_LABELS: Record<ModerationType, string> = {
  food: '食事画像',
  recipe: 'レシピ',
  ai_content: 'AI コンテンツ',
};

/** 表に無い種類に出す固定の文 (内部の英字の値は出さない) */
export const MODERATION_TYPE_UNKNOWN_LABEL = '不明な種類';

function lookup(table: Readonly<Record<string, string>>, value: string | null | undefined, unknown: string): string {
  if (value != null && Object.prototype.hasOwnProperty.call(table, value)) return table[value];
  return unknown;
}

/** 通報の状態 (pending / approved / rejected / escalated) の表示名。表に無い値・null は MODERATION_STATUS_UNKNOWN_LABEL */
export function moderationStatusLabel(status: string | null | undefined): string {
  return lookup(MODERATION_STATUS_LABELS, status, MODERATION_STATUS_UNKNOWN_LABEL);
}

/** 通報の種類 (food / recipe / ai_content) の表示名。表に無い値・null は MODERATION_TYPE_UNKNOWN_LABEL */
export function moderationTypeLabel(type: string | null | undefined): string {
  return lookup(MODERATION_TYPE_LABELS, type, MODERATION_TYPE_UNKNOWN_LABEL);
}
