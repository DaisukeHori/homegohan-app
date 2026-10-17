/**
 * パスワードの変更・再設定の API (POST /api/auth/password/change・/reset) の共通部品 (#1198)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §14.6・§14.7・§19。
 *
 * 2 本の route は「入力の検証 → 認証 → 回数制限 → 世代数 → performPasswordChange → 結果の応答」の筋が同じで、違いは
 * 現在のパスワードの有無・再設定の認可・結果の対応だけなので、同じ部品を通す (片方だけ直し忘れない)。
 * 応答は /api/auth/sessions と同じ flat の本文 { error, code } + Cache-Control: private, no-store (sessions/route-support.ts を使う)。
 * 本文に GoTrue・DB の生の文、パスワードを入れない (4xx はこちらで決めた固定の文 §19、5xx は internalError)。
 * サーバー専用 (next/server・getSupabaseAdmin)。画面 (client component) からは import しない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { validatePassword } from '@homegohan/shared';
import { internalError } from '@/lib/api/errors';
import { checkRateLimit, rateLimitExceededResponse, type RateLimitCategory } from '@/lib/rate-limit';
import {
  performPasswordChange,
  type PasswordChangeResult,
  type PasswordCheckOutcome,
} from '@/lib/auth/password/change';
import { updatePasswordWithAccessToken } from '@/lib/auth/password/gotrue-user';
import { passwordHistoryGenerationsFor } from '@/lib/auth/password/policy';
import { SESSIONS_NO_STORE_HEADERS, sessionsJson } from '@/lib/auth/sessions/route-support';
import type { SessionUserContext } from '@/lib/auth/sessions/session-claims';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE_ENTITY = 422;

/** §19 の固定の文 (本書の段 C の code と、段 C の route が返す既存の code) */
export const PASSWORD_ERROR_MESSAGES = {
  VALIDATION_ERROR: '入力の内容を確認してください。',
  AUTH_CURRENT_PASSWORD_MISMATCH: '現在のパスワードが正しくありません。',
  AUTH_RECOVERY_SESSION_REQUIRED: 'パスワードの再設定は、再設定メールのリンクから開き直してください。',
  AUTH_REAUTHENTICATION_REQUIRED: '安全のため、もう一度ログインしてから変更してください。',
  AUTH_PASSWORD_NOT_SET: 'このアカウントはパスワードでログインしていないため、変更できません。',
  /** unsupported_hash (比べられない形のパスワード) の文 (§14.6 の 5)。code は AUTH_PASSWORD_NOT_SET と同じ */
  AUTH_PASSWORD_NOT_SET_UNSUPPORTED: 'この方法では変更できません。お問い合わせください。',
  /** GoTrue が weak_password を返したとき (validatePassword を通った後に GoTrue 側の規則 (流出の確認など) で断られた) の文 */
  VALID_PASSWORD_WEAK: 'このパスワードは安全性の基準を満たしていません。別のパスワードにしてください。',
  VALID_PASSWORD_HISTORY: '最近使ったパスワードは使えません。別のパスワードにしてください。',
  /** 新しいパスワードが現在のパスワードと同じ (入力の段で断る §14.6 の 1) */
  VALID_PASSWORD_HISTORY_SAME_AS_CURRENT: '新しいパスワードは、現在のパスワードと違うものにしてください。',
} as const;

/** 変更 (現在のパスワードを確かめる) か、再設定 (メールのリンクで作ったセッション) か */
export type PasswordRouteMode = 'change' | 'reset';

/** 呼び出し口ごとの回数制限のカテゴリ (§12.6) */
const RATE_LIMIT_CATEGORY: Record<PasswordRouteMode, RateLimitCategory> = {
  change: 'auth-password-change',
  reset: 'auth-password-reset',
};

/** 戻りの文字列を絞る (RPC auth_password_check §11.5) */
const PasswordCheckOutcomeSchema = z.enum(['ok', 'current_mismatch', 'reused', 'no_password', 'unsupported_hash']);

/** RPC の失敗 (値・DB の英文は持たない。パスワードは引数にあるのでエラーに載せない) */
export class PasswordCheckRpcError extends Error {
  constructor(readonly rpcCode: string | null) {
    super('auth_password_check を呼べませんでした');
    this.name = 'PasswordCheckRpcError';
  }
}

/** GoTrue の PUT /user が (想定外の) 失敗を返した。code・status だけを持つ (英文・パスワードは持たない) */
export class PasswordUpdateUpstreamError extends Error {
  constructor(readonly gotrueCode: string | null, readonly gotrueStatus: number | null) {
    super('GoTrue のパスワードの更新が失敗しました');
    this.name = 'PasswordUpdateUpstreamError';
  }
}

/** どの段で例外になったか (app_logs の metadata.stage。値・英文は入れない) */
type PasswordStage = 'rate-limit' | 'password-check' | 'password-update';

/** 500 INTERNAL_ERROR (no-store 付き)。元の例外は app_logs にだけ残り、本文は固定の文。stage で RPC の失敗と GoTrue の呼び出しの失敗を見分ける */
function passwordInternalError(routeName: string, error: unknown, userId: string, stage: PasswordStage): NextResponse {
  const response = internalError(routeName, error, { userId, stage });
  for (const [name, value] of Object.entries(SESSIONS_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/** 400/403/409/422 の固定の文の応答 */
function passwordError(code: keyof typeof PASSWORD_ERROR_MESSAGES, status: number, message?: string): NextResponse {
  return sessionsJson({ error: message ?? PASSWORD_ERROR_MESSAGES[code], code }, status);
}

/** 400 VALIDATION_ERROR (本文の形) */
export function passwordValidationError(): NextResponse {
  return passwordError('VALIDATION_ERROR', HTTP_BAD_REQUEST);
}

/** 422 VALID_PASSWORD_WEAK (validatePassword の理由 = こちらが書いた文) */
export function passwordWeakFromRule(reason: string): NextResponse {
  return passwordError('VALID_PASSWORD_WEAK', HTTP_UNPROCESSABLE_ENTITY, reason);
}

/** 422 VALID_PASSWORD_HISTORY (新しいパスワードが現在のパスワードと同じ) */
export function passwordSameAsCurrent(): NextResponse {
  return passwordError('VALID_PASSWORD_HISTORY', HTTP_UNPROCESSABLE_ENTITY, PASSWORD_ERROR_MESSAGES.VALID_PASSWORD_HISTORY_SAME_AS_CURRENT);
}

/** 403 AUTH_RECOVERY_SESSION_REQUIRED (再設定の認可。メールのリンク / コードで作ったセッションではない) */
export function passwordRecoverySessionRequired(): NextResponse {
  return passwordError('AUTH_RECOVERY_SESSION_REQUIRED', HTTP_FORBIDDEN);
}

/** 入力の検証の共通: 新しいパスワードの規則 (packages/shared の validatePassword)。違えば 422 VALID_PASSWORD_WEAK、満たせば null */
export function rejectWeakPassword(newPassword: string): NextResponse | null {
  const reason = validatePassword(newPassword);
  return reason === null ? null : passwordWeakFromRule(reason);
}

/** 429 RATE_LIMITED + Retry-After (no-store 付き) */
function passwordRateLimited(result: Parameters<typeof rateLimitExceededResponse>[0]): NextResponse {
  const response = rateLimitExceededResponse(result);
  for (const [name, value] of Object.entries(SESSIONS_NO_STORE_HEADERS)) response.headers.set(name, value);
  return response;
}

/** admin.rpc('auth_password_check') の戻りを PasswordCheckOutcome に絞る。error・知らない値は例外 */
export async function checkPasswordViaRpc(
  admin: SupabaseClient,
  input: { userId: string; currentPassword: string | null; newPassword: string; generations: number },
): Promise<PasswordCheckOutcome> {
  const { data, error } = await admin.rpc('auth_password_check', {
    p_user_id: input.userId,
    p_current_password: input.currentPassword,
    p_new_password: input.newPassword,
    p_generations: input.generations,
  });
  if (error) throw new PasswordCheckRpcError(error.code ?? null);
  const parsed = PasswordCheckOutcomeSchema.safeParse(data);
  if (!parsed.success) throw new PasswordCheckRpcError(null);
  return parsed.data;
}

/** performPasswordChange の結果を応答にする (§14.6 の 5・§14.7 の 5)。再設定で起き得ない結果 (§11.5 の行 6・7) は 500 */
function responseOfResult(
  mode: PasswordRouteMode,
  result: PasswordChangeResult,
  routeName: string,
  userId: string,
): NextResponse {
  switch (result.kind) {
    case 'changed':
      return sessionsJson({ ok: true });
    case 'reused':
      return passwordError('VALID_PASSWORD_HISTORY', HTTP_UNPROCESSABLE_ENTITY);
    case 'weak':
      return passwordError('VALID_PASSWORD_WEAK', HTTP_UNPROCESSABLE_ENTITY);
    case 'reauthentication_required':
      return passwordError('AUTH_REAUTHENTICATION_REQUIRED', HTTP_FORBIDDEN);
    case 'current_mismatch':
      if (mode === 'change') return passwordError('AUTH_CURRENT_PASSWORD_MISMATCH', HTTP_BAD_REQUEST);
      return unexpectedResult(routeName, result.kind, userId);
    case 'no_password':
      if (mode === 'change') return passwordError('AUTH_PASSWORD_NOT_SET', HTTP_CONFLICT);
      return unexpectedResult(routeName, result.kind, userId);
    case 'unsupported_hash':
      if (mode === 'change') {
        return passwordError('AUTH_PASSWORD_NOT_SET', HTTP_CONFLICT, PASSWORD_ERROR_MESSAGES.AUTH_PASSWORD_NOT_SET_UNSUPPORTED);
      }
      return unexpectedResult(routeName, result.kind, userId);
    case 'upstream-error':
      return passwordInternalError(routeName, new PasswordUpdateUpstreamError(result.code, result.status), userId, 'password-update');
  }
}

/** 再設定では起き得ない結果 (§14.7)。起きたら internalError */
function unexpectedResult(routeName: string, kind: string, userId: string): NextResponse {
  return passwordInternalError(routeName, new Error(`再設定で起き得ない結果: ${kind}`), userId, 'password-check');
}

export interface ExecutePasswordUpdateInput {
  mode: PasswordRouteMode;
  routeName: string;
  ctx: SessionUserContext;
  /** 変更なら本文の current_password、再設定なら null */
  currentPassword: string | null;
  newPassword: string;
  admin: SupabaseClient;
}

/**
 * 回数制限 → 世代数 → performPasswordChange → 応答 (§14.6 の 2〜6)。呼ぶ前に、入力の検証・requireSessionUser (・再設定なら認可) を済ませる。
 * - 回数制限の key は認証で確定した user.id (超過は 429 + Retry-After)
 * - 世代数は ctx.roles (requireSessionUser が読んだ本人の行の roles。行が無ければ [] で 3 世代)。user_profiles は自分で読まない
 * - GoTrue は本人の access token で呼ぶ (createClient() の auth.updateUser は使わない §13.7)。他の端末の失効は GoTrue が更新と同じ
 *   トランザクションで行うので、route は signOut を呼ばない (§14.6 の 6)
 * - RPC の例外・通信の失敗は 500 (internalError。stage = rate-limit / password-check / password-update。本文は固定の文)
 */
export async function executePasswordUpdate(input: ExecutePasswordUpdateInput): Promise<NextResponse> {
  const { mode, routeName, ctx, currentPassword, newPassword, admin } = input;
  let stage: PasswordStage = 'rate-limit';
  try {
    const rateLimit = await checkRateLimit(ctx.user.id, RATE_LIMIT_CATEGORY[mode]);
    if (!rateLimit.success) return passwordRateLimited(rateLimit);

    const generations = passwordHistoryGenerationsFor(ctx.roles);
    const result = await performPasswordChange(
      { userId: ctx.user.id, currentPassword, newPassword, generations },
      {
        checkPassword: (checkInput) => {
          stage = 'password-check';
          return checkPasswordViaRpc(admin, checkInput);
        },
        updatePassword: (update) => {
          stage = 'password-update';
          return updatePasswordWithAccessToken(ctx.session.accessToken, update.newPassword, update.currentPassword);
        },
      },
    );
    return responseOfResult(mode, result, routeName, ctx.user.id);
  } catch (err) {
    return passwordInternalError(routeName, err, ctx.user.id, stage);
  }
}
