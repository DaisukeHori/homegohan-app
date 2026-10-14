// src/lib/membership/resolve-auth-emails.ts
// 通知メールの宛先として、auth.users のメールアドレスを、必要なユーザー ID の分だけ引く (サーバー専用)。
//
// メールアドレスは auth.users にしか無い。user_profiles に email 列は無く、RLS で他人の行も読めないため、
// 本人以外の宛先は service_role の Auth Admin API で引く必要がある (#1110)。
// auth.admin.listUsers() は page / perPage を渡さないと先頭 50 件しか返さず、登録ユーザーが 50 人を超えると
// 対象のユーザーが一覧に載らなくなる (#1204)。ここでは対象の ID だけを getUserById で引くので、
// プラットフォーム全体の登録人数に依存しない。
//
// - 同じ ID は 1 回だけ引く。null / undefined / 空文字は無視する (アカウントを持たない子供の user_id は NULL)。
// - 同時に Auth API へ投げる件数に上限を設ける。数百人の組織でも一度に大量のリクエストを送らない。
// - 1 人の失敗で全体を止めない (Promise.allSettled)。失敗した人は結果に入れず、警告ログに残す。
//   ログに残すのは user_id と件数だけで、メールアドレスは残さない。
// - この関数は例外を投げない。呼び出し元は「戻り値に無い = 通知を送れない」として扱えばよい
//   (通知は best-effort で、失敗しても本体の操作は止めない)。
//
// 通知先が数百人規模になって遅いときは、この関数の中身だけを service_role 専用の RPC
// admin_user_emails(p_ids) (#1317 の migration 20261007160800。1 回の呼び出しで複数人を引ける) に
// 差し替えればよい。呼び出し側は変わらない。
//
// service_role を使い、他人のメールアドレスを返す。API ルートなどサーバー側からだけ呼ぶこと。
// 呼ぶ前に認可 (当事者であること・運営権限など) を済ませ、取得したアドレスをクライアントへ返さないこと。
import { createLogger } from '@/lib/db-logger';
import { getSupabaseAdmin } from '@/lib/supabase/server';

/** Auth Admin API の getUserById を持つクライアント (getSupabaseAdmin() や、route が持つ service-role クライアント) */
export interface AuthAdminLookup {
  auth: {
    admin: {
      getUserById(id: string): PromiseLike<{
        data: { user: { email?: string | null } | null } | null;
        error: { message?: string; status?: number } | null;
      }>;
    };
  };
}

/** 失敗の警告ログの出力先 (createLogger(...) の戻り値や、その withUser(...) の戻り値) */
export interface WarnLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface ResolveAuthEmailsOptions {
  /** 使う Admin クライアント。省略時は getSupabaseAdmin()。呼び出し元がすでに service-role クライアントを持っていれば渡す */
  admin?: AuthAdminLookup;
  /** 失敗の警告ログの出力先。省略時は createLogger で作る。呼び出し元の route・操作者を残したいときに渡す */
  logger?: WarnLogger;
  /** 同時に Auth API へ投げる件数の上限 */
  concurrency?: number;
}

/** 同時に Auth API へ投げる件数の既定値 */
export const DEFAULT_AUTH_LOOKUP_CONCURRENCY = 10;
/** 警告ログに残す user_id の最大数 (大量に失敗しても 1 行のログに収める) */
const MAX_LOGGED_FAILED_IDS = 10;

interface LookupFailure {
  id: string;
  reason: unknown;
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_AUTH_LOOKUP_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

/** ログ用に失敗の理由を短い文字列にする (Error・Auth API のエラーオブジェクト・それ以外) */
function describeFailure(reason: unknown): string {
  if (reason && typeof reason === 'object') {
    const { message, status } = reason as { message?: unknown; status?: unknown };
    if (typeof message === 'string') {
      return typeof status === 'number' ? `${message} (status ${status})` : message;
    }
  }
  return String(reason);
}

function warnLookupFailures(logger: WarnLogger | undefined, requested: number, failures: LookupFailure[]) {
  (logger ?? createLogger('lib/membership/resolve-auth-emails')).warn(
    'Auth ユーザーのメールアドレスを取得できませんでした (該当者には通知メールを送れません)',
    {
      requested,
      failed: failures.length,
      failed_user_ids: failures.slice(0, MAX_LOGGED_FAILED_IDS).map(({ id }) => id),
      first_error: describeFailure(failures[0].reason),
    },
  );
}

/**
 * 指定したユーザー ID のメールアドレスを auth.users から引く。
 * 戻り値は「メールアドレスが取れた ID → アドレス」の Map。メールアドレスを持たないユーザー
 * (電話番号のみなど) や、取得に失敗したユーザーは入らない。
 */
export async function resolveAuthEmails(
  userIds: ReadonlyArray<string | null | undefined>,
  options: ResolveAuthEmailsOptions = {},
): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return emails;

  let admin: AuthAdminLookup;
  try {
    admin = options.admin ?? getSupabaseAdmin();
  } catch (err) {
    // service-role の環境変数が無いなど。通知を送れないだけで、呼び出し元の操作は止めない
    warnLookupFailures(options.logger, ids.length, ids.map((id) => ({ id, reason: err })));
    return emails;
  }

  const failures: LookupFailure[] = [];
  const batchSize = normalizeConcurrency(options.concurrency);
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    // async 関数で包み、getUserById が同期的に例外を投げても、その人の失敗として扱う
    const settled = await Promise.allSettled(batch.map(async (id) => admin.auth.admin.getUserById(id)));
    settled.forEach((result, index) => {
      const id = batch[index];
      if (result.status === 'rejected') {
        failures.push({ id, reason: result.reason });
        return;
      }
      const { data, error } = result.value;
      if (error || !data?.user) {
        failures.push({ id, reason: error ?? new Error('USER_NOT_FOUND') });
        return;
      }
      const email = data.user.email;
      if (typeof email === 'string' && email.length > 0) emails.set(id, email);
    });
  }

  if (failures.length > 0) warnLookupFailures(options.logger, ids.length, failures);
  return emails;
}
