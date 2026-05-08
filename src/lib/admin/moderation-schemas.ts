/**
 * モデレーション API の Zod スキーマ定義
 * operator/02-api-spec.md §5 準拠
 * family/02 §15.6.1 ルール: route.ts は HTTP handler のみ、schema はここに集約
 */

import { z } from 'zod';

// ─── モデレーション対象タイプ ──────────────────────────────────────────────────

export const MODERATION_TYPES = ['food', 'recipe', 'ai_content'] as const;
export type ModerationType = (typeof MODERATION_TYPES)[number];

// ─── キュー一覧検索 ────────────────────────────────────────────────────────────

export const ModerationQueueSearchSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'escalated']).optional().default('pending'),
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
  content_url: z.string().nullable(),
  reporter_count: z.number().int(),
  user_id: z.string().uuid(),
  status: z.string(),
  created_at: z.string(),
  resolution_note: z.string().nullable(),
  resolved_by: z.string().uuid().nullable(),
  resolved_at: z.string().nullable(),
});
