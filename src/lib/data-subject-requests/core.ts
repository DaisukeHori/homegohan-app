// src/lib/data-subject-requests/core.ts
// #1178 開示・訂正・利用停止・消去の請求 (DSR) の正典: 定数・Zod・型・状態遷移・純関数。
// Node 専用の処理 (トークン) は tokens.ts、環境変数は config.ts、DB の読み書きは service.ts、メールは notifications.ts。
import { z } from 'zod';

// ── 種類・状態 ───────────────────────────────────────────────────────────────
/** 請求の種類 (DB の CHECK data_subject_requests_request_type_check と同じ 4 値) */
export const DSR_REQUEST_TYPES = ['disclosure', 'correction', 'suspension', 'erasure'] as const;
export type DsrRequestType = (typeof DSR_REQUEST_TYPES)[number];

/** 状態 (DB の CHECK data_subject_requests_status_check と同じ 6 値) */
export const DSR_STATUSES = [
  'pending_verification',
  'received',
  'in_progress',
  'fulfilled',
  'rejected',
  'withdrawn',
] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];

/** 開いている状態 (部分一意索引 data_subject_requests_one_open_per_type の WHERE と同じ) */
export const DSR_OPEN_STATUSES: ReadonlyArray<DsrStatus> = ['pending_verification', 'received', 'in_progress'];
/** 運営が手を付けてよい状態 (本人確認が済んでいる) */
export const DSR_ACTIONABLE_STATUSES: ReadonlyArray<DsrStatus> = ['received', 'in_progress'];
/** 終わった状態 */
export const DSR_TERMINAL_STATUSES: ReadonlyArray<DsrStatus> = ['fulfilled', 'rejected', 'withdrawn'];

/** 本人確認の方法 (v1 は 1 種) */
export const DSR_VERIFICATION_METHOD = 'email_link' as const;

// ── 上限・期限 (運用上の意味を持つ数は全部ここ) ─────────────────────────────
/** 請求の内容の上限 (DB の CHECK と同じ。お問い合わせの本文 5000 より短いのは、請求は要点だけでよく、長文の説明はサポートで受けるため) */
export const DSR_DETAILS_MAX_LENGTH = 2000;
/** 応答・内部メモの上限 (DB の CHECK と同じ。問い合わせの管理者メモの上限 ADMIN_NOTES_MAX_LENGTH に揃える) */
export const DSR_NOTE_MAX_LENGTH = 5000;
/** 本人確認リンクの有効時間 (時間)。1 日あれば当日中に開ける。過ぎたら再送で取り直す */
export const DSR_VERIFICATION_TTL_HOURS = 24;
/** 1 つの請求で確認メールを送れる回数の上限 (初回を含む)。迷惑メール扱いの確認と再送 2〜3 回で足りる */
export const DSR_VERIFICATION_MAX_SENDS = 5;
/** 応答期限の既定 (日)。本人確認の時点から数える。環境変数 DSR_RESPONSE_DUE_DAYS で上書き (§12) */
export const DSR_RESPONSE_DUE_DAYS_DEFAULT = 30;
/** 応答期限として受け付ける最大 (日)。1 年を超える期限は設定の誤り */
export const DSR_RESPONSE_DUE_DAYS_MAX = 365;
/** 本人の一覧で返す最大件数。同じ種類の開いている請求は 1 つなので、終わった請求を含めてもこれで足りる */
export const DSR_OWN_LIST_LIMIT = 50;
/** 運営の一覧の 1 ページ (問い合わせ一覧と同じ) */
export const DSR_ADMIN_LIST_LIMITS = { min: 1, max: 100, default: 50 } as const;
export const DSR_ADMIN_PAGE_LIMITS = { min: 1, max: 10000, default: 1 } as const;
/** 受付番号として画面・メールに出す id の先頭の桁数 (チケットの shortTicketId と同じ) */
export const DSR_SHORT_ID_LENGTH = 8;

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

// ── 役割・経路 ───────────────────────────────────────────────────────────────
/** 請求を読み書きできる運営のロール。support を含めない理由は設計 §3.2 */
export const DSR_OPERATOR_ROLES = ['admin', 'super_admin'] as const;
export type DsrOperatorRole = (typeof DSR_OPERATOR_ROLES)[number];

/**
 * 請求の画面のパスと、設定画面の入口の見出し・説明の文は、アプリ (apps/mobile) と共用するため @homegohan/shared に置く (#1812)。
 * Web の各画面・メールは今までどおりここから読む (値は packages/shared/src/data-subject-requests.ts が正)
 */
export { DSR_SETTINGS_PATH, DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_ENTRY_DESCRIPTION } from '@homegohan/shared';
export const DSR_VERIFY_PATH = '/settings/data-requests/verify';
export const DSR_ADMIN_PATH = '/admin/data-requests';
export const DSR_ACCOUNT_API_PATH = '/api/account/data-requests';
export const DSR_ADMIN_API_PATH = '/api/admin/data-requests';
/** レート制限のカテゴリ (src/lib/rate-limit.ts の RateLimitCategory に足す) */
export const DSR_RATE_LIMIT_CATEGORY = 'dsr' as const;
/** 監査ログの action_type (operator/07 §4.1.1 の命名) */
export const DSR_AUDIT_ACTIONS = {
  list: 'admin.dsr.list',
  view: 'admin.dsr.view',
  update: 'admin.dsr.update',
} as const;

export const DSR_REQUEST_TYPE_LABELS: Record<DsrRequestType, string> = {
  disclosure: '開示',
  correction: '訂正',
  suspension: '利用停止',
  erasure: '消去',
};
export const DSR_STATUS_LABELS: Record<DsrStatus, string> = {
  pending_verification: '本人確認待ち',
  received: '受付済み',
  in_progress: '対応中',
  fulfilled: '対応済み',
  rejected: '対応できず',
  withdrawn: '取り下げ',
};

// ── エラーコード ─────────────────────────────────────────────────────────────
export const DSR_ERROR_CODES = [
  'DSR_ALREADY_OPEN',
  'DSR_INVALID_STATE',
  'DSR_VERIFICATION_INVALID',
  'DSR_VERIFICATION_EXPIRED',
  'DSR_VERIFICATION_LIMIT',
  'DSR_INVALID_TRANSITION',
  'DSR_RESPONSE_NOTE_REQUIRED',
] as const;
export type DsrErrorCode = (typeof DSR_ERROR_CODES)[number];

// ── Zod (入力の正本) ─────────────────────────────────────────────────────────
export const dsrCreateBodySchema = z.object({
  request_type: z.enum(DSR_REQUEST_TYPES, { message: '請求の種類 (request_type) の値が不正です' }),
  details: z
    .string()
    .trim()
    .min(1, '請求の内容は必須です')
    .max(DSR_DETAILS_MAX_LENGTH, `請求の内容は${DSR_DETAILS_MAX_LENGTH}文字以内です`),
});
export type DsrCreateInput = z.infer<typeof dsrCreateBodySchema>;

/** 本人確認トークン (tokens.ts が作る 32 バイトの 16 進 = 64 文字) */
export const dsrVerifyBodySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, '確認のトークン (token) の形式が不正です'),
});
export type DsrVerifyInput = z.infer<typeof dsrVerifyBodySchema>;

export const dsrIdSchema = z.string().uuid({ message: 'ID (id) は UUID 形式で指定してください' });

/** 運営の一覧の絞り込み (page / per_page は clampIntParam で丸めるので、ここでは見ない) */
export const dsrAdminListQuerySchema = z.object({
  status: z.enum(DSR_STATUSES, { message: '状態 (status) の値が不正です' }).optional(),
  request_type: z.enum(DSR_REQUEST_TYPES, { message: '請求の種類 (request_type) の値が不正です' }).optional(),
  /** '1' のときだけ期限超過 (due_at < now かつ received / in_progress) に絞る */
  overdue: z.enum(['1']).optional(),
});
export type DsrAdminListQuery = z.infer<typeof dsrAdminListQuerySchema>;

/** 運営が PATCH で動かせる状態 (received / in_progress からの遷移先だけ。pending_verification へ戻す・withdrawn にする操作は無い) */
export const DSR_OPERATOR_TARGET_STATUSES = ['in_progress', 'fulfilled', 'rejected'] as const;

export const dsrAdminUpdateBodySchema = z
  .object({
    status: z.enum(DSR_OPERATOR_TARGET_STATUSES, { message: '状態 (status) の値が不正です' }).optional(),
    response_note: z
      .string()
      .max(DSR_NOTE_MAX_LENGTH, `応答は${DSR_NOTE_MAX_LENGTH}文字以内です`)
      .nullable()
      .optional(),
    admin_notes: z
      .string()
      .max(DSR_NOTE_MAX_LENGTH, `内部メモは${DSR_NOTE_MAX_LENGTH}文字以内です`)
      .nullable()
      .optional(),
  })
  .refine(
    (body) => body.status !== undefined || body.response_note !== undefined || body.admin_notes !== undefined,
    { message: '状態 (status) か利用者への回答 (response_note) か運営のメモ (admin_notes) のどれかを指定してください' },
  );
export type DsrAdminUpdateInput = z.infer<typeof dsrAdminUpdateBodySchema>;

// ── 行と DTO (snake_case のまま返す。docs/design/CLAUDE.md §4) ──────────────
/** data_subject_requests の 1 行 (全列) */
export interface DsrRow {
  id: string;
  user_id: string | null;
  request_type: DsrRequestType;
  status: DsrStatus;
  details: string;
  verification_method: typeof DSR_VERIFICATION_METHOD;
  verification_token_hash: string | null;
  verification_sent_at: string | null;
  verification_expires_at: string | null;
  verification_send_count: number;
  verified_at: string | null;
  due_at: string | null;
  response_note: string | null;
  admin_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 本人の API・運営の一覧・書き出しが authenticated (RLS) で読む列 = migration の列の GRANT と同じ 15 列。
 * hash と内部メモは GRANT していないので、authenticated の client でこの外の列を読むと 42501 になる
 */
export const DSR_OWN_COLUMNS =
  'id, user_id, request_type, status, details, verification_method, verification_sent_at, verification_expires_at, ' +
  'verification_send_count, verified_at, due_at, response_note, resolved_at, created_at, updated_at';
/** 運営の一覧が読む列 (概要。DSR_OWN_COLUMNS の部分集合なので authenticated で読める。details / 応答 / 内部メモは詳細でだけ返す) */
export const DSR_ADMIN_LIST_COLUMNS =
  'id, user_id, request_type, status, verified_at, due_at, resolved_at, created_at, updated_at';
/** 運営の詳細・更新が読む列 (hash 以外の全列)。admin_notes を含むので service_role の client でだけ読む */
export const DSR_ADMIN_COLUMNS = `${DSR_OWN_COLUMNS}, admin_notes`;
/** 本人の verify / resend / withdraw が判定の前に service_role の client で読む列 (トークンの突き合わせに hash が要る。応答には入れない) */
export const DSR_REQUESTER_ACTION_COLUMNS = `${DSR_OWN_COLUMNS}, verification_token_hash`;

/** 本人に返す 1 件 */
export interface DsrOwnDto {
  id: string;
  request_type: DsrRequestType;
  status: DsrStatus;
  details: string;
  verification_method: typeof DSR_VERIFICATION_METHOD;
  verification_sent_at: string | null;
  verification_expires_at: string | null;
  verification_send_count: number;
  /** 期限切れ (pending_verification かつ expires_at < now)。再送の案内に使う */
  verification_expired: boolean;
  verified_at: string | null;
  due_at: string | null;
  response_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 運営の一覧の 1 件 */
export interface DsrAdminSummaryDto {
  id: string;
  user_id: string | null;
  requester_nickname: string | null;
  request_type: DsrRequestType;
  status: DsrStatus;
  verified_at: string | null;
  due_at: string | null;
  overdue: boolean;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 運営の詳細・更新の 1 件 */
export interface DsrAdminDetailDto extends DsrAdminSummaryDto {
  details: string;
  verification_method: typeof DSR_VERIFICATION_METHOD;
  verification_sent_at: string | null;
  verification_expires_at: string | null;
  verification_send_count: number;
  response_note: string | null;
  admin_notes: string | null;
  /** 退会済み (user_id が NULL) なら null。email は service_role の RPC admin_user_emails で引く (無ければ null) */
  requester: { user_id: string; nickname: string | null; email: string | null } | null;
}

type DsrOwnRow = Omit<DsrRow, 'verification_token_hash' | 'admin_notes'>;
/** 運営の詳細・更新で service_role が DSR_ADMIN_COLUMNS で読んだ 1 行 (hash を読まない) */
export type DsrAdminRow = Omit<DsrRow, 'verification_token_hash'>;
/** メール (notifications.ts) が使う列だけ。本人の列 (DSR_OWN_COLUMNS) でも運営の列 (DSR_ADMIN_COLUMNS) でも渡せる */
export type DsrNotificationRow = Pick<DsrRow, 'id' | 'user_id' | 'request_type' | 'status' | 'due_at'>;

// ── 純関数 ───────────────────────────────────────────────────────────────────
export function isDsrOpen(status: DsrStatus): boolean {
  return DSR_OPEN_STATUSES.includes(status);
}

export function isDsrTerminal(status: DsrStatus): boolean {
  return DSR_TERMINAL_STATUSES.includes(status);
}

/** 本人確認リンクが期限切れか (pending_verification のときだけ true になりうる) */
export function isDsrVerificationExpired(
  row: Pick<DsrRow, 'status' | 'verification_expires_at'>,
  now: Date,
): boolean {
  if (row.status !== 'pending_verification' || !row.verification_expires_at) return false;
  return new Date(row.verification_expires_at).getTime() < now.getTime();
}

/** 応答期限を過ぎているか (受付済み / 対応中だけ。終わった請求は超過と数えない) */
export function isDsrOverdue(row: Pick<DsrRow, 'status' | 'due_at'>, now: Date): boolean {
  if (!DSR_ACTIONABLE_STATUSES.includes(row.status) || !row.due_at) return false;
  return new Date(row.due_at).getTime() < now.getTime();
}

export function computeDsrVerificationExpiresAt(sentAt: Date): Date {
  return new Date(sentAt.getTime() + DSR_VERIFICATION_TTL_HOURS * MS_PER_HOUR);
}

export function computeDsrDueAt(verifiedAt: Date, dueDays: number): Date {
  return new Date(verifiedAt.getTime() + dueDays * MS_PER_DAY);
}

/**
 * 環境変数 DSR_RESPONSE_DUE_DAYS の値を日数にする。10 進の数字だけの正の整数で 1〜DSR_RESPONSE_DUE_DAYS_MAX のときだけ採用し、
 * それ以外 (未設定・空・0・負・小数・1e2・範囲外) は既定 (DSR_RESPONSE_DUE_DAYS_DEFAULT)。値を読むのは config.ts だけ
 */
export function resolveDsrResponseDueDays(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(trimmed)) return DSR_RESPONSE_DUE_DAYS_DEFAULT;
  const days = Number(trimmed);
  return days >= 1 && days <= DSR_RESPONSE_DUE_DAYS_MAX ? days : DSR_RESPONSE_DUE_DAYS_DEFAULT;
}

/** 受付番号 (id の先頭 8 桁) */
export function shortDsrId(id: string): string {
  return id.slice(0, DSR_SHORT_ID_LENGTH);
}

/** 空白だけの応答・メモは「なし」(null) として保存する (問い合わせの normalizeAdminNotes と同じ) */
export function normalizeDsrNote(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

/** 対応済み / 却下にするとき、本人への応答が必須 */
export function dsrRequiresResponseNote(next: DsrStatus): boolean {
  return next === 'fulfilled' || next === 'rejected';
}

export function canWithdrawDsr(status: DsrStatus): boolean {
  return isDsrOpen(status);
}

/** 本人確認リンクの URL (siteUrl は getSiteUrl()。末尾の / は無い) */
export function buildDsrVerifyUrl(siteUrl: string, id: string, token: string): string {
  const query = new URLSearchParams({ id, token });
  return `${siteUrl}${DSR_VERIFY_PATH}?${query.toString()}`;
}

// ── 状態遷移 (§8.3 の表のうち状態が変わる 9 行と同じ内容。表に無い遷移は作らない) ──
// 状態を変えない操作 (create・resend・運営の status 無しの update・退会) と 409 の行は入れない (§8.3 の表の下の注)
export type DsrActor = 'requester' | 'operator';
export type DsrTransitionAction = 'verify' | 'withdraw' | 'update';
export interface DsrTransition {
  from: DsrStatus;
  to: DsrStatus;
  actor: DsrActor;
  action: DsrTransitionAction;
}

export const DSR_TRANSITIONS: readonly DsrTransition[] = [
  { from: 'pending_verification', to: 'received', actor: 'requester', action: 'verify' },
  { from: 'pending_verification', to: 'withdrawn', actor: 'requester', action: 'withdraw' },
  { from: 'received', to: 'withdrawn', actor: 'requester', action: 'withdraw' },
  { from: 'in_progress', to: 'withdrawn', actor: 'requester', action: 'withdraw' },
  { from: 'received', to: 'in_progress', actor: 'operator', action: 'update' },
  { from: 'received', to: 'fulfilled', actor: 'operator', action: 'update' },
  { from: 'received', to: 'rejected', actor: 'operator', action: 'update' },
  { from: 'in_progress', to: 'fulfilled', actor: 'operator', action: 'update' },
  { from: 'in_progress', to: 'rejected', actor: 'operator', action: 'update' },
];

export function findDsrTransition(actor: DsrActor, from: DsrStatus, to: DsrStatus): DsrTransition | null {
  return DSR_TRANSITIONS.find((t) => t.actor === actor && t.from === from && t.to === to) ?? null;
}

// ── DTO への変換 ─────────────────────────────────────────────────────────────
export function toDsrOwnDto(row: DsrOwnRow, now: Date): DsrOwnDto {
  return {
    id: row.id,
    request_type: row.request_type,
    status: row.status,
    details: row.details,
    verification_method: row.verification_method,
    verification_sent_at: row.verification_sent_at,
    verification_expires_at: row.verification_expires_at,
    verification_send_count: row.verification_send_count,
    verification_expired: isDsrVerificationExpired(row, now),
    verified_at: row.verified_at,
    due_at: row.due_at,
    response_note: row.response_note,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toDsrAdminSummaryDto(
  row: Pick<
    DsrRow,
    'id' | 'user_id' | 'request_type' | 'status' | 'verified_at' | 'due_at' | 'resolved_at' | 'created_at' | 'updated_at'
  >,
  requesterNickname: string | null,
  now: Date,
): DsrAdminSummaryDto {
  return {
    id: row.id,
    user_id: row.user_id,
    requester_nickname: requesterNickname,
    request_type: row.request_type,
    status: row.status,
    verified_at: row.verified_at,
    due_at: row.due_at,
    overdue: isDsrOverdue(row, now),
    resolved_at: row.resolved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toDsrAdminDetailDto(
  row: DsrAdminRow,
  requester: DsrAdminDetailDto['requester'],
  now: Date,
): DsrAdminDetailDto {
  return {
    ...toDsrAdminSummaryDto(row, requester?.nickname ?? null, now),
    details: row.details,
    verification_method: row.verification_method,
    verification_sent_at: row.verification_sent_at,
    verification_expires_at: row.verification_expires_at,
    verification_send_count: row.verification_send_count,
    response_note: row.response_note,
    admin_notes: row.admin_notes,
    requester,
  };
}

/**
 * 監査ログの対象 (operator/07 §4.1.1 と inquiryAuditTarget と同じ規則)。
 * 本人がいる請求は本人 (target_type = 'user') を対象にし、退会済み (user_id が NULL) は請求そのものを対象にする。
 * 請求の id はどちらでも details.request_id に入れる
 */
export function dsrAuditTarget(row: Pick<DsrRow, 'id' | 'user_id'>): {
  targetId: string;
  targetType: 'user' | 'data_subject_request';
} {
  return row.user_id
    ? { targetId: row.user_id, targetType: 'user' }
    : { targetId: row.id, targetType: 'data_subject_request' };
}
