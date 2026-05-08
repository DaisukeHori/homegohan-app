/**
 * 営業 CRM API スキーマ
 * operator/02-api-spec.md §14 準拠
 */
import { z } from 'zod';

// ─── リード一覧クエリ ─────────────────────────────────────────────────────────
export const leadListQuerySchema = z.object({
  stage: z
    .enum(['approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost'])
    .optional(),
  assigned_to: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

// ─── リード作成 ───────────────────────────────────────────────────────────────
export const createLeadSchema = z.object({
  company_name: z
    .string()
    .min(1, '会社名は必須です')
    .max(200, '会社名は200文字以内です'),
  industry: z.string().max(100).optional(),
  employee_count: z.number().int().positive().optional(),
  contact_name: z.string().max(100).optional(),
  contact_email: z.string().email().optional().or(z.literal('')),
  contact_phone: z.string().max(50).optional(),
  source: z
    .enum(['website', 'referral', 'event', 'cold_call', 'other'])
    .optional(),
  estimated_acv: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
  assigned_to: z.string().uuid().optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

// ─── リード更新 ───────────────────────────────────────────────────────────────
export const updateLeadSchema = z
  .object({
    company_name: z.string().min(1).max(200).optional(),
    industry: z.string().max(100).optional(),
    employee_count: z.number().int().positive().optional(),
    contact_name: z.string().max(100).optional(),
    contact_email: z.string().email().optional().or(z.literal('')),
    contact_phone: z.string().max(50).optional(),
    source: z
      .enum(['website', 'referral', 'event', 'cold_call', 'other'])
      .optional(),
    stage: z
      .enum(['approach', 'meeting', 'proposal', 'negotiation', 'won', 'lost'])
      .optional(),
    estimated_acv: z.number().int().nonnegative().optional(),
    notes: z.string().optional(),
    assigned_to: z.string().uuid().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: '変更するフィールドを1つ以上指定してください',
  });

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

// ─── 活動記録作成 ─────────────────────────────────────────────────────────────
export const createActivitySchema = z.object({
  activity_type: z.enum(['call', 'email', 'meeting', 'note', 'stage_change']),
  details: z.record(z.string(), z.unknown()),
});

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
