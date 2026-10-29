// 手動のプラン付与 (billing/02) の定数・Zod・型・純関数・エラー。I/O を持たない (fetch / DB / env を読まない)。
// import は zod と、純なモジュール @/lib/billing/core・@/lib/calendar-date-schema だけ (tests/billing-manual-grant.test.ts のテスト 1 が見張る)。
import { z } from 'zod';
import { FREE_PLAN_KEY, SUBSCRIPTION_STATUSES } from '@/lib/billing/core';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';

// ─────────────────────────────────────────────────────────────────────────────
// 定数 (根拠つき)
// ─────────────────────────────────────────────────────────────────────────────

/** 理由 (監査ログの details に入る自由記述) の長さの上限。巨大な本文で監査の行を膨らませない (MFA の解除の理由 MFA_RESET_REASON_MAX_LENGTH と同じ値・同じ理由) */
export const MANUAL_GRANT_REASON_MAX_LENGTH = 500;
/** subscription_plans.plan_key は varchar(100) (billing/01 §2.2 F5 の DDL)。これより長い入力は DB に届く前に 400 */
export const PLAN_KEY_MAX_LENGTH = 100;
/** 画面に出す履歴 (監査ログ) の件数。ユーザー詳細の監査ログの節 (直近 20 件) より少なめにし、付与の履歴だけを読める量にする */
export const MANUAL_GRANT_HISTORY_LIMIT = 10;
/** 手動付与できるプランの種類 (subscription_plans.plan_type)。org は組織ライセンスの仕組みで、個人の契約の行に入れない (core.ts の PURCHASABLE_PLAN_TYPES と同じ 2 種) */
export const GRANTABLE_PLAN_TYPES = ['personal', 'family'] as const;
/**
 * 手動付与できるプランの status。public だけ (billing/01 §1 が扱うプラン pro / family_basic / family_pro と同じ集合)。
 * private のプランは family_addon (アドオン。feature_packages が空・max_members NULL・月 280 円) だけで、billing/01 §1 が対象外にしている。
 * 基本のプランとして付与すると、家族グループのプランがアドオンの名前に置き換わり、家族プランの権利も付かない。
 * draft (未完成) と deprecated (廃止。契約者が 0 でないと廃止できない規則の逆向きを作らない) にも付与しない
 */
export const GRANTABLE_PLAN_STATUSES = ['public'] as const;
/** スキーマの検証に失敗したときの文 (有効期限は JST の暦日で、今日より後だけを受ける) */
export const MANUAL_GRANT_EXPIRES_ON_MESSAGE = '有効期限は今日より後の日付を指定してください';
/** 運営 API の URL (route と client が同じ文字列を使う) */
export const MANUAL_PLAN_API_BASE_PATH = '/api/super-admin/users';
export const MANUAL_PLAN_API_SUFFIX = '/manual-plan';
export function manualPlanPath(userId: string): string {
  return `${MANUAL_PLAN_API_BASE_PATH}/${encodeURIComponent(userId)}${MANUAL_PLAN_API_SUFFIX}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査 (admin_audit_logs.action_type。operator/07 §4 の命名)
// ─────────────────────────────────────────────────────────────────────────────

export const MANUAL_GRANT_AUDIT_ACTIONS = {
  /** 運営者が付与した (actor = 運営。route が書く) */
  grant: 'admin.billing.manual_grant',
  /** 運営者が取り消した (actor = 運営。route が書く) */
  revoke: 'admin.billing.manual_revoke',
  /** 期限を過ぎて expired にした (actor NULL。DB 関数 billing_expire_manual_subscription_for_user が書く) */
  expired: 'system.billing.manual_grant_expired',
} as const;
export type ManualGrantAuditAction = (typeof MANUAL_GRANT_AUDIT_ACTIONS)[keyof typeof MANUAL_GRANT_AUDIT_ACTIONS];
export const MANUAL_GRANT_AUDIT_ACTION_VALUES = [
  MANUAL_GRANT_AUDIT_ACTIONS.grant,
  MANUAL_GRANT_AUDIT_ACTIONS.revoke,
  MANUAL_GRANT_AUDIT_ACTIONS.expired,
] as const satisfies readonly ManualGrantAuditAction[];
/** 運営の操作は課金に影響する (coupons apply と同じ warn)。期限切れは予定どおりの出来事なので info */
export const MANUAL_GRANT_AUDIT_SEVERITY: Readonly<Record<ManualGrantAuditAction, 'info' | 'warn'>> = {
  'admin.billing.manual_grant': 'warn',
  'admin.billing.manual_revoke': 'warn',
  'system.billing.manual_grant_expired': 'info',
};
/** target_type (対象は利用者。varchar(30)) */
export const MANUAL_GRANT_AUDIT_TARGET_TYPE = 'user';

// ─────────────────────────────────────────────────────────────────────────────
// エラー (応答の本文は固定の文。生のエラー文は入れない)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本冊のエラーコードと HTTP ステータス。既存の名前 (NOT_FOUND / OP_INVALID_INPUT / OP_SUBSCRIPTION_ALREADY_ACTIVE / OP_SELF_MODIFY) はそのまま使う。
 * cross/04 §4.2 には、本冊の新しい 2 つ (OP_PLAN_NOT_GRANTABLE / OP_NO_MANUAL_SUBSCRIPTION) と、実コードが先に使っていて未記載の OP_SELF_MODIFY の 3 行を足す (§12.1・§15.2)
 */
export const MANUAL_GRANT_ERROR_HTTP_STATUS = {
  NOT_FOUND: 404,
  OP_INVALID_INPUT: 400,
  OP_SELF_MODIFY: 403,
  OP_PLAN_NOT_GRANTABLE: 422,
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 409,
  OP_NO_MANUAL_SUBSCRIPTION: 409,
} as const;
export type ManualGrantErrorCode = keyof typeof MANUAL_GRANT_ERROR_HTTP_STATUS;

export const MANUAL_GRANT_ERROR_MESSAGES: Readonly<Record<ManualGrantErrorCode, string>> = {
  NOT_FOUND: 'ユーザーが見つかりません',
  OP_INVALID_INPUT: '有効期限は今日より後の日付を指定してください',
  OP_SELF_MODIFY: '自分自身のプランは、ここでは変更できません',
  OP_PLAN_NOT_GRANTABLE: 'このプランは手動で付与できません',
  OP_SUBSCRIPTION_ALREADY_ACTIVE: 'すでに有効な契約があります',
  OP_NO_MANUAL_SUBSCRIPTION: '手動で付与した有効な契約がありません',
};

export class ManualGrantError extends Error {
  readonly code: ManualGrantErrorCode;
  constructor(code: ManualGrantErrorCode) {
    super(MANUAL_GRANT_ERROR_MESSAGES[code]);
    this.name = 'ManualGrantError';
    this.code = code;
  }
}

/** DB 関数の業務エラー (P0001 の message) → API のエラーコード (§12.2) */
export const MANUAL_GRANT_RPC_TO_API_CODE = {
  BILL_UNKNOWN_USER: 'NOT_FOUND',
  BILL_PLAN_NOT_GRANTABLE: 'OP_PLAN_NOT_GRANTABLE',
  BILL_MANUAL_EXPIRES_AT_PAST: 'OP_INVALID_INPUT',
  BILL_LIVE_ROW_CONFLICT: 'OP_SUBSCRIPTION_ALREADY_ACTIVE',
  BILL_MANUAL_ROW_NOT_FOUND: 'OP_NO_MANUAL_SUBSCRIPTION',
} as const satisfies Readonly<Record<string, ManualGrantErrorCode>>;
export type ManualGrantRpcCode = keyof typeof MANUAL_GRANT_RPC_TO_API_CODE;
export function isManualGrantRpcCode(value: unknown): value is ManualGrantRpcCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MANUAL_GRANT_RPC_TO_API_CODE, value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 入力 (本文)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST の本文。expires_on は JST の暦日 (YYYY-MM-DD。その日の終わりまで使える)。null / 省略 = 期限なし。
 * 「今日より後」は呼び出し側が jstToday() を渡して決める (このモジュールは時計を読まない)。YYYY-MM-DD どうしは文字列の比較で日付の順になる
 */
export function manualPlanGrantBodySchema(today: string) {
  return z
    .object({
      plan_key: z.string().trim().min(1).max(PLAN_KEY_MAX_LENGTH),
      expires_on: CalendarDateSchema.nullable().optional(),
      reason: z.string().trim().min(1).max(MANUAL_GRANT_REASON_MAX_LENGTH),
    })
    .superRefine((body, ctx) => {
      if (body.expires_on !== null && body.expires_on !== undefined && body.expires_on <= today) {
        ctx.addIssue({ code: 'custom', path: ['expires_on'], message: MANUAL_GRANT_EXPIRES_ON_MESSAGE });
      }
    });
}
export type ManualPlanGrantBody = z.infer<ReturnType<typeof manualPlanGrantBodySchema>>;

/** DELETE の本文 */
export const ManualPlanRevokeBodySchema = z.object({
  reason: z.string().trim().min(1).max(MANUAL_GRANT_REASON_MAX_LENGTH),
});
export type ManualPlanRevokeBody = z.infer<typeof ManualPlanRevokeBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 応答 (運営 API の nested の形 { data } / { error: { code, message } })。client はこの Zod で読む
// ─────────────────────────────────────────────────────────────────────────────

/** 付与できるプラン (画面の選択肢)。subscription_plans の 4 列 */
export const GrantablePlanViewSchema = z.object({
  plan_key: z.string(),
  display_name: z.string(),
  plan_type: z.enum(GRANTABLE_PLAN_TYPES),
  max_members: z.number().int().nullable(),
});
export type GrantablePlanView = z.infer<typeof GrantablePlanViewSchema>;

/** 利用者の live な契約の行 (S でも M でも I でも)。無ければ null */
export const ManualPlanCurrentViewSchema = z.object({
  subscription_id: z.uuid(),
  plan_key: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  /** stripe = Stripe の契約 / manual = 手動付与 / store = App Store・Google Play の契約 (アプリ内課金。billing/03 §8.6) */
  source: z.enum(['stripe', 'manual', 'store']),
  starts_at: z.string(),
  /** M 行の有効期限 (current_period_end。NULL = 期限なし)。S 行では次回の更新日 */
  expires_at: z.string().nullable(),
});
export type ManualPlanCurrentView = z.infer<typeof ManualPlanCurrentViewSchema>;

/** 履歴 (admin_audit_logs の本冊の 3 つの action_type。新しい順) */
export const ManualGrantHistoryEntrySchema = z.object({
  id: z.uuid(),
  action_type: z.enum(MANUAL_GRANT_AUDIT_ACTION_VALUES),
  actor_id: z.uuid().nullable(),
  created_at: z.string(),
  plan_key: z.string().nullable(),
  expires_at: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ManualGrantHistoryEntry = z.infer<typeof ManualGrantHistoryEntrySchema>;

/** admin_audit_logs.details (jsonb) から履歴の 3 項目を読む (無い・形の違う項目は null) */
export const ManualGrantAuditDetailsSchema = z.looseObject({
  plan_key: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

export const ManualPlanViewSchema = z.object({
  current: ManualPlanCurrentViewSchema.nullable(),
  plans: z.array(GrantablePlanViewSchema),
  history: z.array(ManualGrantHistoryEntrySchema),
});
export type ManualPlanView = z.infer<typeof ManualPlanViewSchema>;

/** billing_grant_manual_subscription の戻り値 (jsonb) */
export const ManualPlanGrantResultSchema = z.object({
  subscription_id: z.uuid(),
  user_id: z.uuid(),
  plan_key: z.string(),
  status: z.literal('active'),
  expires_at: z.string().nullable(),
});
export type ManualPlanGrantResult = z.infer<typeof ManualPlanGrantResultSchema>;

/** billing_revoke_manual_subscription の戻り値 (jsonb) */
export const ManualPlanRevokeResultSchema = z.object({
  subscription_id: z.uuid(),
  user_id: z.uuid(),
  plan_key: z.string(),
  status_from: z.enum(SUBSCRIPTION_STATUSES),
  status_to: z.literal('cancelled'),
});
export type ManualPlanRevokeResult = z.infer<typeof ManualPlanRevokeResultSchema>;

/** 応答の包み (運営 API の形) */
export const ManualPlanViewResponseSchema = z.object({ data: ManualPlanViewSchema });
export const ManualPlanGrantResponseSchema = z.object({ data: ManualPlanGrantResultSchema });
export const ManualPlanRevokeResponseSchema = z.object({ data: ManualPlanRevokeResultSchema });

// ─────────────────────────────────────────────────────────────────────────────
// 純関数
// ─────────────────────────────────────────────────────────────────────────────

/** 付与できるプランか (DB 関数の 2. と同じ条件。画面の選択肢と repository の SELECT の絞り込みが同じ規則になる) */
export function isGrantablePlan(plan: { plan_key: string; plan_type: string; status: string }): boolean {
  return (
    plan.plan_key !== FREE_PLAN_KEY &&
    (GRANTABLE_PLAN_TYPES as readonly string[]).includes(plan.plan_type) &&
    (GRANTABLE_PLAN_STATUSES as readonly string[]).includes(plan.status)
  );
}

/**
 * 画面で 400 OP_INVALID_INPUT に出す文。画面は応答の本文の文面 (error.message) を読まず code だけを読む
 * (src/lib/auth/mfa/client.ts と同じ。tests/lib-raw-error-message-scan.test.ts は src/lib の結果にエラーの .message を入れることを数える) ので、
 * どの入力の誤り (有効期限・理由の長さ・JSON) にも当てはまる文にする
 */
export const MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE = `入力を確かめてください (有効期限は今日より後の日付、理由は ${MANUAL_GRANT_REASON_MAX_LENGTH} 文字まで)`;
/**
 * 画面の文 (画面はエラーの本文の文面を読まず、code から引く。OP_INVALID_INPUT だけは画面用の文に差し替える)。
 * 403 の理由 (二段階認証の確認・登録が要る・凍結) の code は、運営の route が 403 OP_PERMISSION_DENIED の文に理由の文を入れたとき、
 * manual-grant-client が理由の文を code に直して返す (FORBIDDEN_REASON_CODE_BY_MESSAGE。#2086 V4)。
 * 文はほかの運営の画面の 403 の理由の文 (src/lib/api/forbidden-reason-messages.ts。forbiddenMessageForScreen が出す文) と同じ。
 * 401 / 403 の既定の文も運営の画面 (src/lib/admin/api-error-message.ts の UNAUTHENTICATED_SCREEN_MESSAGE・FORBIDDEN_SCREEN_MESSAGE) と同じ。
 * このファイルは zod・core・calendar-date-schema のほかを import しない (tests/billing-manual-grant.test.ts) ので文を書き写し、
 * 同じ文であることは tests/admin-reread-unauthenticated-2086.test.tsx が見る
 */
export const MANUAL_GRANT_CLIENT_MESSAGES: Readonly<Record<string, string>> = {
  ...MANUAL_GRANT_ERROR_MESSAGES,
  OP_INVALID_INPUT: MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE,
  AUTH_UNAUTHENTICATED: 'ログインし直してください',
  OP_PERMISSION_DENIED: '権限がありません',
  AUTH_ACCOUNT_FROZEN: 'アカウントが凍結されています',
  AUTH_2FA_REQUIRED: '二段階認証の確認が必要です',
  AUTH_2FA_ENROLLMENT_REQUIRED: '二段階認証の登録が必要です',
  INTERNAL_ERROR: '処理中にエラーが発生しました。しばらくしてからお試しください',
};
/** code が無い・知らない code のときの文 */
export const MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE = '処理に失敗しました。しばらくしてからお試しください';
export function manualGrantErrorMessage(code: string): string {
  return MANUAL_GRANT_CLIENT_MESSAGES[code] ?? MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE;
}
