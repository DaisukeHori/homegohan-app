/**
 * Finance ドメイン Zod スキーマ集約
 * operator/02-api-spec.md §9, §20 準拠
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard KPI
// ─────────────────────────────────────────────────────────────────────────────

export const FinanceDashboardSchema = z.object({
  current_mrr_jpy: z.number().int().nonnegative(),
  current_arr_jpy: z.number().int().nonnegative(),
  churn_rate: z.number().nonnegative(),
  ltv_jpy: z.number().int().nonnegative(),
  new_mrr_jpy: z.number().int().nonnegative(),
  expansion_mrr_jpy: z.number().int().nonnegative(),
  contraction_mrr_jpy: z.number().int().nonnegative(),
  churned_mrr_jpy: z.number().int().nonnegative(),
  personal_active_users: z.number().int().nonnegative(),
  family_active_groups: z.number().int().nonnegative(),
  org_active_orgs: z.number().int().nonnegative(),
  mau: z.number().int().nonnegative(),
});

export type FinanceDashboard = z.infer<typeof FinanceDashboardSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Revenue Snapshot
// ─────────────────────────────────────────────────────────────────────────────

export const RevenueSnapshotSchema = z.object({
  date: z.string(),
  personal_active_users: z.number().int(),
  personal_mrr_jpy: z.number().int(),
  family_active_groups: z.number().int(),
  family_mrr_jpy: z.number().int(),
  org_active_orgs: z.number().int(),
  org_active_seats: z.number().int(),
  org_mrr_jpy: z.number().int(),
  total_mrr_jpy: z.number().int(),
  total_arr_jpy: z.number().int(),
  new_signups: z.number().int(),
  cancellations: z.number().int(),
  upgrade_count: z.number().int(),
  downgrade_count: z.number().int(),
  trial_starts: z.number().int(),
  trial_conversions: z.number().int(),
  computed_at: z.string(),
});

export type RevenueSnapshot = z.infer<typeof RevenueSnapshotSchema>;

export const RevenueQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).optional().default('month'),
  segment: z.enum(['personal', 'family', 'org', 'all']).optional().default('all'),
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().positive().max(200).optional().default(50),
});

export type RevenueQuery = z.infer<typeof RevenueQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Invoice (stripe_webhook_events 由来)
// ─────────────────────────────────────────────────────────────────────────────

export const InvoiceItemSchema = z.object({
  id: z.string(),
  stripe_event_id: z.string(),
  event_type: z.string(),
  user_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  amount_paid: z.number().nullable(),
  currency: z.string().nullable(),
  status: z.string(),
  invoice_number: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  received_at: z.string(),
  processed_at: z.string().nullable(),
});

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const InvoiceQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().positive().max(200).optional().default(50),
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type InvoiceQuery = z.infer<typeof InvoiceQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────────────

export const ReconciliationItemSchema = z.object({
  type: z.enum(['missing_in_db', 'status_mismatch', 'amount_mismatch']),
  stripe_subscription_id: z.string().nullable(),
  stripe_status: z.string().nullable(),
  db_status: z.string().nullable(),
  stripe_amount: z.number().nullable(),
  db_amount: z.number().nullable(),
  user_id: z.string().nullable(),
  detail: z.string(),
  detected_at: z.string(),
});

export type ReconciliationItem = z.infer<typeof ReconciliationItemSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// NPS / CSAT
// ─────────────────────────────────────────────────────────────────────────────

export const NpsSummarySchema = z.object({
  total_responses: z.number().int(),
  promoters: z.number().int(),
  passives: z.number().int(),
  detractors: z.number().int(),
  nps_score: z.number(),
  avg_score: z.number(),
  response_rate: z.number(),
  recent_comments: z.array(z.object({
    id: z.string(),
    score: z.number().int(),
    comment: z.string().nullable(),
    plan_key: z.string().nullable(),
    responded_at: z.string().nullable(),
  })),
});

export type NpsSummary = z.infer<typeof NpsSummarySchema>;

export const CsatSummarySchema = z.object({
  total_responses: z.number().int(),
  avg_score: z.number(),
  score_distribution: z.record(z.string(), z.number().int()),
  recent_feedbacks: z.array(z.object({
    id: z.string(),
    score: z.number().int(),
    comment: z.string().nullable(),
    ticket_id: z.string().nullable(),
    created_at: z.string(),
  })),
});

export type CsatSummary = z.infer<typeof CsatSummarySchema>;

export const NpsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  plan_key: z.string().optional(),
});

export type NpsQuery = z.infer<typeof NpsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const ExportRequestSchema = z.object({
  export_type: z.enum(['revenue', 'invoices', 'subscriptions', 'nps']),
  from: z.string().optional(),
  to: z.string().optional(),
  format: z.literal('csv').default('csv'),
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;
