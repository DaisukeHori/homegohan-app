/**
 * モデレーション API の Zod スキーマ定義
 * operator/02-api-spec.md §5 準拠
 * family/02 §15.6.1 ルール: route.ts は HTTP handler のみ、schema はここに集約
 */

import { z } from 'zod';

// ─── モデレーション対象タイプ ──────────────────────────────────────────────────

export const MODERATION_TYPES = ['food', 'recipe', 'ai_content'] as const;
export type ModerationType = (typeof MODERATION_TYPES)[number];

/**
 * 400 VALIDATION_ERROR の文: パスの種類 (type) が MODERATION_TYPES に無い (対応・復元の route)。
 * 受け付ける値 (英字) は、項目名と同じく括弧に入れて添える (#1917 の続き。src/lib/health-api-messages.ts の healthEnumMessage と同じ形)
 */
export const MODERATION_TYPE_INVALID_MESSAGE = `種類 (type) は次のいずれかを指定してください (${MODERATION_TYPES.join(', ')})`;

// ─── キュー一覧検索 ────────────────────────────────────────────────────────────

/** 審査の一覧で絞り込める状態 (GET /api/admin/moderation/queue の status。これ以外は API が 400) */
export const MODERATION_QUEUE_STATUSES = ['pending', 'approved', 'rejected', 'escalated'] as const;
export type ModerationQueueStatus = (typeof MODERATION_QUEUE_STATUSES)[number];

/** 審査の一覧の既定の状態 (status を省略したとき・読めないとき) */
export const MODERATION_QUEUE_DEFAULT_STATUS: ModerationQueueStatus = 'pending';

/**
 * 画面の URL の status (searchParams.status) を、審査の一覧の API に送る状態に読む (#2101 X7)。
 * MODERATION_QUEUE_STATUSES に無い値 (?status=foo など、URL を手で書き換えたとき) は既定の pending にする。
 * 以前は URL の値をそのまま API に送り、400 の読み込みの失敗が「再読み込み」でも直らなかった
 * (URL の page の src/lib/list-pagination.ts の parsePageParam と同じ扱い。#2093 W8)
 */
export function parseModerationQueueStatusParam(raw: string | undefined): ModerationQueueStatus {
  return MODERATION_QUEUE_STATUSES.find((status) => status === raw) ?? MODERATION_QUEUE_DEFAULT_STATUS;
}

export const ModerationQueueSearchSchema = z.object({
  status: z.enum(MODERATION_QUEUE_STATUSES).optional().default(MODERATION_QUEUE_DEFAULT_STATUS),
  type: z.enum(MODERATION_TYPES).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(30),
});

export type ModerationQueueSearchParams = z.infer<typeof ModerationQueueSearchSchema>;

// ─── モデレーション解決 ────────────────────────────────────────────────────────

export const ModerationActions = [
  'approve',
  'delete_only',
  'delete_and_warn',
  'delete_and_temp_ban',
  'delete_and_perm_ban',
  'escalate',
] as const;

export type ModerationAction = (typeof ModerationActions)[number];

/**
 * 通報されたコンテンツを「削除」する (= 隠す) アクション (#1101)。
 * 行は消さず、hidden_at を入れて本人以外に見えなくする。approve / escalate は何も隠さない。
 */
export const ModerationDeleteActions = [
  'delete_only',
  'delete_and_warn',
  'delete_and_temp_ban',
  'delete_and_perm_ban',
] as const satisfies readonly ModerationAction[];

export function isModerationDeleteAction(action: ModerationAction): boolean {
  return (ModerationDeleteActions as readonly ModerationAction[]).includes(action);
}

export const ModerationResolveBodySchema = z.object({
  action: z.enum(ModerationActions),
  ban_duration_days: z.number().int().min(1).max(365).optional(),
  resolution_note: z.string().min(1).max(5000).optional(),
});

export type ModerationResolveBody = z.infer<typeof ModerationResolveBodySchema>;

// ─── モデレーションアイテムレスポンス ─────────────────────────────────────────

export const ModerationItemSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(MODERATION_TYPES),
  /** 通報されたコンテンツ本体の ID (meals.id / recipes.id)。紐づかないときは null (#1101) */
  content_id: z.string().uuid().nullable(),
  content_url: z.string().nullable(),
  reporter_count: z.number().int(),
  user_id: z.string().uuid(),
  status: z.string(),
  created_at: z.string(),
  resolution_note: z.string().nullable(),
  resolved_by: z.string().uuid().nullable(),
  resolved_at: z.string().nullable(),
  /** 通報されたコンテンツ本体が運営に隠されているときの日時 (ISO)。隠れていない・コンテンツが無いときは null (#1538) */
  hidden_at: z.string().nullable(),
});

// ─── 隠したコンテンツを戻す (#1538 の項目 4) ─────────────────────────────────

/** 解決メモ (resolution_note) と戻す理由 (restore_note) の長さ。既存の ModerationResolveBodySchema の resolution_note と同じ上限 */
export const MODERATION_NOTE_MIN_LENGTH = 1;
export const MODERATION_NOTE_MAX_LENGTH = 5000;

/**
 * POST /api/admin/moderation/{type}/{id}/restore の本文。戻す理由は必須 (モデレーションの判定を覆す操作に、理由の無い実行を許さない)。
 * 前後の空白を除いてから長さを見る (空白だけは 400)
 */
export const ModerationRestoreBodySchema = z.object({
  restore_note: z.string().trim().min(MODERATION_NOTE_MIN_LENGTH).max(MODERATION_NOTE_MAX_LENGTH),
});

export type ModerationRestoreBody = z.infer<typeof ModerationRestoreBodySchema>;

/** 戻す操作の監査ログの action_type (docs/design/operator/07-audit-monitoring.md §4.1) */
export const MODERATION_RESTORE_AUDIT_ACTION = 'admin.moderation.restore';
