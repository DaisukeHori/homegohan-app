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

// ─── ユーザー一覧の応答 (GET /api/admin/users) ────────────────────────────────────
//
// #1717: 一覧の応答の 1 行。鍵は snake_case (route が user_profiles の列から組み立てる形のまま)。
// route (src/app/api/admin/users/route.ts) はこの型で応答を組み立て、読む画面 (/admin/users・/support/users) も
// この型で読む。以前はサポートの一覧 (/support/users) だけが、応答に無い包み (users) と camelCase の鍵
// (lastLoginAt・isBanned など) で読んでいて、最終ログインや凍結の印が一覧に出なかった。

export const UserListItemSchema = z.object({
  id: z.string(),
  // admin / super_admin にだけ返す (#1145)。support と、メールを持たないユーザー (電話・匿名) は null
  email: z.string().nullable(),
  nickname: z.string().nullable(),
  // plan_key_cached が空のユーザーは 'free'
  plan_key: z.string(),
  roles: z.array(z.string()),
  // 凍結中か (一時 BAN は unban_at を過ぎたら自動で解除扱い。#1030)
  is_banned: z.boolean(),
  frozen_at: z.string().nullable(),
  frozen_reason: z.string().nullable(),
  frozen_by: z.string().nullable(),
  unban_at: z.string().nullable(),
  last_login_at: z.string().nullable(),
  // user_profiles.created_at
  registered_at: z.string().nullable(),
  // 集計は別のクエリが要るため、今は常に 0
  meal_count: z.number().int(),
  organization_id: z.string().nullable(),
});

export type UserListItem = z.infer<typeof UserListItemSchema>;

export const UsersListResponseSchema = z.object({
  data: z.array(UserListItemSchema),
  meta: z.object({
    total: z.number().int(),
    page: z.number().int(),
    per_page: z.number().int(),
  }),
});

export type UsersListResponse = z.infer<typeof UsersListResponseSchema>;

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

/**
 * admin_set_user_roles の戻り値 (#1917。supabase/migrations/20261023110000_admin_set_user_roles_previous_roles.sql)。
 * 1 行だけで、previous_roles は関数が対象の行を FOR NO KEY UPDATE でロックして読んだ、変える前の roles
 * (同時の変更があっても、この呼び出しの UPDATE の直前の値)。user_profiles.roles は NULL を許すので nullable。
 * route はこの値を監査 admin.user.role_change の details.previous_roles に残す。
 */
export const AdminSetUserRolesResultSchema = z
  .array(z.object({ previous_roles: z.array(z.string()).nullable() }))
  .length(1);

// ─── 凍結 (BAN) ───────────────────────────────────────────────────────────────

/** 凍結・凍結解除の理由の文字数の上限 (operator/02-api-spec.md §4。凍結の画面 src/components/admin/UserFreezeForm.tsx も送る前にこれで確かめる) */
export const FREEZE_REASON_MAX_LENGTH = 2000;
/** 一時 BAN の日数の下限 (1 日) */
export const FREEZE_DURATION_DAYS_MIN = 1;
/** 一時 BAN の日数の上限 (365 日。モデレーションの一時 BAN と同じ範囲) */
export const FREEZE_DURATION_DAYS_MAX = 365;
/**
 * 凍結の通知メールに載せる運営からのメッセージ (notification_message) の文字数の上限 (#2026。cross/24 §6.6・§13)。
 * 前後の空白を除いたあとの UTF-16 の長さ。メールの本文の 1 つの段に入る量で、監査 admin.user.ban の details にも同じ文を残すので、
 * 監査の行が膨らまないようにこの長さに留める。画面 (UserFreezeForm) も送る前にこれで確かめる。入力の形の上限なので環境変数にはしない
 */
export const FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH = 1000;

export const FreezeBodySchema = z.object({
  ban_type: z.enum(['temporary', 'permanent']),
  reason_category: z.enum(['spam', 'abuse', 'policy_violation', 'other']),
  reason_detail: z.string().min(1).max(FREEZE_REASON_MAX_LENGTH),
  duration_days: z.number().int().min(FREEZE_DURATION_DAYS_MIN).max(FREEZE_DURATION_DAYS_MAX).optional(),
  /** true なら凍結した本人の登録メールアドレスへ通知メールを送信待ちに積む (cross/24)。省略時 true */
  notify_user: z.boolean().optional().default(true),
  /**
   * 通知メールの「▼ 運営からのメッセージ」の段に入れる任意の文 (cross/24 §7.2)。前後の空白を除いてから長さを見る
   * (trim を max より先に並べる。Zod は検査を並べた順に適用する)。空 (空白だけ) は「無し」として扱う (route が `|| null` にする)。
   * notify_user が false なら受け取っても使わず、監査にも残さない
   */
  notification_message: z.string().trim().max(FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH).optional(),
});

export type FreezeBody = z.infer<typeof FreezeBodySchema>;

// ─── 凍結解除 ─────────────────────────────────────────────────────────────────

export const UnfreezeBodySchema = z.object({
  reason: z.string().min(1).max(FREEZE_REASON_MAX_LENGTH),
});

export type UnfreezeBody = z.infer<typeof UnfreezeBodySchema>;

// ─── 監査ログ検索 ─────────────────────────────────────────────────────────────

export const AuditLogsSearchSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(50),
  from: z.string().optional(),
});

export type AuditLogsSearchParams = z.infer<typeof AuditLogsSearchSchema>;
