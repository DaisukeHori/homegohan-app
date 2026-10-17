/**
 * ログイン履歴・セッションの API の Zod (canonical)。設計の正典 docs/design/cross/16-auth-history-sessions.md §12.5。
 */
import { z } from 'zod';
/**
 * POST /api/auth/login の PASSWORD_MAX_LENGTH と同じ値・同じ理由 (bcrypt は 72 バイト超を比べない。巨大な本文を送らない)。
 * 本文の大きさの上限で、パスワードの規則ではない。新しいパスワードの 72 バイトの上限 (packages/shared の PASSWORD_MAX_BYTES) は、
 * Zod の後の validatePassword が見て 422 VALID_PASSWORD_WEAK (理由の文言つき) にする (ここで 72 にすると、規則の文言の無い 400 になる)。
 * 現在のパスワード (current_password) には 72 バイトの上限を付けない (上限より長い既存のパスワードの利用者を締め出さない。#1864)
 */
export const PASSWORD_INPUT_MAX_LENGTH = 1024;
/** user_sessions_metadata.device_name varchar(200) */
export const DEVICE_NAME_MAX_LENGTH = 200;
export const PasswordChangeBodySchema = z.object({
  current_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
  new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH),
});
export const PasswordResetBodySchema = z.object({ new_password: z.string().min(1).max(PASSWORD_INPUT_MAX_LENGTH) });
/**
 * 端末名に使える文字 (英数字・空白・括弧・ピリオド・カンマ・プラス・ハイフン・下線)。機種名と OS の版 (例 "iPhone 15 Pro (iOS 18.0)") は書け、
 * URL (`:` `/`)・メールアドレス (`@`)・改行・日本語の文は書けない。端末名はセッションを持つ誰でも書ける (攻撃者も自分のセッションに) ので、
 * 一覧で人を欺く文を運ばせない (§7.1)。メールには端末名を載せない (§13.4)。apps/mobile/src/lib/device-name.ts の DEVICE_NAME_DISALLOWED_CHARS はこの補集合
 */
export const DEVICE_NAME_PATTERN = /^[A-Za-z0-9 ()._,+-]+$/;
export const DeviceNameBodySchema = z.object({
  device_name: z.string().trim().min(1).max(DEVICE_NAME_MAX_LENGTH).regex(DEVICE_NAME_PATTERN),
});
export const EndedReasonSchema = z.enum(['signed_out', 'revoked_by_user', 'idle_expired']);
export const SessionSummarySchema = z.object({
  session_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  last_active_at: z.iso.datetime({ offset: true }),
  /** deviceLabelOf(deviceFamilyOf(user_agent)) */
  device_label: z.string(),
  /** アプリが登録した端末名 (DEVICE_NAME_PATTERN の文字だけ)。画面は device_label を見出しにし、これは「端末名: …」として添える (§15) */
  device_name: z.string().nullable(),
  ip_address: z.string().nullable(),
  country_code: z.string().length(2).nullable(),
  is_current: z.boolean(),
});
export const SessionsResponseSchema = z.object({ sessions: z.array(SessionSummarySchema) });
export const LoginHistoryEntrySchema = SessionSummarySchema.omit({ is_current: true }).extend({
  ended_at: z.iso.datetime({ offset: true }).nullable(),
  ended_reason: EndedReasonSchema.nullable(),
  is_new_device: z.boolean().nullable(),
  is_new_ip: z.boolean().nullable(),
  is_new_country: z.boolean().nullable(),
  alert_sent_at: z.iso.datetime({ offset: true }).nullable(),
});
export const LoginHistoryResponseSchema = z.object({ entries: z.array(LoginHistoryEntrySchema) });
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type LoginHistoryEntry = z.infer<typeof LoginHistoryEntrySchema>;
