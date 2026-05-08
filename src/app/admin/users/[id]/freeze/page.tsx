/**
 * /admin/users/{id}/freeze — 凍結フォーム
 * operator/03-ui-spec.md §6 BAN モーダル相当
 */

export const dynamic = 'force-dynamic';

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { createClient } from '@/lib/supabase/server';

interface PageProps {
  params: { id: string };
}

export default async function AdminUserFreezePage({ params }: PageProps) {
  let actor;
  try {
    actor = await requireRole(['admin', 'super_admin']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  const { id } = params;
  const supabase = await createClient();

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, nickname, roles, frozen_at')
    .eq('id', id)
    .single();

  if (error || !profile) {
    notFound();
  }

  // 凍結状態は frozen_at IS NOT NULL で判定 ('banned' ロールは使用禁止: cross/CLAUDE.md §B)
  const isBanned = (profile as { frozen_at?: string | null }).frozen_at != null;
  const isSuperAdmin = actor.roles.includes('super_admin');

  return (
    <div className="max-w-2xl">
      {/* パンくず */}
      <nav className="mb-4 text-sm text-gray-500">
        <Link href="/admin/users" className="hover:text-orange-500 transition-colors">
          ユーザー管理
        </Link>
        {' / '}
        <Link href={`/admin/users/${id}`} className="hover:text-orange-500 transition-colors">
          {profile.nickname ?? id.slice(0, 8)}
        </Link>
        {' / '}
        <span className="text-gray-900">{isBanned ? '凍結解除' : '凍結'}</span>
      </nav>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        {isBanned ? '凍結解除' : 'ユーザー凍結 (BAN)'}
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        対象: <span className="font-medium text-gray-800">{profile.nickname ?? '(名前なし)'}</span>
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        {isBanned ? (
          /* 凍結解除フォーム */
          <form action={`/api/admin/users/${id}/freeze`} method="POST">
            <input type="hidden" name="_method" value="DELETE" />
            <div className="mb-4">
              <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-1">
                解除理由 <span className="text-red-500">*</span>
              </label>
              <textarea
                id="reason"
                name="reason"
                required
                rows={4}
                placeholder="凍結を解除する理由を入力してください"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
            </div>
            <div className="flex gap-3">
              <Link
                href={`/admin/users/${id}`}
                className="flex-1 text-center px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                className="flex-1 px-4 py-2 rounded-lg bg-green-500 text-white text-sm font-medium hover:bg-green-600 transition-colors"
              >
                凍結解除する
              </button>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              ※ この操作は API (DELETE /api/admin/users/{id}/freeze) を直接呼び出してください
            </p>
          </form>
        ) : (
          /* 凍結フォーム */
          <form action={`/api/admin/users/${id}/freeze`} method="POST">
            <div className="mb-4">
              <label htmlFor="reason_category" className="block text-sm font-medium text-gray-700 mb-1">
                理由カテゴリ <span className="text-red-500">*</span>
              </label>
              <select
                id="reason_category"
                name="reason_category"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              >
                <option value="">選択してください</option>
                <option value="spam">スパム</option>
                <option value="abuse">不正利用</option>
                <option value="policy_violation">規約違反</option>
                <option value="other">その他</option>
              </select>
            </div>

            <div className="mb-4">
              <label htmlFor="reason_detail" className="block text-sm font-medium text-gray-700 mb-1">
                詳細理由 <span className="text-red-500">*</span>
              </label>
              <textarea
                id="reason_detail"
                name="reason_detail"
                required
                rows={4}
                placeholder="凍結の詳細理由を入力してください"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
            </div>

            <div className="mb-4">
              <label htmlFor="ban_type" className="block text-sm font-medium text-gray-700 mb-1">
                BAN 種別 <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="ban_type" value="temporary" required defaultChecked />
                  一時 BAN
                </label>
                {isSuperAdmin && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="ban_type" value="permanent" />
                    永久 BAN (super_admin のみ)
                  </label>
                )}
              </div>
            </div>

            <div className="mb-6">
              <label htmlFor="duration_days" className="block text-sm font-medium text-gray-700 mb-1">
                BAN 期間 (日数)
                <span className="text-gray-400 text-xs ml-1">一時 BAN の場合のみ</span>
              </label>
              <input
                id="duration_days"
                name="duration_days"
                type="number"
                min={1}
                max={365}
                defaultValue={7}
                className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
            </div>

            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6">
              <p className="text-sm text-red-700 font-medium">注意</p>
              <p className="text-xs text-red-600 mt-1">
                この操作はユーザーのアクセスを停止します。admin_audit_logs に記録されます。
              </p>
            </div>

            <div className="flex gap-3">
              <Link
                href={`/admin/users/${id}`}
                className="flex-1 text-center px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </Link>
              <button
                type="submit"
                className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors"
              >
                凍結する
              </button>
            </div>
            <p className="mt-3 text-xs text-gray-400">
              ※ この操作は API (POST /api/admin/users/{id}/freeze) を直接呼び出してください
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
