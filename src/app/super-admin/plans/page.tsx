/**
 * /super-admin/plans — プラン定義・販売管理 一覧
 * operator/03-ui-spec.md §23 準拠
 *
 * DB 直叩きを廃止し GET /api/super-admin/plans 経由に統一。
 */

export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { adminFetch } from '@/lib/admin/fetch';

interface Plan {
  id: string;
  plan_key: string;
  display_name: string;
  plan_type: string;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  feature_packages: string[] | null;
  status: string;
  display_order: number;
}

interface PlansApiResponse {
  data: Plan[];
  meta: { total: number; page: number; per_page: number };
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: '下書き', color: 'bg-slate-100 text-slate-600' },
  public: { label: '公開中', color: 'bg-green-100 text-green-700' },
  private: { label: '非公開', color: 'bg-yellow-100 text-yellow-700' },
  deprecated: { label: '廃止', color: 'bg-red-100 text-red-700' },
};

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  personal: { label: '個人', color: 'bg-blue-100 text-blue-700' },
  family: { label: '家族', color: 'bg-purple-100 text-purple-700' },
  org: { label: '組織', color: 'bg-orange-100 text-orange-700' },
};

export default async function PlansPage() {
  try {
    await requireRole(['super_admin']);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ForbiddenError) {
      redirect('/login');
    }
    throw err;
  }

  // GET /api/super-admin/plans 経由でデータ取得
  let plans: Plan[] = [];
  let fetchError = false;

  try {
    const res = await adminFetch('/api/super-admin/plans?per_page=100');
    if (res.ok) {
      const json = (await res.json()) as PlansApiResponse;
      plans = json.data ?? [];
    } else {
      fetchError = true;
      console.error('[super-admin/plans page] API error:', res.status);
    }
  } catch (err) {
    fetchError = true;
    console.error('[super-admin/plans page] fetch failed:', err);
  }

  return (
    <div>
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">プラン管理</h1>
          <p className="text-sm text-slate-500 mt-1">subscription_plans の CRUD、価格変更、公開状態管理</p>
        </div>
        <Link
          href="/super-admin/plans/new"
          className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
        >
          + 新規プラン作成
        </Link>
      </div>

      {fetchError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          データの取得に失敗しました
        </div>
      )}

      {/* テーブル */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-slate-600">plan_key</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">表示名</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">種別</th>
              <th className="text-right px-4 py-3 font-medium text-slate-600">月額</th>
              <th className="text-right px-4 py-3 font-medium text-slate-600">年額</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">パッケージ数</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">ステータス</th>
              <th className="text-right px-4 py-3 font-medium text-slate-600">表示順</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plans.map((plan) => {
              const statusInfo = STATUS_LABELS[plan.status] ?? { label: plan.status, color: 'bg-slate-100 text-slate-600' };
              const typeInfo = TYPE_LABELS[plan.plan_type] ?? { label: plan.plan_type, color: 'bg-slate-100 text-slate-600' };
              return (
                <tr key={plan.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">{plan.plan_key}</code>
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">{plan.display_name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeInfo.color}`}>
                      {typeInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {plan.monthly_price_jpy != null ? `¥${plan.monthly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {plan.yearly_price_jpy != null ? `¥${plan.yearly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-center text-slate-700">
                    {plan.feature_packages?.length ?? 0}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-500">{plan.display_order}</td>
                  <td className="px-4 py-3 text-center">
                    <Link
                      href={`/super-admin/plans/${plan.id}`}
                      className="text-orange-500 hover:text-orange-600 font-medium text-xs"
                    >
                      編集
                    </Link>
                  </td>
                </tr>
              );
            })}
            {plans.length === 0 && !fetchError && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                  プランがありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
