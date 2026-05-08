/**
 * /super-admin/coupons — クーポン管理一覧
 * operator/03-ui-spec.md §14 準拠
 */

import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

type Coupon = {
  id: string;
  code: string;
  display_name: string | null;
  discount_type: 'fixed' | 'percentage';
  discount_value: number;
  applicable_to: string;
  valid_from: string;
  valid_until: string;
  uses_count: number;
  max_uses: number | null;
  status: string;
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  active: { label: '有効', color: 'bg-green-100 text-green-700' },
  paused: { label: '停止中', color: 'bg-yellow-100 text-yellow-700' },
  expired: { label: '期限切れ', color: 'bg-slate-100 text-slate-500' },
};

function formatDiscount(coupon: Coupon): string {
  if (coupon.discount_type === 'percentage') return `${coupon.discount_value}%`;
  return `¥${coupon.discount_value.toLocaleString()} OFF`;
}

export default async function CouponsPage() {
  const supabase = createClient();

  const { data: coupons, error } = await supabase
    .from('coupons')
    .select('id, code, display_name, discount_type, discount_value, applicable_to, valid_from, valid_until, uses_count, max_uses, status')
    .order('created_at', { ascending: false });

  return (
    <div>
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">クーポン管理</h1>
          <p className="text-sm text-slate-500 mt-1">割引コードの作成・管理</p>
        </div>
        <Link
          href="/super-admin/coupons/new"
          className="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
        >
          + 新規クーポン
        </Link>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">
          データの取得に失敗しました: {error.message}
        </div>
      )}

      {/* テーブル */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-slate-600">コード</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">割引</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">対象</th>
              <th className="text-left px-4 py-3 font-medium text-slate-600">有効期限</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">利用数</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">ステータス</th>
              <th className="text-center px-4 py-3 font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(coupons as Coupon[] ?? []).map((coupon) => {
              const statusInfo = STATUS_LABELS[coupon.status] ?? { label: coupon.status, color: 'bg-slate-100 text-slate-500' };
              const isExpired = new Date(coupon.valid_until) < new Date();
              return (
                <tr key={coupon.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">{coupon.code}</code>
                    {coupon.display_name && (
                      <p className="text-xs text-slate-400 mt-0.5">{coupon.display_name}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {formatDiscount(coupon)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{coupon.applicable_to}</td>
                  <td className="px-4 py-3">
                    <span className={isExpired ? 'text-red-500' : 'text-slate-600'}>
                      {new Date(coupon.valid_until).toLocaleDateString('ja-JP')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center text-slate-700">
                    {coupon.uses_count}
                    {coupon.max_uses != null && (
                      <span className="text-slate-400"> / {coupon.max_uses}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Link
                      href={`/super-admin/coupons/${coupon.id}`}
                      className="text-orange-500 hover:text-orange-600 font-medium text-xs"
                    >
                      詳細
                    </Link>
                  </td>
                </tr>
              );
            })}
            {(coupons ?? []).length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                  クーポンがありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
