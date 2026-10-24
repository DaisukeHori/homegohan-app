/**
 * メールの送信待ち (email_outbox) の一覧 API の入力検証・応答の形 (#1708 / #1193)
 *
 * 正本: docs/design/operator/10-logs-and-mail-retry.md §9.2。
 * GET /api/super-admin/email-outbox (src/app/api/super-admin/email-outbox/route.ts) が使う。
 * 画面 (src/app/super-admin/email-outbox/page.tsx) は、ここから「型」だけを import すること
 * (値を import すると zod とメール送信のモジュールまでブラウザ向けの bundle に入るため)。
 *
 * 宛先はマスクして返し、件名・本文・宛先の生の値・Idempotency-Key・Resend の ID は返さない
 * (EMAIL_OUTBOX_LIST_COLUMNS に選ばない。to_email はマスクのためだけに選び、応答には入れない)。
 * ページ送りのカーソルは app_logs と同じ形 (created_at と id。列名が同じ) を使う。
 */
import { z } from 'zod';
import { clampIntParam } from '@/lib/http-params';
import { decodeAppLogCursor, type AppLogCursor } from '@/lib/super-admin/app-logs';
import { maskEmailAddress } from '@/lib/emails/send';

export const EMAIL_OUTBOX_LIST_STATUSES = ['queued', 'sent', 'dead'] as const;
export type EmailOutboxListStatus = (typeof EMAIL_OUTBOX_LIST_STATUSES)[number];
/** 1 回の応答で返す行数の既定値 (アプリログの一覧と同じ) */
export const EMAIL_OUTBOX_DEFAULT_LIMIT = 50;
/** 1 回の応答で返す行数の上限 (これより大きい指定は、この値にそろえる) */
export const EMAIL_OUTBOX_MAX_LIMIT = 200;
/** prepare_account_deletion / complete_email_outbox / fail_email_outbox が入れる伏せ字 (SQL の c_masked_email と同じ値。tests/email-outbox-migration-contract.test.ts が突き合わせる) */
export const EMAIL_OUTBOX_REDACTED_EMAIL = 'redacted@redacted.invalid';
/** API が返す last_error_message の上限 (DB は 500 文字。画面の 1 行に収める) */
export const EMAIL_OUTBOX_ERROR_MESSAGE_MAX_CHARS = 200;
/** 伏せ字の行の宛先の表示 */
const REDACTED_RECIPIENT_LABEL = '[redacted]';
/** 文面の名前 (email_outbox.template) の長さの上限 (DB の CHECK char_length(template) BETWEEN 1 AND 100 と同じ) */
const TEMPLATE_MAX_CHARS = 100;
/** カーソルの文字列の長さの上限 (アプリログの一覧と同じ) */
const CURSOR_MAX_CHARS = 512;

/** route が select する列 (本文・宛先の生の値・Idempotency-Key・Resend の ID は選ばない) */
export const EMAIL_OUTBOX_LIST_COLUMNS =
  'id, created_at, updated_at, status, template, to_email, user_id, attempts, requeue_count, next_attempt_at, lease_expires_at, last_error_code, last_error_message, last_status_code, sent_at, dead_at, requeued_at';

export const EmailOutboxApiRowSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum(EMAIL_OUTBOX_LIST_STATUSES),
  template: z.string(),
  to_email: z.string(),
  user_id: z.string().uuid().nullable(),
  attempts: z.number().int(),
  requeue_count: z.number().int(),
  next_attempt_at: z.string(),
  lease_expires_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
  last_status_code: z.number().int().nullable(),
  sent_at: z.string().nullable(),
  dead_at: z.string().nullable(),
  requeued_at: z.string().nullable(),
});
export type EmailOutboxApiRow = z.infer<typeof EmailOutboxApiRowSchema>;

export interface EmailOutboxListItem extends Omit<EmailOutboxApiRow, 'to_email'> {
  /** マスクした宛先 (t***@example.com)。伏せ字の行は '[redacted]' */
  recipient: string;
  redacted: boolean;
}
export interface EmailOutboxListResponse {
  data: EmailOutboxListItem[];
  meta: { limit: number; has_more: boolean; next_cursor: string | null };
}
export function toEmailOutboxListItem(row: EmailOutboxApiRow): EmailOutboxListItem {
  const { to_email, ...rest } = row;
  const redacted = to_email === EMAIL_OUTBOX_REDACTED_EMAIL;
  return {
    ...rest,
    last_error_message: rest.last_error_message?.slice(0, EMAIL_OUTBOX_ERROR_MESSAGE_MAX_CHARS) ?? null,
    recipient: redacted ? REDACTED_RECIPIENT_LABEL : maskEmailAddress(to_email),
    redacted,
  };
}

const EmailOutboxFilterSchema = z.object({
  status: z.enum(EMAIL_OUTBOX_LIST_STATUSES).default('dead'),
  template: z.string().max(TEMPLATE_MAX_CHARS).optional(),
  cursor: z
    .string()
    .max(CURSOR_MAX_CHARS)
    .refine((v) => decodeAppLogCursor(v) !== null, '続きの位置 (cursor) が不正です')
    .optional(),
});
export interface EmailOutboxQuery {
  status: EmailOutboxListStatus;
  template?: string;
  cursor?: AppLogCursor;
  limit: number;
}
export type ParseEmailOutboxQueryResult =
  | { ok: true; query: EmailOutboxQuery }
  | { ok: false; details: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> } };
/** 空文字・空白だけは「指定なし」。知らないパラメータは無視。limit は 400 にせず範囲内に直す (app-logs と同じ) */
export function parseEmailOutboxQuery(searchParams: URLSearchParams): ParseEmailOutboxQueryResult {
  const raw: Record<string, string> = {};
  for (const key of ['status', 'template', 'cursor'] as const) {
    const value = searchParams.get(key)?.trim();
    if (value) raw[key] = value;
  }
  const parsed = EmailOutboxFilterSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, details: parsed.error.flatten() };
  const { cursor: rawCursor, ...filters } = parsed.data;
  const cursor = rawCursor === undefined ? undefined : (decodeAppLogCursor(rawCursor) ?? undefined);
  const limit = clampIntParam(searchParams.get('limit'), {
    min: 1,
    max: EMAIL_OUTBOX_MAX_LIMIT,
    default: EMAIL_OUTBOX_DEFAULT_LIMIT,
  });
  return { ok: true, query: { ...filters, cursor, limit } };
}
