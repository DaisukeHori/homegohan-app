/**
 * ユーザー管理 API の Zod スキーマ定義
 * operator/02-api-spec.md §4 準拠
 * family/02 §15.6.1 ルール: route.ts は HTTP handler のみ、schema はここに集約
 */

import { z } from 'zod';
import { OptionalCalendarDateSchema } from '@/lib/calendar-date-schema';

// ─── ユーザー一覧検索 ───────────────────────────────────────────────────────────

export const UsersSearchSchema = z.object({
  q: z.string().optional(),
  plan: z.string().optional(),
  role: z.string().optional(),
  status: z.enum(['active', 'banned', 'deleted']).optional(),
  // #1433: 登録日・最終ログイン日は operator/02-api-spec.md §4 で date (YYYY-MM-DD)。JST の暦日として扱う。
  // 実在しない日付 (2026-02-30 など) と、受け付ける範囲 (CALENDAR_DATE_MIN〜CALENDAR_DATE_MAX。9999-12-31 などの端は
  // 翌日の JST 0 時を求められないので外す) の外の日付は、DB に触れる前に 400。空文字は「指定なし」。
  // timestamptz の列 (created_at / last_login_at) と比べるときは、route で JST 0 時の時刻に直す
  // (registered_from / registered_to は jstOptionalDayRangeTimestamps、last_login_before は jstDayStartTimestamp)。
  registered_from: OptionalCalendarDateSchema,
  registered_to: OptionalCalendarDateSchema,
  last_login_before: OptionalCalendarDateSchema,
  sort: z.enum(['registered_at', 'last_login', 'meal_count']).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type UsersSearchParams = z.infer<typeof UsersSearchSchema>;

// ─── ユーザー詳細 ──────────────────────────────────────────────────────────────

export const UserDetailResponseSchema = z.object({
  id: z.string().uuid(),
  // #1145: auth.users のメールアドレス。admin / super_admin にだけ返し、それ以外 (support など) と
  // メールを持たないユーザー (電話・匿名) は null。
  email: z.string().nullable(),
  nickname: z.string().nullable(),
  roles: z.array(z.string()),
  plan_key: z.string().nullable(),
  organization_id: z.string().uuid().nullable(),
  family_group_ids: z.array(z.string().uuid()),
  stats: z.object({
    meal_count: z.number().int(),
    ai_session_count: z.number().int(),
    health_checkup_count: z.number().int(),
    last_meal_at: z.string().nullable(),
  }),
  ban_history: z.array(z.unknown()),
  support_ticket_count: z.number().int(),
  active_subscription: z
    .object({
      plan_key: z.string(),
      status: z.string(),
      next_billing_at: z.string().nullable(),
    })
    .nullable(),
  is_banned: z.boolean(),
  frozen_at: z.string().datetime().nullable().optional(),
  frozen_reason: z.string().nullable().optional(),
  frozen_by: z.string().uuid().nullable().optional(),
  last_login_at: z.string().nullable(),
  registered_at: z.string(),
});

// ─── ユーザー更新 (admin_note) ─────────────────────────────────────────────────

/** 管理ノート 1 件の最大文字数 (#1103 の前の UserPatchBodySchema と同じ値。長文の貼り付けで表を膨らませない上限) */
export const ADMIN_NOTE_MAX_LENGTH = 5000;

// #1103 (項目 5): admin_note は admin_user_notes に 1 行追加する (列の上書きではない)。
// 前後の空白を除いて空になる値は、追加するノートが無いので 400 にする (admin_user_notes.note は NOT NULL)。
export const UserPatchBodySchema = z.object({
  admin_note: z.string().trim().min(1).max(ADMIN_NOTE_MAX_LENGTH),
});

export type UserPatchBody = z.infer<typeof UserPatchBodySchema>;

// ─── ロール変更 ────────────────────────────────────────────────────────────────

// #1235: 'org_admin' は付与できない。組織の管理者は所属組織の org_role (招待で owner / admin) で決まり、
// どの組織のものかを区別しない roles の 'org_admin' は組織の管理者判定に使わない。
export const ALLOWED_ROLES = [
  'user',
  'support',
  'sales',
  'finance',
  'content_moderator',
  'org_member',
  'org_viewer',
  'org_manager',
  'org_industrial_doctor',
  'admin',
  'super_admin',
] as const;

export const RoleChangeBodySchema = z.object({
  roles: z.array(z.enum(ALLOWED_ROLES)).min(1),
  reauth_token: z.string().optional(),
});

export type RoleChangeBody = z.infer<typeof RoleChangeBodySchema>;

// ─── 凍結 (BAN) ───────────────────────────────────────────────────────────────

export const FreezeBodySchema = z.object({
  ban_type: z.enum(['temporary', 'permanent']),
  reason_category: z.enum(['spam', 'abuse', 'policy_violation', 'other']),
  reason_detail: z.string().min(1).max(2000),
  duration_days: z.number().int().min(1).max(365).optional(),
  notify_user: z.boolean().optional().default(true),
  notification_message: z.string().max(1000).optional(),
});

export type FreezeBody = z.infer<typeof FreezeBodySchema>;

// ─── 凍結解除 ─────────────────────────────────────────────────────────────────

export const UnfreezeBodySchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type UnfreezeBody = z.infer<typeof UnfreezeBodySchema>;

// ─── 監査ログ検索 ─────────────────────────────────────────────────────────────

export const AuditLogsSearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(50),
  from: z.string().optional(),
});

export type AuditLogsSearchParams = z.infer<typeof AuditLogsSearchSchema>;
