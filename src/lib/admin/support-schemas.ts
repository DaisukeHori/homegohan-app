/**
 * サポートチケット API スキーマ
 * operator/02-api-spec.md §10 準拠
 */
import { z } from 'zod';

// ─── チケット一覧クエリ ────────────────────────────────────────────────────────
export const ticketListQuerySchema = z.object({
  status: z
    .enum(['open', 'in_progress', 'pending', 'resolved', 'closed'])
    .optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assignee_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

// ─── チケット作成 ─────────────────────────────────────────────────────────────
export const createTicketSchema = z.object({
  user_id: z.string().uuid({ message: 'user_id は UUID 形式で指定してください' }),
  subject: z
    .string()
    .min(1, '件名は必須です')
    .max(200, '件名は200文字以内です'),
  category: z.enum(['account', 'billing', 'feature', 'bug', 'other']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  body: z.string().min(1, '本文は必須です'),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// ─── チケット更新 ─────────────────────────────────────────────────────────────
export const updateTicketSchema = z
  .object({
    status: z.enum(['open', 'in_progress', 'pending', 'resolved', 'closed']).optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: '変更するフィールドを1つ以上指定してください',
  });

export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

// ─── 担当者割り当て ───────────────────────────────────────────────────────────
export const assignTicketSchema = z.object({
  assignee_id: z.string().uuid({ message: 'assignee_id は UUID 形式です' }),
});

export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

// ─── メッセージ作成 ───────────────────────────────────────────────────────────
export const createMessageSchema = z.object({
  body: z.string().min(1, 'メッセージ本文は必須です'),
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
