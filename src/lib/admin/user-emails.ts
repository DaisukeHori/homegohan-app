/**
 * 管理画面のユーザー一覧・詳細に出すメールアドレスの取得と、見てよいロールの判定 (#1145)
 *
 * メールアドレスは auth.users にあり、PostgREST には公開されていない。
 * service_role 専用の RPC (supabase/migrations/20261007160800_admin_user_email_lookup.sql) で引く。
 *   - admin_user_emails(p_ids)                  : 渡した user_id のメールだけ (一覧は 1 ページ分、詳細は 1 件)
 *   - admin_find_user_ids_by_email(p_q, p_limit): メールの部分一致で user_id (q によるメール検索用)
 * auth.admin.listUsers() は 1 ページ 50 件までしか返さず、先頭の外のユーザーが引けないため使わない (#1204)。
 *
 * 認可:
 *   - メールを見てよいのは admin / super_admin だけ (canViewUserEmail)。support は一覧・詳細を見られるが、メールは見えない
 *     (検索でメールの存在を推測されないよう、メールでの検索も効かせない)。
 *   - 呼び出し側は先に requireRole を通し、canViewUserEmail が true のときだけ、このモジュールの関数を呼ぶこと。
 *     (service_role で auth.users を読むため、認可前に呼ぶと全ユーザーのメールが引ける。)
 *
 * 失敗時: 例外を投げず、ログに残して「メールなし」として返す (一覧・詳細そのものは動かし続ける)。
 *   ログにはメールアドレスも検索語も出さない (SQLSTATE と件数だけ)。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger, generateRequestId } from '@/lib/db-logger';
import { isUuid } from '@/lib/admin/users-search';

/**
 * メールアドレスを見てよいロール。support は含めない (最小権限)。
 * support にも見せる場合は 'support' を足すだけでよい (一覧・詳細・検索のすべてがこの定数に従う)。
 */
export const EMAIL_VIEWER_ROLES: ReadonlyArray<string> = ['admin', 'super_admin'];

export function canViewUserEmail(roles: ReadonlyArray<string> | null | undefined): boolean {
  return (roles ?? []).some((role) => EMAIL_VIEWER_ROLES.includes(role));
}

/**
 * メール検索で拾う user_id の上限。or=(id.in.(...)) を URL に載せるため小さく保つ
 * (100 件で約 4KB。RPC 側の上限は 200)。これを超えて一致する検索語は、新しいアカウントから 100 件までが対象になる。
 */
export const EMAIL_SEARCH_LIMIT = 100;

interface EmailRow {
  user_id: string;
  email: string | null;
}

/**
 * 渡した user_id のメールアドレスを引く。メールを持たないユーザー (電話・匿名など) や存在しない id は、Map に入らない。
 * 失敗したら空の Map を返す。
 *
 * @param logSource ログの発生元 (例: 'GET /api/admin/users')
 */
export async function fetchUserEmails(
  admin: SupabaseClient,
  ids: ReadonlyArray<string>,
  logSource: string,
): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return emails;

  try {
    const { data, error } = await admin.rpc('admin_user_emails', { p_ids: uniqueIds });
    if (error) {
      // DB の生のエラーオブジェクトはログに渡さず、SQLSTATE と件数だけを残す
      createLogger(logSource, generateRequestId()).error(
        'admin_user_emails failed',
        new Error('admin_user_emails failed'),
        { pg_code: error.code, id_count: uniqueIds.length },
      );
      return emails;
    }
    for (const row of (data ?? []) as EmailRow[]) {
      if (row.user_id && row.email) emails.set(row.user_id, row.email);
    }
  } catch (err) {
    createLogger(logSource, generateRequestId()).error('admin_user_emails threw', err, {
      id_count: uniqueIds.length,
    });
  }
  return emails;
}

/**
 * メールアドレスの部分一致 (大文字小文字を区別しない) で user_id を探す。新しいアカウントから最大 EMAIL_SEARCH_LIMIT 件。
 * 失敗したら空配列を返す (呼び出し側は、ニックネームと ID の検索だけで続ける)。
 *
 * @param logSource ログの発生元 (例: 'GET /api/admin/users')
 */
export async function findUserIdsByEmail(
  admin: SupabaseClient,
  q: string,
  logSource: string,
): Promise<string[]> {
  const term = q.trim();
  if (!term) return [];

  try {
    const { data, error } = await admin.rpc('admin_find_user_ids_by_email', {
      p_q: term,
      p_limit: EMAIL_SEARCH_LIMIT,
    });
    if (error) {
      // 検索語 (メールの一部かもしれない) はログに出さない
      createLogger(logSource, generateRequestId()).error(
        'admin_find_user_ids_by_email failed',
        new Error('admin_find_user_ids_by_email failed'),
        { pg_code: error.code },
      );
      return [];
    }
    return ((data ?? []) as unknown[]).filter((id): id is string => typeof id === 'string' && isUuid(id));
  } catch (err) {
    createLogger(logSource, generateRequestId()).error('admin_find_user_ids_by_email threw', err);
    return [];
  }
}
