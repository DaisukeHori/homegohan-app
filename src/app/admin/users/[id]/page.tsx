/**
 * /admin/users/{id} — ユーザー詳細
 * operator/03-ui-spec.md §6 準拠
 *
 * DB 直叩きを廃止し GET /api/admin/users/{id} 経由に統一。
 */

export const dynamic = 'force-dynamic';

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { adminFetch } from '@/lib/admin/fetch';

interface PageProps {
  params: { id: string };
}

interface ActiveSubscription {
  plan_key: string;
  status: string;
  next_billing_at: string | null;
}

interface AuditLog {
  id: string;
  action_type: string;
  created_at: string;
  severity: string;
  details: unknown;
}

interface UserDetailProfile {
  id: string;
  nickname: string | null;
  roles: string[];
  plan_key: string;
  is_banned: boolean;
  frozen_at: string | null;
  frozen_reason: string | null;
  last_login_at: string | null;
  registered_at: string | null;
  active_subscription: ActiveSubscription | null;
  ban_history: AuditLog[];
}

interface UserDetailApiResponse {
  data: UserDetailProfile;
}

export default async function AdminUserDetailPage({ params }: PageProps) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin', 'support']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const { id } = params;

  // GET /api/admin/users/{id} 経由でデータ取得
  const res = await adminFetch(`/api/admin/users/${id}`);
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    notFound();
  }

  const json = (await res.json()) as UserDetailApiResponse;
  const profile = json.data;

  const activeSubscription = profile.active_subscription;
  // 監査ログ (super_admin のみ: ban_history を使用)
  const auditLogs: AuditLog[] = actor.roles.includes('super_admin')
    ? (profile.ban_history as AuditLog[]) ?? []
    : [];

  const isBanned = profile.is_banned;
  const isSuperAdmin = actor.roles.includes('super_admin');
  const isAdmin = actor.roles.includes('admin') || isSuperAdmin;

  return (
    <div className="max-w-4xl">
      {/* パンくず */}
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-orange-500 transition-colors">
          ユーザー管理
        </Link>
        {' / '}
        <span className="text-gray-900">{profile.nickname ?? profile.id.slice(0, 8)}</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {profile.nickname ?? '(名前なし)'}
      </h1>

      {/* 基本情報セクション */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">基本情報</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-gray-500 mb-1">ユーザー ID</dt>
            <dd className="font-mono text-gray-900 text-xs">{profile.id}</dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">プラン</dt>
            <dd>
              <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded font-mono">
                {profile.plan_key ?? 'free'}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">ロール</dt>
            <dd className="flex flex-wrap gap-1">
              {(Array.isArray(profile.roles) ? profile.roles : ['user']).map((role: string) => (
                <span
                  key={role}
                  className="inline-block bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded font-mono"
                >
                  {role}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">ステータス</dt>
            <dd>
              {isBanned ? (
                <div>
                  <span className="inline-block bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded font-medium">
                    凍結中
                  </span>
                  {profile.frozen_at && (
                    <span className="ml-2 text-xs text-gray-400">
                      {new Date(profile.frozen_at).toLocaleString('ja-JP')} 〜
                    </span>
                  )}
                  {profile.frozen_reason && (
                    <p className="mt-1 text-xs text-red-600">
                      理由: {profile.frozen_reason}
                    </p>
                  )}
                </div>
              ) : (
                <span className="inline-block bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded font-medium">
                  アクティブ
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">登録日</dt>
            <dd className="text-gray-900">
              {profile.registered_at
                ? new Date(profile.registered_at).toLocaleString('ja-JP')
                : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">最終ログイン</dt>
            <dd className="text-gray-900">
              {profile.last_login_at
                ? new Date(profile.last_login_at).toLocaleString('ja-JP')
                : '-'}
            </dd>
          </div>
        </dl>

        {/* アクションボタン */}
        {isAdmin && (
          <div className="mt-6 flex flex-wrap gap-3 pt-4 border-t border-gray-100">
            {isBanned ? (
              <Link
                href={`/admin/users/${id}/freeze`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
              >
                凍結解除
              </Link>
            ) : (
              <Link
                href={`/admin/users/${id}/freeze`}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                凍結 (BAN)
              </Link>
            )}
            {isSuperAdmin && (
              <span className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-medium opacity-60 cursor-not-allowed">
                impersonate (要 reason 入力)
              </span>
            )}
          </div>
        )}
      </div>

      {/* サブスクリプション情報 */}
      {activeSubscription && (
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">現在のサブスクリプション</h2>
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-gray-500 mb-1">プラン</dt>
              <dd className="font-mono">{activeSubscription.plan_key}</dd>
            </div>
            <div>
              <dt className="text-gray-500 mb-1">ステータス</dt>
              <dd>{activeSubscription.status}</dd>
            </div>
            <div>
              <dt className="text-gray-500 mb-1">次回更新</dt>
              <dd>
                {activeSubscription.next_billing_at
                  ? new Date(activeSubscription.next_billing_at).toLocaleDateString('ja-JP')
                  : '-'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {/* 監査ログ (super_admin のみ) */}
      {isSuperAdmin && auditLogs.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">監査ログ (直近 20 件)</h2>
          <div className="space-y-2 text-sm">
            {auditLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-gray-50"
              >
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                    log.severity === 'critical'
                      ? 'bg-red-100 text-red-700'
                      : log.severity === 'warn'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {log.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-gray-700">{log.action_type}</span>
                </div>
                <span className="text-gray-400 text-xs flex-shrink-0">
                  {new Date(log.created_at).toLocaleString('ja-JP')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
