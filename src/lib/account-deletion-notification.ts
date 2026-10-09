/**
 * 退会 (アカウント削除) の完了メール (#1152)。サーバー専用。src/lib/account-deletion.ts の deleteAccount だけが呼ぶ。
 *
 * 退会が成功したときに、本人のメールアドレスへ「退会が完了しました。心当たりが無ければお問い合わせください」の 1 通を送る。
 * セッションを盗んだ第三者が退会させた場合に、本来の利用者が気づけるようにするため。退会の受付時のメールは送らない。
 *
 * - 宛先: auth.users の登録アドレス。退会の後では引けないので、deleteAccount が記録を伏せる・消す前に
 *   readAccountDeletionEmail で控えておき、メモリ上だけで使う。ログ・メール送信ログ (email_delivery_logs) には書かない
 *   (#1175 / #1437 で退会時に伏せている生のアドレスを、ここで新しく残さないため)。
 *   失敗の記録は sendEmail (src/lib/emails/send.ts) がマスクした宛先 (t***@example.com) で残す。
 * - 送るのは auth.admin.deleteUser が成功した後の 1 回だけ。409 (組織のオーナー・家族の代表者) や途中の失敗 (500) では送らない。
 *   すでに消えていたユーザーの退会のやり直し (deleteUser が 404) でも送らない (最初の退会で送っている)。
 * - best-effort: 送信に失敗しても退会は成功のまま (アカウントはもう消えている)。このモジュールの関数は例外を投げない。
 *   失敗は構造化ログ (db-logger / app_logs) に残す。削除の後なので user_id は付けない
 *   (app_logs.user_id は auth.users への外部キーで、削除後に付けると記録が保存できない)。
 * - 送信回数の制限 (invite-throttle) を通さない理由 (tests/email-send-throttle-contract.test.ts の EXEMPT_EMAIL_SENDERS):
 *   宛先は退会した本人の登録アドレスに固定で、利用者は宛先を指定できない。アカウント 1 つにつき 1 回しか送れない
 *   (送るのは deleteUser が実際に削除した 1 回だけ)。
 */
import { sendEmail, maskEmailAddress } from '@/lib/emails/send';
import { isEmailFailure } from '@/lib/emails/send-result';
import { renderAccountDeletedEmail } from '@/lib/emails/account/account-deleted';

/** 完了メールの文面の名前 (ログ用。renderAccountDeletedEmail の template と同じ) */
export const ACCOUNT_DELETED_EMAIL_TEMPLATE = 'account_deleted';

/**
 * 完了メールの送信を待つ最長時間 (ミリ秒)。
 * POST /api/account/delete の maxDuration (60 秒) の中で、Storage の掃除 (最長 45 秒。src/lib/account-deletion-storage.ts) の
 * 後に送るため、残りに収まる長さにしてある。sendEmail の再試行 (待ち 500ms → 1s → 2s) が一通り収まる長さでもある。
 * 超えたら待つのをやめて退会の成功を返す (メールは届かない可能性があるので、警告ログに残す)。
 */
export const ACCOUNT_DELETED_EMAIL_TIMEOUT_MS = 5000;

/** ログの出力先 (createLogger(...) の戻り値)。削除の後に使うので withUser は使わない */
export interface AccountDeletionNoticeLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
}

/** 宛先を引くのに使う Auth Admin API (service_role の client) */
export interface AccountEmailLookup {
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{
        data: { user: { email?: string | null } | null } | null;
        error: unknown;
      }>;
    };
  };
}

/** エラーから、ログに残してよい短い手がかり (コード・HTTP ステータス・名前) だけを取り出す。メッセージ本文は含めない */
function errorHints(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return {};
  const { code, status, name } = error as { code?: unknown; status?: unknown; name?: unknown };
  const hints: Record<string, unknown> = {};
  if (typeof code === 'string') hints.error_code = code;
  if (typeof status === 'number') hints.error_status = status;
  if (typeof name === 'string') hints.error_name = name;
  return hints;
}

/** すでに消えているユーザー (404 / user_not_found)。退会のやり直しで起きる。送る相手がいないだけで、失敗ではない */
function isUserNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === 'user_not_found';
}

/**
 * 完了メールの宛先 (auth.users の登録アドレス) を、削除の前に引いておく。例外は投げない。
 * アドレスが無い (電話番号だけの登録など)・ユーザーがもういない・引けなかったときは null (メールは送らない)。
 * 引けなかったときだけ警告ログに残す (アドレスも user_id も残さない)。退会そのものは続ける。
 */
export async function readAccountDeletionEmail(
  admin: AccountEmailLookup,
  userId: string,
  options: { log: AccountDeletionNoticeLogger; requestId: string },
): Promise<string | null> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
      if (!isUserNotFound(error)) {
        options.log.warn('account deletion: could not read the email address for the completion email (deletion continues; no email will be sent)', {
          request_id: options.requestId,
          ...errorHints(error),
        });
      }
      return null;
    }
    const email = data?.user?.email;
    return typeof email === 'string' && email.trim() !== '' ? email : null;
  } catch (error) {
    options.log.warn('account deletion: could not read the email address for the completion email (deletion continues; no email will be sent)', {
      request_id: options.requestId,
      ...errorHints(error),
    });
    return null;
  }
}

/** 文章の中の宛先を、マスクした形に置き換える (想定外の例外の文に宛先が入っていても、生で残さない) */
function redactAddress(text: string, address: string): string {
  if (!address) return text;
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), maskEmailAddress(address));
}

/**
 * work が終わるのを最長 ms だけ待つ。時間内に終われば true、超えたら false (work はそのまま走り続ける)。
 * work が reject しても、ここでは握りつぶして true を返す (失敗の記録は work の中で済ませている)。
 */
async function finishesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 退会の完了メールを 1 通送る。auth.admin.deleteUser が成功した後にだけ呼ぶこと。例外は投げない。
 * 失敗 (送れなかった・想定外の例外・時間切れ) は構造化ログに残す。ログにはメールアドレスも user_id も残さない。
 * RESEND_API_KEY が無くて送らなかった場合 (開発・テスト環境) は、sendEmail が警告を残すので、ここでは失敗に数えない。
 */
export async function notifyAccountDeleted(params: {
  /** readAccountDeletionEmail で、削除の前に控えた宛先 */
  toEmail: string;
  /** 退会が完了した日時 (本文に日本時間で書く) */
  deletedAt: Date;
  requestId: string;
  log: AccountDeletionNoticeLogger;
  /** 送信を待つ最長時間。省略すると ACCOUNT_DELETED_EMAIL_TIMEOUT_MS */
  timeoutMs?: number;
}): Promise<void> {
  const { toEmail, deletedAt, requestId, log } = params;
  const metadata = { request_id: requestId, template: ACCOUNT_DELETED_EMAIL_TEMPLATE };
  const failureMessage = 'account deletion: the completion email could not be sent (the account is already deleted)';

  const attempt = async (): Promise<void> => {
    try {
      const sent = await sendEmail(renderAccountDeletedEmail({ to_email: toEmail, deleted_at: deletedAt }));
      // sendEmail のエラー文は宛先をマスク済み。失敗の詳細は sendEmail も app_logs に残すが、
      // ここでは退会のどの request_id の完了メールかが分かる形でも残す
      if (isEmailFailure(sent)) {
        log.error(failureMessage, sent.error, { ...metadata, error_code: sent.error.code, attempts: sent.attempts });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(failureMessage, new Error(redactAddress(message, toEmail)), { ...metadata, ...errorHints(error) });
    }
  };

  try {
    const finished = await finishesWithin(attempt(), params.timeoutMs ?? ACCOUNT_DELETED_EMAIL_TIMEOUT_MS);
    if (!finished) {
      log.warn('account deletion: the completion email did not finish in time (the account is already deleted; the email may not arrive)', {
        ...metadata,
        timeout_ms: params.timeoutMs ?? ACCOUNT_DELETED_EMAIL_TIMEOUT_MS,
      });
    }
  } catch {
    // ログの出力自体の失敗でも、退会の成功は変えない
  }
}
