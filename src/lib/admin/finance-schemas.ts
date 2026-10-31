/**
 * Finance ドメイン Zod スキーマ集約
 * operator/02-api-spec.md §9, §20 準拠
 */
import { z } from 'zod';
import { CalendarDateSchema, OptionalCalendarDateSchema } from '@/lib/calendar-date-schema';
import { isValidIsoDateTime } from '@/lib/super-admin/app-logs';
import { REFUND_AMOUNT_MAX, REFUND_REASON_MAX_LENGTH } from './refund';

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

/** 会計の一覧 (売上・請求書・整合チェック) の 1 ページの件数の上限。#2101 より前の RevenueQuerySchema / InvoiceQuerySchema の max(200) と同じ値 */
export const FINANCE_LIST_PER_PAGE_MAX = 200;
/** 会計の一覧の per_page を省略したときの 1 ページの件数。#2101 より前のどの一覧の既定 (50) とも同じ値 */
export const FINANCE_LIST_PER_PAGE_DEFAULT = 50;

/**
 * 会計の一覧の page / per_page (#2101 X6)。1 以上の整数でなければ (数でない・0・負・小数)・per_page が上限より大きければ、
 * route が DB に触れずに 400 で断る (src/lib/admin/finance-query-errors.ts の financeInvalidQueryResponse)
 */
const financeListPageFields = {
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().positive().max(FINANCE_LIST_PER_PAGE_MAX).optional().default(FINANCE_LIST_PER_PAGE_DEFAULT),
};

/**
 * timestamptz の列 (stripe_webhook_events.received_at・admin_audit_logs.created_at) と比べる会計の一覧の from / to (#2107 Y12)。
 * 実在する日付 (YYYY-MM-DD。CalendarDateSchema と同じ範囲) か、タイムゾーンつきの ISO 8601 の日時
 * (2999-01-01T00:00:00Z・2026-10-01T09:00:00+09:00 など。暦も見る src/lib/super-admin/app-logs.ts の isValidIsoDateTime) だけを通す。
 * 以前の `z.string().optional()` は from=not-a-date をそのまま DB の比較に渡し、PostgreSQL の型の誤りで 500 になっていた。
 * いまは route が DB に触れずに 400 VALIDATION_ERROR「パラメータが不正です (from)」で断る (financeInvalidQueryResponse)。
 * 空 (?from=) は以前の `if (query.from)` と同じく「その側を絞らない」(undefined)
 */
const OptionalFinanceTimestampBoundSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .refine((value) => CalendarDateSchema.safeParse(value).success || isValidIsoDateTime(value))
    .optional(),
);

/**
 * 売上の一覧の from / to は revenue_snapshots.date (date の列) と比べるので、実在する日付 (YYYY-MM-DD) だけ (#2107 Y12。
 * 空は「その側を絞らない」)
 */
export const RevenueQuerySchema = z.object({
  from: OptionalCalendarDateSchema,
  to: OptionalCalendarDateSchema,
  granularity: z.enum(['day', 'week', 'month']).optional().default('month'),
  segment: z.enum(['personal', 'family', 'org', 'all']).optional().default('all'),
  ...financeListPageFields,
});

export type RevenueQuery = z.infer<typeof RevenueQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Invoice (stripe_webhook_events 由来)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 請求書 (stripe_webhook_events の行) の処理の状態 (processing_status) の値の一覧。
 * DB の CHECK (supabase/migrations/20251126124224_create_meal_planner_tables.sql の stripe_webhook_events.processing_status) と同じ 4 値。
 * 運営の画面の表示名は src/lib/admin/invoice-processing-status-labels.ts (画面はこのファイルの値を import しないので、型だけを読む)
 */
export const INVOICE_PROCESSING_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type InvoiceProcessingStatus = (typeof INVOICE_PROCESSING_STATUSES)[number];

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
  ...financeListPageFields,
  status: z.enum(INVOICE_PROCESSING_STATUSES).optional(),
  // received_at (timestamptz) と比べる。日付か、タイムゾーンつきの日時だけ (#2107 Y12)
  from: OptionalFinanceTimestampBoundSchema,
  to: OptionalFinanceTimestampBoundSchema,
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

/**
 * 整合チェックの一覧 (GET /api/admin/finance/reconciliation) のクエリ (#2101 X6)。
 * 以前の route は `parseInt(page)` だけで読み、?page=abc の NaN を `.range(NaN, …)` に渡して 500 にし、
 * ?page=0 では負の offset を作っていた。per_page の上限も無かった (いまは会計の他の一覧と同じ 200)
 */
export const ReconciliationQuerySchema = z.object({
  // admin_audit_logs.created_at (timestamptz) と比べる。日付か、タイムゾーンつきの日時だけ (#2107 Y12)
  from: OptionalFinanceTimestampBoundSchema,
  to: OptionalFinanceTimestampBoundSchema,
  ...financeListPageFields,
});

export type ReconciliationQuery = z.infer<typeof ReconciliationQuerySchema>;

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
  // 期間の開始日・終了日 (どちらの日も含む。JST の暦日)。画面 (admin/finance/nps) の日付の入力。
  // 空文字は「指定なし」。存在しない日付・時刻つきの値は 400 (#1433。route が JST 0 時の時刻に直して絞る)
  from: OptionalCalendarDateSchema,
  to: OptionalCalendarDateSchema,
  plan_key: z.string().optional(),
});

export type NpsQuery = z.infer<typeof NpsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const ExportRequestSchema = z.object({
  export_type: z.enum(['revenue', 'invoices', 'subscriptions', 'nps']),
  // 期間の開始日・終了日 (どちらの日も含む。JST の暦日)。画面 (admin/finance/exports) の日付の入力。
  // 空文字は「指定なし」。存在しない日付・時刻つきの値は 400 (#1433。route が timestamptz の列は JST 0 時の時刻に直して絞る)
  from: OptionalCalendarDateSchema,
  to: OptionalCalendarDateSchema,
  format: z.literal('csv').default('csv'),
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Refund (返金の記録。返金そのものは Stripe ダッシュボードで行う — #1185)
// ─────────────────────────────────────────────────────────────────────────────

/** Stripe の Charge ID。通常の決済は ch_...、カード以外の決済は py_... */
const StripeChargeIdSchema = z
  .string()
  .trim()
  .regex(/^(?:ch|py)_[A-Za-z0-9]+$/, 'Stripe の Charge ID (ch_...) の形式ではありません')
  .max(255);

/** Stripe の Invoice ID (in_...) */
const StripeInvoiceIdSchema = z
  .string()
  .trim()
  .regex(/^in_[A-Za-z0-9]+$/, 'Stripe の Invoice ID (in_...) の形式ではありません')
  .max(255);

export const RefundRequestSchema = z
  .object({
    /** 返金の対象になるユーザー (auth.users.id) */
    user_id: z.string().uuid(),
    /** 返金する決済。stripe_charge_id か stripe_invoice_id のどちらか一方だけを指定する */
    stripe_charge_id: StripeChargeIdSchema.nullish(),
    stripe_invoice_id: StripeInvoiceIdSchema.nullish(),
    /**
     * 返金額。通貨の最小単位の整数 (Stripe の amount と同じ)。
     * JPY は小数がないので円そのもの、それ以外は 1/100 (USD ならセント)。
     */
    amount: z.number().int().positive().max(REFUND_AMOUNT_MAX),
    /** 通貨 (ISO 4217)。省略時は JPY。大文字にそろえて保存する */
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, '通貨コードは英字 3 文字で指定してください')
      .transform((currency) => currency.toUpperCase())
      .default('JPY'),
    /** 返金する理由 (必須)。監査ログに残る */
    reason: z
      .string()
      .trim()
      .min(1)
      .max(REFUND_REASON_MAX_LENGTH)
      // NUL 文字は Postgres の jsonb に保存できず、記録が 500 で失敗してしまうので先に弾く
      .refine((reason) => !reason.includes('\u0000'), '使用できない文字が含まれています'),
  })
  .refine((request) => (request.stripe_charge_id != null) !== (request.stripe_invoice_id != null), {
    message: 'Stripe の支払い (stripe_charge_id) と請求書 (stripe_invoice_id) はどちらか一方だけを指定してください',
    path: ['stripe_charge_id'],
  });

export type RefundRequest = z.infer<typeof RefundRequestSchema>;
