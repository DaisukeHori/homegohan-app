/**
 * アカウント削除 (退会) の本体 (#1175)。POST /api/account/delete と、今後の確認リンク方式 (作業計画 T20) が呼ぶ。
 *
 * 呼び出し側の責任:
 *   - userId の持ち主を、呼ぶ前に確認すること (ログイン中の本人、または本人宛の確認リンクの検証済みトークン)。
 *     admin は service_role の client で RLS を通らない。認証の前に呼んではいけない。
 *   - confirm の確認 (`confirm: true`) など、入口の検証。
 *
 * 流れ (どの段階も、やり直して何度流しても同じ結果になる。途中で失敗したら、そこで止めて ACCOUNT_DELETE_FAILED を返す):
 *   1. 退会の印を付けてから (DB 関数 begin_account_deletion_guard。印のある人を運営がオーナーにして組織を作れない。supabase/migrations/20261023130000_account_deletion_owner_guard.sql。
 *      印のある人は家族の代表者にもなれない (家族の作成・代表者の譲渡の承諾・運営の強制譲渡。20261023150000_account_deletion_family_representative_guard.sql))、
 *      組織のオーナー / 家族の代表者なら 409 で止める (譲渡か解散が先)。
 *   1'. 段階 billing (billing/01 §11。src/lib/billing/account-deletion.ts): 顧客の開いたままの Stripe Checkout Session を閉じ、
 *      Stripe の契約 (顧客の全契約と DB の行の和) のうち終端でないものを即時解約し、Stripe の顧客を匿名化する。
 *      顧客も契約の行も無ければ Stripe を呼ばない。失敗したらここで止める (まだ何も変えていないのでやり直せる)。
 *   2. prepare_account_deletion (DB 関数): 本人の生のメールアドレスを残す記録 (メール配信ログ・問い合わせ・招待) を伏せる。
 *   3. release_user_membership (DB 関数): 組織のライセンス席を解放する。失敗しても削除は続ける (要手動リコンサイル)。
 *      ただし、1 のあとに譲渡の承諾・運営の強制譲渡で本人がオーナーになっていたら、DB 関数は所属を外さずに IS_ORG_OWNER で止まる
 *      (supabase/migrations/20261022160000_release_membership_owner_race.sql)。そのときは 1 をやり直して 409 で止める。
 *      所属の組織が途中で変わっていたら CONFLICT_RETRY で止まる。そのときは削除しない (ACCOUNT_DELETE_FAILED。もう一度の退会で片付く)。
 *   4. Storage のファイルを消す (src/lib/account-deletion-storage.ts)。
 *   4'. 削除の実行記録を始める (#1562。DB 関数 begin_account_deletion_record)。gdpr_deletion_requests に、利用者の id の
 *      HMAC (subject_hash)・実行者 (本人 / 運営)・理由のコード・request_id を書く。利用者の id そのものは残さない。
 *      記録を書けなければ削除しない (記録の無い削除を作らない)。
 *   4''. 段階 billing_recheck (billing/01 §11): 1' と同じ処理をもう一度 (1' のあとに完了した Checkout の契約・作られた顧客を閉じる)。
 *      失敗したら 5 に進まない (アカウントは残り、もう一度の退会で片付く)。
 *   5. auth.admin.deleteUser。public 側の個人データは外部キーの CASCADE / SET NULL で消える・匿名化される
 *      (20261010000100_auth_users_fk_on_delete.sql)。findBlocker のあとに組織のオーナー・家族の代表者になって、deleteUser が
 *      organizations.owner_id / family_groups.representative_id の RESTRICT で失敗する型は残らない: 組織の運営の作成は 1 の印で止まり
 *      (OWNER_ACCOUNT_DELETING。20261023130000 の見出し)、組織の譲渡は 3 が止める。家族の代表者になる 3 つの経路 (作成・譲渡の承諾・
 *      運営の強制譲渡) は 1 の印で止まる (REPRESENTATIVE_ACCOUNT_DELETING。20261023150000 の見出し)。印は退会の route の
 *      maxDuration より長く効くので、1 回の退会の実行の間は外れない。
 *      削除が済んだら (すでに消えていたときも)、記録に削除の日時を入れる (complete_account_deletion_record)。
 *      これに失敗しても退会の結果は変えない (アカウントはもう消えている)。失敗はログに残す (記録は executed_at が空のまま残る)。
 *   6. 本人に退会の完了メールを 1 通送る (#1152。src/lib/account-deletion-notification.ts)。
 *      宛先 (auth.users の登録アドレス) は 1 の後・2 の前に控えておき、メモリ上だけで使う (ログには残さない)。
 *      送るのは 5 が実際に削除した 1 回だけ (409・途中の失敗・すでに消えていたユーザーのやり直しでは送らない)。
 *      送信の失敗は退会の結果を変えない (アカウントはもう消えている)。失敗はログに残す。
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
import { notifyAccountDeleted, readAccountDeletionEmail } from '@/lib/account-deletion-notification';
// billing/account-deletion.ts は account-deletion.ts から型だけを import するので、実行時の循環は無い
import { defaultAccountDeletionBilling } from '@/lib/billing/account-deletion';
import { MembershipErrorCode } from '@/lib/errors/membership-errors';

/** どの段階で失敗したか (ログ用。応答には出さない) */
export type AccountDeletionStep =
  | 'init'
  | 'check_blockers'
  | 'billing'
  | 'prepare'
  | 'release_membership'
  | 'storage'
  | 'record'
  | 'billing_recheck'
  | 'delete_user';

/**
 * 削除の実行者 (#1562。削除の実行記録 gdpr_deletion_requests の executor_type)。
 * 本人の退会は self。運営が消すときは operator で、実行した運営者の id を記録に残す (本人の id は残さない)。
 */
export type AccountDeletionExecutor = { type: 'self' } | { type: 'operator'; operatorId: string };

/** 削除の理由のコード (#1562。記録の reason。自由な文は入れない。DB の CHECK は ^[a-z][a-z0-9_]{0,63}$) */
export const ACCOUNT_DELETION_REASON = {
  /** 本人が退会した */
  self: 'user_request',
  /** 運営が消した */
  operator: 'operator_action',
} as const satisfies Record<AccountDeletionExecutor['type'], string>;

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
  /** テスト用に差し替える。完了メールに書く退会日時の時計。省略すると new Date() */
  now?: () => Date;
  /** 削除の実行者 (#1562。削除の実行記録に残す)。省略すると本人 ({ type: 'self' }) */
  executor?: AccountDeletionExecutor;
  /** テストで差し替える。既定は src/lib/billing/account-deletion.ts の実装 (billing/01 §11) */
  billing?: AccountDeletionBilling;
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

/** DB 関数が RAISE EXCEPTION '<コード>' USING ERRCODE = 'P0001' で止めたときの SQLSTATE */
const PG_RAISE_EXCEPTION = 'P0001';
/** release_user_membership が、本人がオーナーなので所属を外さずに止めたときのコード (leave_org と同じ) */
const RELEASE_MEMBERSHIP_OWNER_CODE = MembershipErrorCode.IS_ORG_OWNER;
/** release_user_membership が、所属の組織が途中で変わったので所属を外さずに止めたときのコード (既存のコード) */
const RELEASE_MEMBERSHIP_RETRY_CODE = MembershipErrorCode.CONFLICT_RETRY;

/** DB 関数が RAISE した決まったコード (P0001 で、メッセージがそのコード) か */
function isRaisedCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code: sqlState, message } = error as { code?: unknown; message?: unknown };
  return sqlState === PG_RAISE_EXCEPTION && message === code;
}

/** 削除済みのユーザーに対する deleteUser の失敗 (404 / user_not_found)。すでに消えているので成功と同じ */
function isUserAlreadyGone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === 'user_not_found';
}

/**
 * 削除の実行記録を始める (#1562)。記録の id を返す。失敗は例外 (呼び出し側が step 'record' の失敗にして、削除しない)。
 * 利用者の id は DB 関数の中で HMAC にしてから書く (記録に id そのものは残らない)。
 */
async function beginDeletionRecord(
  admin: AccountDeletionAdmin,
  userId: string,
  executor: AccountDeletionExecutor,
  requestId: string,
): Promise<string> {
  const { data, error } = await admin.rpc('begin_account_deletion_record', {
    p_user_id: userId,
    p_executor_type: executor.type,
    p_reason: ACCOUNT_DELETION_REASON[executor.type],
    p_request_id: requestId,
    p_operator_id: executor.type === 'operator' ? executor.operatorId : null,
  });
  if (error) throw error;
  if (typeof data !== 'string' || data === '') throw new Error('begin_account_deletion_record returned no id');
  return data;
}

/**
 * 削除が済んだことを記録に入れる (#1562)。例外は投げない: アカウントはもう消えているので、退会の結果は変えない。
 * 失敗はログに残す (削除後なので user_id は付けない。記録の id と request_id で探せる)。
 */
async function completeDeletionRecord(
  admin: AccountDeletionAdmin,
  recordId: string,
  log: AccountDeletionLogger,
  requestId: string,
): Promise<void> {
  try {
    const { error } = await admin.rpc('complete_account_deletion_record', { p_record_id: recordId });
    if (error) throw error;
  } catch (error) {
    log.error('account deletion: complete_account_deletion_record failed (account is deleted; record left without executed_at)', toError(error), {
      step: 'record',
      request_id: requestId,
      deletion_record_id: recordId,
      ...errorHints(error),
    });
  }
}

/** 組織のオーナー / 家族の代表者なら、削除をブロックする結果を返す (問い合わせ自体の失敗は例外) */
async function findBlocker(admin: AccountDeletionAdmin, userId: string): Promise<DeleteAccountResult | null> {
  // P0 Critical Fix F12: 削除前に owner/representative チェック
  // 解散した行は representative_id / owner_id が NULL なので当たらない (#1917。docs/design/family/11-self-dissolve.md §11.1)
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
  // 完了メール (#1152) の宛先。削除の後では引けないので、記録を伏せる・消す前に控える。メモリ上だけで使い、ログに渡さない
  let completionEmailTo: string | null = null;
  // deleteUser が実際に削除したか (すでに消えていたユーザーのやり直しでは false。完了メールは最初の退会で送っている)
  let deletedNow = false;
  let deletedAt: Date | null = null;
  try {
    // 退会の印 (#1917 の続き。20261023130000・20261023150000): findBlocker より先に付ける。印のあとに運営がこの人をオーナーにして
    // 組織を作ろうとすると、またはこの人を家族の代表者にしようとすると (家族の作成・代表者の譲渡の承諾・運営の強制譲渡)、DB のトリガーが止める。
    // 印より先に作られた組織・印より先に代わった代表者は、下の findBlocker が読んで 409 にする (印は作成・変更の commit を待つ)
    const { error: guardError } = await admin.rpc('begin_account_deletion_guard', { p_user_id: userId });
    if (guardError) throw guardError;
    const blocker = await findBlocker(admin, userId);
    if (blocker) return blocker;

    completionEmailTo = await readAccountDeletionEmail(admin, userId, { log, requestId });

    // billing/01 §11: 開いたままの Checkout を閉じ、Stripe の契約を即時解約し、顧客を匿名化する。
    // まだ何も変えていないので、Stripe の失敗で止まってもやり直せる
    step = 'billing';
    const billing = params.billing ?? defaultAccountDeletionBilling;
    const billingReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing');

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
      // 1 のあとにオーナーになった (所属は外れていない)。1 をやり直して、従来と同じ 409 で止める。
      // やり直しでオーナーでなくなっていたら (同時の譲渡がもう一度あった)、確かめられないまま消さずに失敗にする (もう一度の退会で片付く)
      if (isRaisedCode(releaseError, RELEASE_MEMBERSHIP_OWNER_CODE)) {
        const blocker = await findBlocker(admin, userId);
        if (blocker) return blocker;
        throw releaseError;
      }
      // 所属の組織が途中で変わった (所属は外れていない)。その組織の席を残したまま消さないよう、失敗にする
      if (isRaisedCode(releaseError, RELEASE_MEMBERSHIP_RETRY_CODE)) throw releaseError;
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

    step = 'record';
    const recordId = await beginDeletionRecord(admin, userId, params.executor ?? { type: 'self' }, requestId);

    // billing/01 §11: deleteUser の直前にもう一度 (段階 billing のあとに完了した Checkout の契約・作られた顧客を閉じる)。
    // 失敗したら delete_user に進まない (アカウントは残り、もう一度の退会で片付く)
    step = 'billing_recheck';
    const billingRecheckReport = await billing.cancelForAccountDeletion(userId, userLog, 'billing_recheck');

    step = 'delete_user';
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
    if (deleteError) {
      if (!isUserAlreadyGone(deleteError)) throw deleteError;
      // すでに消えているユーザーには user_id を付けられない (app_logs.user_id の外部キーで保存に失敗する)
      log.warn('account deletion: user was already deleted', { request_id: requestId });
    } else {
      deletedNow = true;
      deletedAt = params.now?.() ?? new Date();
    }

    // 削除が済んだ (すでに消えていたときも)。記録に日時を入れる。失敗しても退会の結果は変えない (中で例外を止める)
    await completeDeletionRecord(admin, recordId, log, requestId);

    // 削除後なので withUser は使わない。メールアドレスも user_id も載せない
    log.info('account deleted', { request_id: requestId, deletion_record_id: recordId, prepare: prepareReport ?? null, storage, billing: billingReport, billing_recheck: billingRecheckReport });
  } catch (error) {
    userLog.error(`account deletion failed at step: ${step}`, toError(error), {
      step,
      request_id: requestId,
      ...errorHints(error),
    });
    return accountDeletionFailure(requestId, step);
  }

  // 削除が済んでから、本人に完了メールを送る (#1152)。try の外に置き、送信の失敗が退会の失敗 (500) にならないようにする。
  // notifyAccountDeleted は例外を投げず、失敗は user_id もアドレスも付けずにログへ残す
  if (deletedNow && deletedAt && completionEmailTo) {
    await notifyAccountDeleted({ toEmail: completionEmailTo, deletedAt, requestId, log });
  }
  return { ok: true };
}

/** 退会で Stripe を扱う 2 つの段階 (billing/01 §11) */
export type AccountDeletionBillingPhase = Extract<AccountDeletionStep, 'billing' | 'billing_recheck'>;

/**
 * 段階 billing / billing_recheck のロガー (createLogger(...).withUser(...) が返すものの一部)。
 * AccountDeletionLogger (= ReturnType<typeof createLogger>) は使わない: deleteAccount が渡す userLog = log.withUser(userId) の戻り値は
 * withUser を持たず、AccountDeletionLogger には代入できない (account-deletion-storage.ts の AccountStorageLogger と同じ形にする)
 */
export interface AccountDeletionBillingLogger {
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface AccountDeletionBillingReport {
  /** 即時解約した契約の数 */
  cancelled_subscriptions: number;
  /** 閉じた (expire) Checkout Session の数 */
  expired_checkout_sessions: number;
  /** 顧客 (billing_customers) があれば anonymized (この呼び出しで匿名化した、または匿名化済み)。無ければ none */
  customer: 'anonymized' | 'none';
}

export interface AccountDeletionBilling {
  /**
   * 開いたままの Checkout Session を閉じ、契約を即時解約し、顧客を匿名化する。顧客も Stripe-backed の行も無ければ何もしない。
   * 失敗は例外 (その段階で止める)。同じ利用者に何度呼んでも同じ結果になる (2 回目は、閉じる Session・解約する契約が無ければ何もしない)
   */
  cancelForAccountDeletion(
    userId: string,
    log: AccountDeletionBillingLogger,
    phase: AccountDeletionBillingPhase,
  ): Promise<AccountDeletionBillingReport>;
}
