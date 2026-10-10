/**
 * アカウント削除 (退会) の本体 (#1175)。POST /api/account/delete と、今後の確認リンク方式 (作業計画 T20) が呼ぶ。
 *
 * 呼び出し側の責任:
 *   - userId の持ち主を、呼ぶ前に確認すること (ログイン中の本人、または本人宛の確認リンクの検証済みトークン)。
 *     admin は service_role の client で RLS を通らない。認証の前に呼んではいけない。
 *   - confirm の確認 (`confirm: true`) など、入口の検証。
 *
 * 流れ (どの段階も、やり直して何度流しても同じ結果になる。途中で失敗したら、そこで止めて ACCOUNT_DELETE_FAILED を返す):
 *   1. 組織のオーナー / 家族の代表者なら 409 で止める (譲渡か解散が先)。
 *   2. prepare_account_deletion (DB 関数): 本人の生のメールアドレスを残す記録 (メール配信ログ・問い合わせ・招待) を伏せる。
 *   3. release_user_membership (DB 関数): 組織のライセンス席を解放する。失敗しても削除は続ける (要手動リコンサイル)。
 *   4. Storage のファイルを消す (src/lib/account-deletion-storage.ts)。
 *   5. auth.admin.deleteUser。public 側の個人データは外部キーの CASCADE / SET NULL で消える・匿名化される
 *      (20261010000100_auth_users_fk_on_delete.sql。外部キーで失敗する経路は無い)。
 *
 * 2〜4 を 5 より先に行うのは、削除したあとでは本人の user_id でファイルや記録を探せないため。
 * 5 が失敗したら、2〜4 は済んでいてもアカウントは残る。もう一度削除を実行すれば、残りが片付いて削除できる。
 *
 * ログは src/lib/db-logger.ts (app_logs) に残す。メールアドレスは載せない (db-logger のマスクに頼らず、そもそも渡さない)。
 * 失敗 (ACCOUNT_DELETE_FAILED) は HTTP の応答にしない。呼び出し側 (route) が #1172 の規則どおり internalError
 * (src/lib/api/errors.ts。汎用メッセージだけの 500) で返す。調査は結果の request_id と step で app_logs を探す。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { removeAccountStorage } from '@/lib/account-deletion-storage';

/** どの段階で失敗したか (ログ用。応答には出さない) */
export type AccountDeletionStep =
  | 'init'
  | 'check_blockers'
  | 'prepare'
  | 'release_membership'
  | 'storage'
  | 'delete_user';

export type AccountDeletionErrorCode =
  | 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER'
  | 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE'
  | 'ACCOUNT_DELETE_FAILED';

export type DeleteAccountResult =
  | { ok: true }
  | {
      ok: false;
      status: 409;
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER';
      message: string;
      organization: { id: string; name: string };
    }
  | {
      ok: false;
      status: 409;
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE';
      message: string;
      family_group: { id: string; name: string };
    }
  | {
      ok: false;
      status: 500;
      error: 'ACCOUNT_DELETE_FAILED';
      /** app_logs の request_id と同じ値 (調査用。HTTP の応答には含めない) */
      request_id: string;
      /** 失敗した段階 (ログ・テスト用。HTTP の応答には含めない) */
      step: AccountDeletionStep;
    };

export type DeleteAccountFailure = Extract<DeleteAccountResult, { error: 'ACCOUNT_DELETE_FAILED' }>;

/** 失敗 (500) 以外の結果。accountDeletionHttp で HTTP の応答にできるのはこちらだけ */
export type DeleteAccountHttpResult = Exclude<DeleteAccountResult, DeleteAccountFailure>;

/** 失敗 (ACCOUNT_DELETE_FAILED) かどうか。失敗は呼び出し側が internalError (汎用メッセージの 500) で返す */
export function isAccountDeletionFailure(result: DeleteAccountResult): result is DeleteAccountFailure {
  return !result.ok && result.error === 'ACCOUNT_DELETE_FAILED';
}

/** 退会で使う client。service_role の SupabaseClient を渡す */
export type AccountDeletionAdmin = Pick<SupabaseClient, 'from' | 'rpc' | 'storage' | 'auth'>;

/** db-logger の createLogger(...) が返すロガー */
export type AccountDeletionLogger = ReturnType<typeof createLogger>;

export interface DeleteAccountParams {
  userId: string;
  /** service_role の client。呼び出し側が userId の持ち主を確認したあとにだけ渡す */
  admin: AccountDeletionAdmin;
  /** 応答とログを結びつける ID。省略すると新しく作る */
  requestId?: string;
  /** テスト用に差し替える。省略すると createLogger('lib/account-deletion', requestId) */
  logger?: AccountDeletionLogger;
  /** Storage の掃除に使ってよい時間 (ms)。省略すると既定 (45 秒) */
  storageMaxDurationMs?: number;
}

const LOG_NAME = 'lib/account-deletion';

/** 構造化された失敗の結果。内部のエラー文は入れない */
export function accountDeletionFailure(requestId: string, step: AccountDeletionStep): DeleteAccountFailure {
  return {
    ok: false,
    status: 500,
    error: 'ACCOUNT_DELETE_FAILED',
    request_id: requestId,
    step,
  };
}

/**
 * 失敗 (500) 以外の結果を HTTP の応答 (ステータスと JSON) にする。
 * 成功は { success: true } (従来の応答と同じ)。409 は従来と同じ形 ({ error, message, organization | family_group })。
 * 失敗 (ACCOUNT_DELETE_FAILED) は受け取らない: 呼び出し側が isAccountDeletionFailure で先に分け、
 * internalError (src/lib/api/errors.ts。#1172。汎用メッセージだけ) で返す。
 */
export function accountDeletionHttp(result: DeleteAccountHttpResult): { status: number; body: Record<string, unknown> } {
  if (result.ok) return { status: 200, body: { success: true } };
  if (result.error === 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER') {
    return {
      status: result.status,
      body: { error: result.error, message: result.message, organization: result.organization },
    };
  }
  return {
    status: result.status,
    body: { error: result.error, message: result.message, family_group: result.family_group },
  };
}

/**
 * ログ用に Error へそろえる。supabase-js のエラーは Error とは限らず、{ message, code, details, hint } の素のオブジェクトで来ることがある
 * (createLogger().error は Error 以外を String() にするため、そのまま渡すと "[object Object]" になって原因が消える)。
 * src/lib/api/errors.ts の toError と同じ考え方。あちらは next/server に依存するので、この lib は別に持つ。
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value) return new Error(value);
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message) return new Error(message);
  }
  return new Error('Unknown error');
}

/** エラーから、ログに残してよい短い手がかり (SQLSTATE や HTTP ステータス) を取り出す。メッセージ本文は含めない */
function errorHints(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const { code, status, name } = error as { code?: unknown; status?: unknown; name?: unknown };
  const hints: Record<string, unknown> = {};
  if (typeof code === 'string') hints.error_code = code;
  if (typeof status === 'number') hints.error_status = status;
  if (typeof name === 'string') hints.error_name = name;
  return hints;
}

/** 削除済みのユーザーに対する deleteUser の失敗 (404 / user_not_found)。すでに消えているので成功と同じ */
function isUserAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === 'user_not_found';
}

/** 組織のオーナー / 家族の代表者なら、削除をブロックする結果を返す (問い合わせ自体の失敗は例外) */
async function findBlocker(admin: AccountDeletionAdmin, userId: string): Promise<DeleteAccountResult | null> {
  // P0 Critical Fix F12: 削除前に owner/representative チェック
  // organizations の owner であれば削除不可 (譲渡または解散が必要)
  const { data: ownedOrgs, error: orgError } = await admin
    .from('organizations')
    .select('id, name')
    .eq('owner_id', userId)
    .limit(1);
  if (orgError) throw orgError;
  if (ownedOrgs && ownedOrgs.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: ownedOrgs[0],
    };
  }

  // family_groups の representative であれば削除不可 (譲渡または解散が必要)
  const { data: representedFamilies, error: familyError } = await admin
    .from('family_groups')
    .select('id, name')
    .eq('representative_id', userId)
    .limit(1);
  if (familyError) throw familyError;
  if (representedFamilies && representedFamilies.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
      message: '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。',
      family_group: representedFamilies[0],
    };
  }

  return null;
}

/**
 * アカウントを削除する。例外は投げない (想定外の例外も ACCOUNT_DELETE_FAILED にして返す)。
 * 成功したら { ok: true }。成功と 409 は accountDeletionHttp で HTTP の応答にする。失敗 (500) は呼び出し側が internalError で返す。
 */
export async function deleteAccount(params: DeleteAccountParams): Promise<DeleteAccountResult> {
  const { userId, admin } = params;
  const requestId = params.requestId ?? generateRequestId();
  const log = params.logger ?? createLogger(LOG_NAME, requestId);
  // 削除前のログにだけ user_id を付ける (app_logs.user_id は auth.users への外部キー。削除後のログに付けると保存に失敗する)
  const userLog = log.withUser(userId);

  let step: AccountDeletionStep = 'check_blockers';
  try {
    const blocker = await findBlocker(admin, userId);
    if (blocker) return blocker;

    step = 'prepare';
    const { data: prepareReport, error: prepareError } = await admin.rpc('prepare_account_deletion', {
      p_user_id: userId,
    });
    if (prepareError) throw prepareError;

    // #1039 F3-09: org メンバーなら削除前にライセンス席を解放 (used_licenses リーク防止)
    // leave_org/remove_org_member を経由しない削除フローのため専用 RPC で解放する。
    step = 'release_membership';
    try {
      const { error: releaseError } = await admin.rpc('release_user_membership', { p_user_id: userId });
      if (releaseError) throw releaseError;
    } catch (releaseError) {
      // ライセンス解放の失敗でアカウント削除自体は止めない (ベストエフォート、要手動リコンサイル)
      userLog.error('account deletion: release_user_membership failed (continuing; needs manual reconcile)', toError(releaseError), {
        step,
        request_id: requestId,
        ...errorHints(releaseError),
      });
    }

    step = 'storage';
    const storage = await removeAccountStorage(admin, userId, {
      log: userLog,
      maxDurationMs: params.storageMaxDurationMs,
    });

    step = 'delete_user';
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) {
      if (!isUserAlreadyGone(deleteError)) throw deleteError;
      // すでに消えているユーザーには user_id を付けられない (app_logs.user_id の外部キーで保存に失敗する)
      log.warn('account deletion: user was already deleted', { request_id: requestId });
    }

    // 削除後なので withUser は使わない。メールアドレスも user_id も載せない
    log.info('account deleted', { request_id: requestId, prepare: prepareReport ?? null, storage });
    return { ok: true };
  } catch (error) {
    userLog.error(`account deletion failed at step: ${step}`, toError(error), {
      step,
      request_id: requestId,
      ...errorHints(error),
    });
    return accountDeletionFailure(requestId, step);
  }
}
