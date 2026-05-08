/**
 * ユーザー管理 API の Zod スキーマ定義
 * operator/02-api-spec.md §4 準拠
 * family/02 §15.6.1 ルール: route.ts は HTTP handler のみ、schema はここに集約
 */

import { z } from 'zod';

// ─── ユーザー一覧検索 ───────────────────────────────────────────────────────────

export const UsersSearchSchema = z.object({
  q: z.string().optional(),
  plan: z.string().optional(),
  role: z.string().optional(),
  status: z.enum(['active', 'banned', 'deleted']).optional(),
  registered_from: z.string().optional(),
  registered_to: z.string().optional(),
  last_login_before: z.string().optional(),
  sort: z.enum(['registered_at', 'last_login', 'meal_count']).optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type UsersSearchParams = z.infer<typeof UsersSearchSchema>;

// ─── ユーザー詳細 ──────────────────────────────────────────────────────────────

export const UserDetailResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().optional(),
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

export const UserPatchBodySchema = z.object({
  admin_note: z.string().max(5000),
});

export type UserPatchBody = z.infer<typeof UserPatchBodySchema>;

// ─── ロール変更 ────────────────────────────────────────────────────────────────

export const ALLOWED_ROLES = [
  'user',
  'support',
  'sales',
  'finance',
  'content_moderator',
  'org_member',
  'org_viewer',
  'org_manager',
  'org_admin',
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

// ─── impersonate ──────────────────────────────────────────────────────────────

export const ImpersonateBodySchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type ImpersonateBody = z.infer<typeof ImpersonateBodySchema>;

// ─── 監査ログ検索 ─────────────────────────────────────────────────────────────

export const AuditLogsSearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(50),
  from: z.string().optional(),
});

export type AuditLogsSearchParams = z.infer<typeof AuditLogsSearchSchema>;
