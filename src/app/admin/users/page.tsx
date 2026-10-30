/**
 * /admin/users — ユーザー一覧・検索
 * operator/03-ui-spec.md §5 準拠
 *
 * DB 直叩きを廃止し GET /api/admin/users 経由に統一。
 *
 * #2093 W3: 一覧の読み込みの失敗 (API の失敗・通信の失敗・data が配列でない壊れた応答) は 0 件と分ける。
 * 「ユーザーが見つかりません」・件数 0 を出さず、「ユーザーの一覧を読み込めませんでした」と「再読み込み」を出す
 * (以前は失敗を console.error で捨てて 0 件のまま描き、運営が、いる利用者をいないと誤りうる状態だった。審査の一覧の #2086 V7 と同じ型)。
 * #2093 W8: URL の page が 1 以上の整数でなければ 1 ページ目を読む (?page=abc で API に page=NaN を送らない)。
 * #2101 X7: URL の status が API の一覧 (active / banned / deleted) に無ければ、既定の active として読む
 * (空 =「全ステータス」はそのまま。以前は ?status=foo をそのまま API に送り、400 の読み込みの失敗が再読み込みしても直らなかった)。
 * #2107 Y10: 絞り込みの select の選択肢は「全ステータス」と USER_LIST_STATUSES から作る (表示名は USER_LIST_STATUS_LABELS)。
 * 以前は選択肢を手で書き、削除済みが無いため ?status=deleted の select が「全ステータス」を示し、そのまま「検索」を押すと
 * 全ステータスに戻っていた。削除済みの一覧は常に 0 件 (退会で記録が消える) なので、0 件の文で理由を出す。
 * #2112 Z3: 一覧のステータスの列は USER_LIST_STATUS_LABELS の表示名で出す (BAN 中は banned、それ以外は active の名前。絞り込みの select と同じ語)。
 * 以前は「BAN」「active」と英字の直書きだった。プランの列も英字の内部の値 (free など) をやめ、src/lib/admin/plan-key-labels.ts の表示名で出す。
 */

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { canViewUserEmail } from '@/lib/admin/user-emails';
import { normalizeProfileName } from '@/lib/profile-name';
import { adminPlanKeyLabel } from '@/lib/admin/plan-key-labels';
import { operatorRoleLabel } from '@/lib/admin/operator-role-labels';
import {
  USER_LIST_ALL_STATUSES,
  USER_LIST_ALL_STATUSES_LABEL,
  USER_LIST_DELETED_EMPTY_MESSAGE,
  USER_LIST_STATUSES,
  USER_LIST_STATUS_LABELS,
  parseUserListStatusParam,
  type UserListItem,
} from '@/lib/admin/users-schemas';
import { lastPageToRefetch, parsePageParam } from '@/lib/list-pagination';
import { USERS_LIST_LOAD_FAILED_MESSAGE, readUsersListBody, type UsersListLoad } from '@/lib/admin/users-load-failure';
import ModerationLoadFailure from '@/components/operator/moderation/ModerationLoadFailure';

interface PageProps {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}

export default async function AdminUsersPage(props: PageProps) {
  const searchParams = await props.searchParams;
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  const actor = await requireRoleForPage(['admin', 'super_admin', 'support'], { next: '/admin/users' });

  // メールアドレスを見られるのは admin / super_admin だけ (support には列を出さず、メール検索も効かない)
  const canSeeEmail = canViewUserEmail(actor.roles);

  const q = searchParams.q ?? '';
  // 無ければ active・空 (「全ステータス」) は空のまま。API の一覧 (USER_LIST_STATUSES) に無い status (?status=foo など) は既定の active
  // (#2101 X7。そのまま送ると API が 400 にし、再読み込みしても直らない読み込みの失敗になる)
  const status = parseUserListStatusParam(searchParams.status);
  // 1 以上の整数でない page (?page=abc・2abc・1.5 など) は 1 ページ目 (#2093 W8)
  const page = parsePageParam(searchParams.page);
  const perPage = 50;

  // GET /api/admin/users 経由でデータ取得
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  params.set('page', String(page));
  params.set('per_page', String(perPage));

  // 読み込みの失敗 (!res.ok・例外・壊れた応答) は ok: false。0 件 (ok: true・users が空) と分けて描く (#2093 W3)。
  // 行は route と同じ型 (src/lib/admin/users-schemas.ts の UserListItem) で読む (#1717)
  let load: UsersListLoad<UserListItem> = { ok: false };

  try {
    const res = await adminFetch(`/api/admin/users?${params.toString()}`);
    if (res.ok) {
      load = readUsersListBody<UserListItem>(await res.json());
      if (!load.ok) console.error('[admin/users page] unexpected response body');
    } else {
      console.error('[admin/users page] API error:', res.status);
    }
  } catch (err) {
    console.error('[admin/users page] fetch failed:', err);
  }

  const users = load.ok ? load.users : [];
  const total = load.ok ? load.total : 0;

  // 件数より後ろのページ (最後のページの唯一の行が消えたあと・URL のページ番号) は、空のページを見せずに最後のページへ移す (#1917)。
  // 一覧を読めたときだけ判定する (API の失敗を、何も知らせずにページを移す動きに変えない)。
  // status は空 (全ステータス) でも必ず付ける (付けないと次の読み込みで既定の active に戻る。下の「前へ」「次へ」と同じ)。
  // redirect は例外で抜けるので、上の try の外で呼ぶ
  const refetchPage = load.ok ? lastPageToRefetch({ rows: users.length, page, total, perPage }) : null;
  if (refetchPage !== null) {
    const lastPageParams = new URLSearchParams();
    lastPageParams.set('q', q);
    lastPageParams.set('status', status);
    lastPageParams.set('page', String(refetchPage));
    redirect(`/admin/users?${lastPageParams.toString()}`);
  }

  const totalPages = Math.ceil(total / perPage);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">ユーザー管理</h1>
        {/* 読み込めなかったときは件数を出さない (「全 0 件」と見せない。#2093 W3) */}
        {load.ok && <span className="text-sm text-gray-500">全 {total.toLocaleString()} 件</span>}
      </div>

      {/* 検索・フィルタ */}
      <form method="GET" className="mb-4 flex gap-3">
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder={canSeeEmail ? '名前・メール・ID で検索' : '名前・ID で検索'}
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
        <select
          name="status"
          defaultValue={status}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        >
          {/* 選択肢は URL の status の読み方 (parseUserListStatusParam) と同じ一覧から作る (#2107 Y10。削除済みも選べる) */}
          <option value={USER_LIST_ALL_STATUSES}>{USER_LIST_ALL_STATUSES_LABEL}</option>
          {USER_LIST_STATUSES.map((listStatus) => (
            <option key={listStatus} value={listStatus}>
              {USER_LIST_STATUS_LABELS[listStatus]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
        >
          検索
        </button>
      </form>

      {/* 読み込みの失敗: 0 件の文・表を出さず、失敗の文と「再読み込み」を出す (#2093 W3。部品は審査の画面と共通) */}
      {!load.ok && <ModerationLoadFailure message={USERS_LIST_LOAD_FAILED_MESSAGE} />}

      {/* ユーザーテーブル */}
      {load.ok && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">ユーザー</th>
                {canSeeEmail && (
                  <th className="px-4 py-3 text-left font-medium text-gray-600">メール</th>
                )}
                <th className="px-4 py-3 text-left font-medium text-gray-600">プラン</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">ロール</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">ステータス</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">登録日</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={canSeeEmail ? 7 : 6} className="px-4 py-8 text-center text-gray-400">
                    {/* 削除済みの一覧は常に 0 件 (退会で user_profiles の行が消える)。いないと読ませずに理由を出す (#2107 Y10) */}
                    {status === 'deleted' ? USER_LIST_DELETED_EMPTY_MESSAGE : 'ユーザーが見つかりません'}
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {normalizeProfileName(user.nickname) ?? '(名前なし)'}
                      </div>
                      <div className="text-xs text-gray-400 font-mono">{user.id.slice(0, 8)}...</div>
                    </td>
                    {canSeeEmail && (
                      <td className="px-4 py-3 text-gray-700 break-all">{user.email ?? '-'}</td>
                    )}
                    <td className="px-4 py-3">
                      <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded">
                        {adminPlanKeyLabel(user.plan_key)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(user.roles) ? user.roles : ['user']).map((role) => (
                          <span
                            key={role}
                            title={role}
                            className="inline-block bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded"
                          >
                            {operatorRoleLabel(role)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {user.is_banned ? (
                        <span className="inline-block bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded font-medium">
                          {USER_LIST_STATUS_LABELS.banned}
                        </span>
                      ) : (
                        <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded font-medium">
                          {USER_LIST_STATUS_LABELS.active}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {user.registered_at
                        ? new Date(user.registered_at).toLocaleDateString('ja-JP')
                        : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/users/${user.id}`}
                        className="text-orange-500 hover:text-orange-700 text-xs font-medium"
                      >
                        詳細
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ページネーション */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>
            {(page - 1) * perPage + 1}〜{Math.min(page * perPage, total)} 件 / {total} 件
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page - 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page + 1}`}
                className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                次へ
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
