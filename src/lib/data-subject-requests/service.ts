/**
 * #1178 個人情報の請求 (DSR) の DB の読み書き (設計 cross/15 §6・§7)。サーバー専用。
 * route はこのファイルの関数だけを呼び、from('data_subject_requests') を直接書かない。
 *
 * - 書き込み (INSERT / UPDATE) は service_role の client (DsrAdminClient) だけ。route が認証・認可を通したあとに渡す。
 * - 読み取りの経路 (§3.1):
 *   - 本人の一覧・詳細と運営の一覧は本人のセッションの client (DsrUserClient。RLS と列の GRANT が効く)。
 *     本人の一覧・詳細は必ず .eq('user_id', userId) で絞る (admin / super_admin の本人には RLS が全行を見せるため)。
 *   - admin_notes を含む運営の詳細・更新と、本人の verify / resend / withdraw の対象の読み取りは service_role の client。
 * - 本人の 3 つの UPDATE (verify / resend / withdraw) は「読んだときの状態」を条件に付け、0 行なら 409 DSR_INVALID_STATE
 *   (メールは送らない)。表 §8.3 に無い遷移を作らない。
 * - 失敗は固定のコードと HTTP ステータスで返す。DB の生のエラー文は結果に入れない (cause に入れ、route がログに残す)。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchNicknames } from '@/lib/admin/inquiries';
import { fetchUserEmails } from '@/lib/admin/user-emails';
import { getSiteUrl } from '@/lib/site-config';
import {
  DSR_ACTIONABLE_STATUSES,
  DSR_ADMIN_COLUMNS,
  DSR_ADMIN_LIST_COLUMNS,
  DSR_OPEN_STATUSES,
  DSR_OWN_COLUMNS,
  DSR_OWN_LIST_LIMIT,
  DSR_REQUESTER_ACTION_COLUMNS,
  DSR_VERIFICATION_MAX_SENDS,
  DSR_VERIFICATION_METHOD,
  canWithdrawDsr,
  computeDsrDueAt,
  computeDsrVerificationExpiresAt,
  dsrRequiresResponseNote,
  findDsrTransition,
  isDsrTerminal,
  isDsrVerificationExpired,
  normalizeDsrNote,
  toDsrAdminDetailDto,
  toDsrAdminSummaryDto,
  toDsrOwnDto,
  type DsrAdminDetailDto,
  type DsrAdminListQuery,
  type DsrAdminRow,
  type DsrAdminSummaryDto,
  type DsrAdminUpdateInput,
  type DsrCreateInput,
  type DsrErrorCode,
  type DsrOwnDto,
  type DsrRow,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';
import { dsrTokenMatches, generateDsrVerificationToken } from '@/lib/data-subject-requests/tokens';
import {
  sendDsrOperatorNotice,
  sendDsrReceivedEmail,
  sendDsrResolvedEmail,
  sendDsrVerificationEmail,
} from '@/lib/data-subject-requests/notifications';

/**
 * 書き込み・運営の詳細の読み取り・宛先の取得に使う service_role の client (lib/supabase/server.ts の getSupabaseAdmin() の戻り値)。
 * 認証・認可のあとにだけ渡す。Pick にしないのは、既存の fetchUserEmails(admin: SupabaseClient, ...) (src/lib/admin/user-emails.ts) に
 * そのまま渡すため (Pick<SupabaseClient, ...> は SupabaseClient に代入できない)。テストのモックは `as unknown as SupabaseClient` で渡す
 */
export type DsrAdminClient = SupabaseClient;
/** 本人の一覧・詳細と運営の一覧の読み取りに使う本人のセッションの client (lib/supabase/server.ts の createClient() の戻り値)。RLS と列の GRANT が効く */
export type DsrUserClient = SupabaseClient;
/** db-logger の createLogger(...).withUser(...) と同じ最小の形 */
export interface DsrLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}

/**
 * 失敗は固定のコードと HTTP ステータスで返す (DB の生のエラー文は入れない。route は code を本文に、cause はログに)。
 * status と code の組は §13 のエラー表のとおり: 400 = DSR_VERIFICATION_INVALID (verifyDsr だけ) / 404 = NOT_FOUND /
 * 409 = DSR_ALREADY_OPEN・DSR_INVALID_STATE・DSR_VERIFICATION_LIMIT・DSR_INVALID_TRANSITION・CONFLICT_STALE_DATA /
 * 410 = DSR_VERIFICATION_EXPIRED / 412 = CONFLICT_OPTIMISTIC_LOCK / 422 = DSR_RESPONSE_NOTE_REQUIRED /
 * 428 = CONFLICT_PRECONDITION_REQUIRED / 500 = INTERNAL_ERROR。
 * 本文の形の検査 (INVALID_CHARACTER・INVALID_JSON・VALIDATION_ERROR の 400) と認証・認可 (401 / 403) は route が service を呼ぶ前に行う
 */
export type DsrServiceResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 404 | 409 | 410 | 412 | 422 | 428 | 500;
      code:
        | DsrErrorCode
        | 'NOT_FOUND'
        | 'CONFLICT_OPTIMISTIC_LOCK'
        | 'CONFLICT_STALE_DATA'
        | 'CONFLICT_PRECONDITION_REQUIRED'
        | 'INTERNAL_ERROR';
      cause?: unknown;
    };

type DsrServiceFailure = Extract<DsrServiceResult<never>, { ok: false }>;

export interface DsrContext {
  now: Date;
  requestId: string;
  log: DsrLogger;
}

/** 表の名前 (migration の CREATE TABLE と同じ) */
const DSR_TABLE = 'data_subject_requests';
/** 部分一意索引 data_subject_requests_one_open_per_type に当たったときの SQLSTATE (unique_violation) */
const PG_UNIQUE_VIOLATION = '23505';
/** 件数より後ろのページを PostgREST が返すときのコード (ローカルでは本文が切れて code が取れないので HTTP 416 でも見る) */
const POSTGREST_RANGE_NOT_SATISFIABLE = 'PGRST103';
const HTTP_RANGE_NOT_SATISFIABLE = 416;
/** 運営の詳細でメールアドレスを引くときのログの発生元 (fetchUserEmails の logSource) */
const OPERATOR_DETAIL_LOG_SOURCE = 'GET /api/admin/data-requests/[id]';

/** service_role で DSR_OWN_COLUMNS を読んだ行 (本人に返す列。hash と admin_notes を含まない) */
type DsrOwnRow = Omit<DsrRow, 'verification_token_hash' | 'admin_notes'>;
/** service_role で DSR_REQUESTER_ACTION_COLUMNS を読んだ行 (判定に hash を使う。応答には入れない) */
type DsrRequesterActionRow = Omit<DsrRow, 'admin_notes'>;
/** 運営の一覧が DSR_ADMIN_LIST_COLUMNS で読んだ行 */
type DsrAdminListRow = Pick<
  DsrRow,
  'id' | 'user_id' | 'request_type' | 'status' | 'verified_at' | 'due_at' | 'resolved_at' | 'created_at' | 'updated_at'
>;

/**
 * PostgREST の応答の行を、読んだ列 (DSR_*_COLUMNS) の型として扱う。列の一覧を文字列の連結で組み立てているので、
 * supabase-js は行の型を推論できない (GenericStringError になる)。列の一覧と行の型の対応は core.test.ts と契約テストが固定する
 */
function rowsAs<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}
function rowAs<T>(data: unknown): T {
  return data as T;
}

function ok<T>(data: T): DsrServiceResult<T> {
  return { ok: true, data };
}

function fail(status: DsrServiceFailure['status'], code: DsrServiceFailure['code'], cause?: unknown): DsrServiceFailure {
  return cause === undefined ? { ok: false, status, code } : { ok: false, status, code, cause };
}

function internalFailure(cause: unknown): DsrServiceFailure {
  return fail(500, 'INTERNAL_ERROR', cause);
}

/** PostgREST のエラーの SQLSTATE (code) */
function pgCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** 本人の verify / resend / withdraw が判定の前に読む 1 行 (service_role。本人の行だけ) */
async function readRequesterActionRow(
  admin: DsrAdminClient,
  userId: string,
  id: string,
): Promise<DsrServiceResult<DsrRequesterActionRow>> {
  const { data, error } = await admin
    .from(DSR_TABLE)
    .select(DSR_REQUESTER_ACTION_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(404, 'NOT_FOUND');
  return ok(rowAs<DsrRequesterActionRow>(data));
}

// ─────────────────────────────────────────────────────────────────────────────
// 本人
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本人の請求の一覧。本人のセッションの client で .select(DSR_OWN_COLUMNS).eq('user_id', userId) を新しい順に最大 DSR_OWN_LIST_LIMIT 件。
 * .eq('user_id', userId) は省かない (admin / super_admin の本人には RLS data_subject_requests_select_operator が全行を見せる。§3.1)
 */
export async function listOwnDsr(
  user: DsrUserClient,
  userId: string,
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto[]>> {
  const { data, error } = await user
    .from(DSR_TABLE)
    .select(DSR_OWN_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DSR_OWN_LIST_LIMIT);
  if (error) return internalFailure(error);
  const rows = rowsAs<DsrOwnRow>(data);
  return ok(rows.map((row) => toDsrOwnDto(row, ctx.now)));
}

/**
 * 本人の請求の詳細。本人のセッションの client で .eq('id', id).eq('user_id', userId) を付けて読む。null なら 404 NOT_FOUND
 * (無い行・他人の行・退会済みの行。admin / super_admin の本人にも他人の id は 404)
 */
export async function getOwnDsr(
  user: DsrUserClient,
  userId: string,
  id: string,
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto>> {
  const { data, error } = await user
    .from(DSR_TABLE)
    .select(DSR_OWN_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(404, 'NOT_FOUND');
  return ok(toDsrOwnDto(rowAs<DsrOwnRow>(data), ctx.now));
}

/** 行を作り、本人確認メールを送る (メールは best-effort: 失敗しても行は返す)。23505 は 409 DSR_ALREADY_OPEN */
export async function createDsr(
  admin: DsrAdminClient,
  params: { userId: string; input: DsrCreateInput; siteUrl: string },
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto>> {
  const { token, tokenHash } = generateDsrVerificationToken();
  const sentAt = ctx.now;
  const { data, error } = await admin
    .from(DSR_TABLE)
    .insert({
      user_id: params.userId,
      request_type: params.input.request_type,
      details: params.input.details,
      verification_method: DSR_VERIFICATION_METHOD,
      verification_token_hash: tokenHash,
      verification_sent_at: sentAt.toISOString(),
      verification_expires_at: computeDsrVerificationExpiresAt(sentAt).toISOString(),
      verification_send_count: 1,
    })
    .select(DSR_OWN_COLUMNS)
    .single();
  if (error) {
    if (pgCodeOf(error) === PG_UNIQUE_VIOLATION) return fail(409, 'DSR_ALREADY_OPEN', error);
    return internalFailure(error);
  }
  const row = rowAs<DsrOwnRow>(data);
  await sendDsrVerificationEmail(admin, row, token, params.siteUrl, ctx.log);
  return ok(toDsrOwnDto(row, ctx.now));
}

/**
 * トークンを突き合わせて受付にする (§7.2 の順序): 行を読む (無ければ 404) → pending_verification でなければ 409 DSR_INVALID_STATE →
 * 期限切れ 410 → 不一致 400 → 状態と hash を条件にした UPDATE (0 行なら 409 DSR_INVALID_STATE・メールなし) →
 * メール dsr_received (本人)・dsr_operator_notice (運営)。リンクの組み立ては getSiteUrl()
 */
export async function verifyDsr(
  admin: DsrAdminClient,
  params: { userId: string; id: string; token: string; dueDays: number },
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto>> {
  const read = await readRequesterActionRow(admin, params.userId, params.id);
  if (!read.ok) return read;
  const row = read.data;
  if (row.status !== 'pending_verification') return fail(409, 'DSR_INVALID_STATE');
  if (isDsrVerificationExpired(row, ctx.now)) return fail(410, 'DSR_VERIFICATION_EXPIRED');
  const storedHash = row.verification_token_hash;
  if (!storedHash || !dsrTokenMatches(params.token, storedHash)) return fail(400, 'DSR_VERIFICATION_INVALID');

  const verifiedAt = ctx.now;
  const { data, error } = await admin
    .from(DSR_TABLE)
    .update({
      status: 'received',
      verified_at: verifiedAt.toISOString(),
      due_at: computeDsrDueAt(verifiedAt, params.dueDays).toISOString(),
      verification_token_hash: null,
    })
    .eq('id', params.id)
    .eq('user_id', params.userId)
    .eq('status', 'pending_verification')
    .eq('verification_token_hash', storedHash)
    .select(DSR_OWN_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(409, 'DSR_INVALID_STATE');

  const updated = rowAs<DsrOwnRow>(data);
  const siteUrl = getSiteUrl();
  await Promise.all([
    sendDsrReceivedEmail(admin, updated, siteUrl, ctx.log),
    sendDsrOperatorNotice(updated, siteUrl, ctx.log),
  ]);
  return ok(toDsrOwnDto(updated, ctx.now));
}

/**
 * 新しいトークンで確認メールを送り直す: 行を読む (無ければ 404) → pending_verification でなければ 409 DSR_INVALID_STATE →
 * 送信回数が上限なら 409 DSR_VERIFICATION_LIMIT → 状態と送信回数を条件にした UPDATE (0 行なら 409 DSR_INVALID_STATE・メールなし) →
 * 1 行のときだけ確認メールを送る。期限切れかどうかは問わない
 */
export async function resendDsrVerification(
  admin: DsrAdminClient,
  params: { userId: string; id: string; siteUrl: string },
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto>> {
  const read = await readRequesterActionRow(admin, params.userId, params.id);
  if (!read.ok) return read;
  const row = read.data;
  if (row.status !== 'pending_verification') return fail(409, 'DSR_INVALID_STATE');
  if (row.verification_send_count >= DSR_VERIFICATION_MAX_SENDS) return fail(409, 'DSR_VERIFICATION_LIMIT');

  const { token, tokenHash } = generateDsrVerificationToken();
  const sentAt = ctx.now;
  const { data, error } = await admin
    .from(DSR_TABLE)
    .update({
      verification_token_hash: tokenHash,
      verification_sent_at: sentAt.toISOString(),
      verification_expires_at: computeDsrVerificationExpiresAt(sentAt).toISOString(),
      verification_send_count: row.verification_send_count + 1,
    })
    .eq('id', params.id)
    .eq('user_id', params.userId)
    .eq('status', 'pending_verification')
    .eq('verification_send_count', row.verification_send_count)
    .select(DSR_OWN_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(409, 'DSR_INVALID_STATE');

  const updated = rowAs<DsrOwnRow>(data);
  await sendDsrVerificationEmail(admin, updated, token, params.siteUrl, ctx.log);
  return ok(toDsrOwnDto(updated, ctx.now));
}

/**
 * 開いている請求を取り下げる (メールは送らない): 行を読む (無ければ 404) → 終わっていれば 409 DSR_INVALID_STATE →
 * 開いている状態を条件にした UPDATE (0 行なら 409 DSR_INVALID_STATE。判定の後に運営が対応済み・却下にした記録を上書きしない)
 */
export async function withdrawDsr(
  admin: DsrAdminClient,
  params: { userId: string; id: string },
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrOwnDto>> {
  const read = await readRequesterActionRow(admin, params.userId, params.id);
  if (!read.ok) return read;
  if (!canWithdrawDsr(read.data.status)) return fail(409, 'DSR_INVALID_STATE');

  const { data, error } = await admin
    .from(DSR_TABLE)
    .update({
      status: 'withdrawn',
      resolved_at: ctx.now.toISOString(),
      verification_token_hash: null,
    })
    .eq('id', params.id)
    .eq('user_id', params.userId)
    .in('status', [...DSR_OPEN_STATUSES])
    .select(DSR_OWN_COLUMNS)
    .maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(409, 'DSR_INVALID_STATE');
  return ok(toDsrOwnDto(rowAs<DsrOwnRow>(data), ctx.now));
}

// ─────────────────────────────────────────────────────────────────────────────
// 運営 (route が requireRole(DSR_OPERATOR_ROLES) を通したあとに呼ぶ)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 運営の一覧。本人のセッションの client (RLS data_subject_requests_select_operator・列の GRANT の中の DSR_ADMIN_LIST_COLUMNS) で読む。
 * 並びは due_at 昇順 (NULL は最後) → created_at 降順 → id 降順。overdue=1 は received / in_progress かつ due_at < now。
 * 件数より後ろのページ (416) は空のページ (total: null)。ニックネームは fetchNicknames
 */
export async function listDsrForOperator(
  user: DsrUserClient,
  params: { query: DsrAdminListQuery; page: number; perPage: number },
  ctx: DsrContext,
): Promise<DsrServiceResult<{ rows: DsrAdminSummaryDto[]; total: number | null }>> {
  const from = (params.page - 1) * params.perPage;
  let query = user
    .from(DSR_TABLE)
    .select(DSR_ADMIN_LIST_COLUMNS, { count: 'exact' })
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + params.perPage - 1);
  if (params.query.status) query = query.eq('status', params.query.status);
  if (params.query.request_type) query = query.eq('request_type', params.query.request_type);
  if (params.query.overdue === '1') {
    query = query.in('status', [...DSR_ACTIONABLE_STATUSES]).lt('due_at', ctx.now.toISOString());
  }

  const { data, error, count, status: httpStatus } = await query;
  const beyondLastPage =
    !!error && (httpStatus === HTTP_RANGE_NOT_SATISFIABLE || pgCodeOf(error) === POSTGREST_RANGE_NOT_SATISFIABLE);
  if (error && !beyondLastPage) return internalFailure(error);

  const rows = beyondLastPage ? [] : rowsAs<DsrAdminListRow>(data);
  const names = await fetchNicknames(
    rows.map((row) => row.user_id),
    ctx.log,
  );
  const summaries = rows.map((row) =>
    toDsrAdminSummaryDto(row, row.user_id ? (names.get(row.user_id) ?? null) : null, ctx.now),
  );
  return ok({ rows: summaries, total: beyondLastPage ? null : (count ?? summaries.length) });
}

/** 運営の詳細。admin_notes を含むので service_role の client で DSR_ADMIN_COLUMNS を読む。メールアドレスは fetchUserEmails */
export async function getDsrForOperator(
  admin: DsrAdminClient,
  id: string,
  ctx: DsrContext,
): Promise<DsrServiceResult<DsrAdminDetailDto>> {
  const { data, error } = await admin.from(DSR_TABLE).select(DSR_ADMIN_COLUMNS).eq('id', id).maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return fail(404, 'NOT_FOUND');
  const row = rowAs<DsrAdminRow>(data);

  let requester: DsrAdminDetailDto['requester'] = null;
  if (row.user_id) {
    const [names, emails] = await Promise.all([
      fetchNicknames([row.user_id], ctx.log),
      fetchUserEmails(admin, [row.user_id], OPERATOR_DETAIL_LOG_SOURCE),
    ]);
    requester = {
      user_id: row.user_id,
      nickname: names.get(row.user_id) ?? null,
      email: emails.get(row.user_id) ?? null,
    };
  }
  return ok(toDsrAdminDetailDto(row, requester, ctx.now));
}

/**
 * 運営の更新 (読み直しも UPDATE も service_role の client で DSR_ADMIN_COLUMNS)。順に:
 * ifUnmodifiedSince が無い → 428 / 行が無い → 404 / updated_at ≠ ヘッダ → 412 /
 * 行の状態が received / in_progress に無い → 409 DSR_INVALID_TRANSITION (status の有無を問わない) /
 * status を指定し遷移表に無い (同じ状態の指定を含む) → 409 DSR_INVALID_TRANSITION /
 * fulfilled・rejected で更新後の response_note が空 → 422 / UPDATE が 0 行 → 409 CONFLICT_STALE_DATA。
 * 変更が無ければ書き込まない。fulfilled / rejected になったら dsr_resolved を送る (user_id が NULL なら送らず info ログ)
 */
export async function updateDsrByOperator(
  admin: DsrAdminClient,
  params: { id: string; ifUnmodifiedSince: string | null; input: DsrAdminUpdateInput },
  ctx: DsrContext,
): Promise<
  DsrServiceResult<{
    before: DsrAdminRow;
    after: DsrAdminRow;
    changed: { status: boolean; response_note: boolean; admin_notes: boolean };
  }>
> {
  const ifUnmodifiedSince = params.ifUnmodifiedSince?.trim() ?? '';
  if (ifUnmodifiedSince === '') return fail(428, 'CONFLICT_PRECONDITION_REQUIRED');

  const { data: current, error: readError } = await admin
    .from(DSR_TABLE)
    .select(DSR_ADMIN_COLUMNS)
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return internalFailure(readError);
  if (!current) return fail(404, 'NOT_FOUND');
  const before = rowAs<DsrAdminRow>(current);
  if (before.updated_at !== ifUnmodifiedSince) return fail(412, 'CONFLICT_OPTIMISTIC_LOCK');
  if (!DSR_ACTIONABLE_STATUSES.includes(before.status)) return fail(409, 'DSR_INVALID_TRANSITION');

  const { input } = params;
  if (input.status !== undefined && !findDsrTransition('operator', before.status, input.status)) {
    return fail(409, 'DSR_INVALID_TRANSITION');
  }
  const nextStatus: DsrStatus = input.status ?? before.status;
  const nextResponseNote =
    input.response_note === undefined ? before.response_note : normalizeDsrNote(input.response_note);
  const nextAdminNotes = input.admin_notes === undefined ? before.admin_notes : normalizeDsrNote(input.admin_notes);
  if (dsrRequiresResponseNote(nextStatus) && normalizeDsrNote(nextResponseNote) === null) {
    return fail(422, 'DSR_RESPONSE_NOTE_REQUIRED');
  }

  const changed = {
    status: nextStatus !== before.status,
    response_note: nextResponseNote !== before.response_note,
    admin_notes: nextAdminNotes !== before.admin_notes,
  };
  if (!changed.status && !changed.response_note && !changed.admin_notes) {
    return ok({ before, after: before, changed });
  }

  const patch: Partial<Pick<DsrRow, 'status' | 'response_note' | 'admin_notes' | 'resolved_at'>> = {};
  if (changed.status) {
    patch.status = nextStatus;
    // 対応済み / 対応できず (運営が作れる終わりの状態) にしたときだけ、終わった時刻を入れる
    if (isDsrTerminal(nextStatus)) patch.resolved_at = ctx.now.toISOString();
  }
  if (changed.response_note) patch.response_note = nextResponseNote;
  if (changed.admin_notes) patch.admin_notes = nextAdminNotes;

  const { data: written, error: writeError } = await admin
    .from(DSR_TABLE)
    .update(patch)
    .eq('id', params.id)
    .eq('updated_at', ifUnmodifiedSince)
    .select(DSR_ADMIN_COLUMNS)
    .maybeSingle();
  if (writeError) return internalFailure(writeError);
  if (!written) return fail(409, 'CONFLICT_STALE_DATA');
  const after = rowAs<DsrAdminRow>(written);

  if (changed.status && (after.status === 'fulfilled' || after.status === 'rejected')) {
    await sendDsrResolvedEmail(admin, after, getSiteUrl(), ctx.log);
  }
  return ok({ before, after, changed });
}
