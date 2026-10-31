/**
 * サポートチケット API スキーマ
 * operator/02-api-spec.md §10 準拠
 */
import { z } from 'zod';
import { labelOrRaw } from '@/lib/admin/value-labels';

// ─── 値の一覧と画面の表示名 ─────────────────────────────────────────────────────
// 表示名は Record<値, string> で持ち、値を足すと表示名の漏れが型の誤りになる (#2112 Z3。USER_LIST_STATUS_LABELS と同じ形)。
// 以前は一覧 (src/app/admin/support/page.tsx) だけが表示名を持ち、詳細 (src/app/admin/support/[id]/page.tsx) は
// 優先度・カテゴリを英字の内部の値 (high・billing など) のまま出していた。表に無い値 (将来の値・壊れた応答) は labelOrRaw でそのまま出す。
// このファイルはブラウザからも読む (zod と、何も import しない value-labels だけを import する)

/** チケットの状態 (support_tickets.status) */
export const TICKET_STATUSES = ['open', 'in_progress', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** チケットの優先度 (support_tickets.priority) */
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** チケットのカテゴリ (support_tickets.category) */
export const TICKET_CATEGORIES = ['account', 'billing', 'feature', 'bug', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** 状態の表示名 */
export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, string>> = {
  open: '未対応',
  in_progress: '対応中',
  pending: '保留',
  resolved: '解決済',
  closed: 'クローズ',
};

/** 優先度の表示名 */
export const TICKET_PRIORITY_LABELS: Readonly<Record<TicketPriority, string>> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '緊急',
};

/** カテゴリの表示名 (チケットの作成の画面の選択肢と同じ語) */
export const TICKET_CATEGORY_LABELS: Readonly<Record<TicketCategory, string>> = {
  account: 'アカウント',
  billing: '課金',
  feature: '機能リクエスト',
  bug: 'バグ',
  other: 'その他',
};

/** チケットの状態の表示名 (表に無い値はそのまま) */
export function ticketStatusLabel(value: string): string {
  return labelOrRaw(TICKET_STATUS_LABELS, value);
}

/** チケットの優先度の表示名 (表に無い値はそのまま) */
export function ticketPriorityLabel(value: string): string {
  return labelOrRaw(TICKET_PRIORITY_LABELS, value);
}

/** チケットのカテゴリの表示名 (表に無い値はそのまま) */
export function ticketCategoryLabel(value: string): string {
  return labelOrRaw(TICKET_CATEGORY_LABELS, value);
}

// ─── チケット一覧クエリ ────────────────────────────────────────────────────────
export const ticketListQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assignee_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

// ─── チケット作成 ─────────────────────────────────────────────────────────────
export const createTicketSchema = z.object({
  user_id: z.string().uuid({ message: '利用者の ID (user_id) は UUID 形式で指定してください' }),
  subject: z
    .string()
    .min(1, '件名は必須です')
    .max(200, '件名は200文字以内です'),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).default('medium'),
  body: z.string().min(1, '本文は必須です'),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// ─── チケット更新 ─────────────────────────────────────────────────────────────
export const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: '変更するフィールドを1つ以上指定してください',
  });

export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

// ─── 担当者割り当て ───────────────────────────────────────────────────────────
export const assignTicketSchema = z.object({
  assignee_id: z.string().uuid({ message: '担当者の ID (assignee_id) は UUID 形式で指定してください' }),
});

export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

// ─── メッセージ作成 ───────────────────────────────────────────────────────────
export const createMessageSchema = z.object({
  // 前後の空白を除いてから検査する。空白だけの本文は、顧客向けの返信としてメールに載せても空欄になるため受け付けない (#1183)
  body: z.string().trim().min(1, 'メッセージ本文は必須です'),
  is_internal: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        name: z.string(),
        content_type: z.string().optional(),
      }),
    )
    .default([]),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
