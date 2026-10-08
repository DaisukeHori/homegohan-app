/**
 * 問い合わせ管理 API (/api/admin/inquiries 系) の共有部品 (#1121)
 *
 * Next.js の route.ts からは HTTP メソッドのハンドラ以外を export できないため、
 * スキーマ・行の変換・resolved_at の決め方・監査ログの対象・認可エラーの応答はここに置く。
 *
 * 呼び出し元 (どれも { inquiries } / { inquiry } の camelCase を読む):
 *   - Web:      src/app/(support)/support/inquiries/page.tsx (一覧 GET / 詳細 GET / 更新 PUT)
 *   - モバイル: apps/mobile の admin / support の問い合わせ画面 (一覧 GET / 詳細 GET / 更新 PATCH)
 * 既存クライアントの形に合わせるため、運営 API の標準形 ({ data, meta }) ではなくこの形で返す。
 *
 * 個人情報の扱い (#1200 と同じ方針):
 *   - 一覧は「概要」だけ (件名・連絡先・状態など)。問い合わせ本文と管理者メモは詳細でだけ返す
 *   - 詳細を返すときに、誰が誰の問い合わせを見たかを admin_audit_logs に記録する (recordAdminAudit)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import type { RoleName } from '@/lib/auth/types';
import { getSupabaseAdmin } from '@/lib/supabase/server';

// ─────────────────────────────────────────────────────────────────────────────
// 権限
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 問い合わせを読み書きできるロール。
 * inquiries の RLS (SELECT / UPDATE) が許す admin / super_admin / support と同じ。
 */
export const INQUIRY_ADMIN_ROLES: ReadonlyArray<RoleName> = ['admin', 'super_admin', 'support'];

// ─────────────────────────────────────────────────────────────────────────────
// スキーマ
// ─────────────────────────────────────────────────────────────────────────────

/** inquiries.status の CHECK 制約と同じ 4 値 */
export const INQUIRY_STATUSES = ['pending', 'in_progress', 'resolved', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** 管理者メモの最大文字数 (問い合わせ本文 /api/contact の上限 5000 に揃える) */
export const ADMIN_NOTES_MAX_LENGTH = 5000;

const inquiryStatusSchema = z.enum(INQUIRY_STATUSES, { message: 'status の値が不正です' });

/** 一覧のクエリ。limit / page は clampIntParam で丸めるので、ここでは status だけ検証する */
export const inquiryListQuerySchema = z.object({
  status: inquiryStatusSchema.optional(),
});

export const inquiryIdSchema = z.string().uuid({ message: 'id は UUID 形式で指定してください' });

/**
 * 更新のボディ。Web (PUT) もモバイル (PATCH) も { status, adminNotes } を送る。
 * - 省略したフィールドは変更しない
 * - adminNotes は空文字か null でメモを消す
 * - 上記以外のキー (resolved_at / message / email など) は無視する (z.object は未知のキーを捨てる)
 */
export const inquiryUpdateBodySchema = z
  .object({
    status: inquiryStatusSchema.optional(),
    adminNotes: z
      .string()
      .max(ADMIN_NOTES_MAX_LENGTH, `管理者メモは${ADMIN_NOTES_MAX_LENGTH}文字以内です`)
      .nullable()
      .optional(),
  })
  .refine((body) => body.status !== undefined || body.adminNotes !== undefined, {
    message: 'status か adminNotes のどちらかを指定してください',
  });

// ─────────────────────────────────────────────────────────────────────────────
// 行と応答の形
// ─────────────────────────────────────────────────────────────────────────────

/** 一覧が読む列 (概要)。本文 (message) と管理者メモ (admin_notes) は含めない。select('*') にもしない */
export const INQUIRY_LIST_COLUMNS =
  'id, user_id, inquiry_type, email, subject, status, created_at, updated_at, resolved_at';

/** 詳細・更新が読む列。概要に本文と管理者メモを足したもの */
export const INQUIRY_COLUMNS = `${INQUIRY_LIST_COLUMNS}, message, admin_notes`;

/** inquiries の 1 行 (概要。INQUIRY_LIST_COLUMNS と同じ列) */
export interface InquirySummaryRow {
  id: string;
  user_id: string | null;
  inquiry_type: string;
  email: string;
  subject: string;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
}

/** inquiries の 1 行 (詳細。INQUIRY_COLUMNS と同じ列) */
export interface InquiryRow extends InquirySummaryRow {
  message: string;
  admin_notes: string | null;
}

/** 一覧が返す 1 件 (camelCase)。モバイルの一覧画面の InquiryRow と同じ項目 */
export interface InquirySummaryDto {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  resolvedAt: string | null;
}

/** 詳細・更新が返す 1 件 (camelCase) */
export interface InquiryDto extends InquirySummaryDto {
  message: string;
  adminNotes: string | null;
}

export function toInquirySummaryDto(row: InquirySummaryRow, userName: string | null): InquirySummaryDto {
  return {
    id: row.id,
    userId: row.user_id,
    userName,
    inquiryType: row.inquiry_type,
    email: row.email,
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function toInquiryDto(row: InquiryRow, userName: string | null): InquiryDto {
  return {
    ...toInquirySummaryDto(row, userName),
    message: row.message,
    adminNotes: row.admin_notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 更新の中身を決める
// ─────────────────────────────────────────────────────────────────────────────

const RESOLVED_STATUSES: ReadonlyArray<string> = ['resolved', 'closed'];

/**
 * 更新後の resolved_at を決める。inquiries の updated_at はトリガーで入るが、resolved_at は入らない。
 * - resolved / closed になるとき: 解決時刻を記録する。すでに解決済み (resolved → closed など) なら
 *   最初に解決した時刻のまま変えない (メモだけの保存で「今日解決した件数」が増えないように)
 * - pending / in_progress に戻すとき (再オープン): null に戻す
 */
export function nextResolvedAt(
  nextStatus: InquiryStatus,
  current: Pick<InquirySummaryRow, 'status' | 'resolved_at'>,
  nowIso: string,
): string | null {
  if (!RESOLVED_STATUSES.includes(nextStatus)) return null;
  if (RESOLVED_STATUSES.includes(current.status) && current.resolved_at) return current.resolved_at;
  return nowIso;
}

/** 空白だけのメモは「メモなし」(null) として保存する */
export function normalizeAdminNotes(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() === '' ? null : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// 応答
// ─────────────────────────────────────────────────────────────────────────────

/** 本人以外の連絡先を含むため、共有キャッシュや履歴に残さない */
export const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: NO_STORE_HEADERS },
  );
}

/**
 * requireRole が投げた認証・認可エラーを 401 / 403 の応答にする。
 * どちらでもない例外は null を返す (呼び出し側で 500 にしてログに残す)。
 */
export function authFailureResponse(err: unknown): NextResponse | null {
  if (err instanceof AuthError) {
    return errorResponse(401, 'AUTH_UNAUTHENTICATED', '認証が必要です');
  }
  if (err instanceof ForbiddenError) {
    return errorResponse(403, 'OP_PERMISSION_DENIED', '権限がありません');
  }
  return null;
}

/** createLogger(...).withUser(...) と createLogger(...) のどちらも満たす最小の形 */
export interface ErrorLogger {
  error: (message: string, error?: unknown, metadata?: Record<string, unknown>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 問い合わせ者の表示名
// ─────────────────────────────────────────────────────────────────────────────

/** IN で一度に引く件数。uuid 100 個で URL が約 4KB に収まる */
const NICKNAME_LOOKUP_CHUNK = 100;

/**
 * 問い合わせ者の user_id → ニックネーム。画面は userName が無ければメールアドレスを表示する。
 *
 * user_profiles の RLS は本人の行だけを読める。サポート担当者が他人のニックネームを引くには
 * service_role が要るため、**requireRole を通ったあとにだけ**呼ぶこと (認可前に使うと権限昇格になる)。
 * ニックネームは補助情報なので、引けなくても一覧・詳細そのものは返す (ログには残す)。
 */
export async function fetchNicknames(
  userIds: ReadonlyArray<string | null>,
  logger: ErrorLogger,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return names;

  try {
    const admin = getSupabaseAdmin();
    for (let i = 0; i < ids.length; i += NICKNAME_LOOKUP_CHUNK) {
      const { data, error } = await admin
        .from('user_profiles')
        .select('id, nickname')
        .in('id', ids.slice(i, i + NICKNAME_LOOKUP_CHUNK));
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ id: string; nickname: string | null }>) {
        if (row.nickname) names.set(row.id, row.nickname);
      }
    }
  } catch (err) {
    logger.error('問い合わせ者のニックネームを取得できませんでした (メールアドレス表示で返します)', err);
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// 監査ログの対象
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 問い合わせの閲覧・更新を admin_audit_logs に記録するときの対象 (#1200 の方針)。
 * 会員の問い合わせは「情報を見られた本人 (会員)」を対象にし、開示請求のときに target_id = 本人 で
 * 全ての閲覧をまとめて引けるようにする。ゲスト (user_id なし) には本人の id が無いので、
 * 問い合わせそのものを対象にする。問い合わせの id はどちらの場合も details.inquiry_id に入れる。
 */
export function inquiryAuditTarget(row: Pick<InquirySummaryRow, 'id' | 'user_id'>): {
  targetId: string;
  targetType: 'user' | 'inquiry';
} {
  return row.user_id
    ? { targetId: row.user_id, targetType: 'user' }
    : { targetId: row.id, targetType: 'inquiry' };
}
