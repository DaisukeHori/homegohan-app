/**
 * /super-admin/coupons — クーポン管理一覧
 * operator/03-ui-spec.md §14 準拠
 *
 * DB 直叩きを廃止し GET /api/super-admin/coupons 経由に統一。
 */

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireRoleForPage } from '@/lib/auth/page-guard';
import { adminFetch } from '@/lib/admin/fetch';
import { listRowsOfBody } from '@/lib/admin/admin-screen-messages';
import { couponValidityDay, isCouponExpiredAt } from '@/lib/super-admin/coupon-validity';

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
  // 未認証 → /login?next=・2FA 未完了 → MFA の画面・ロール不足 / 凍結 → /login (#1176。docs/design/cross/12-operator-mfa.md §13.4.2)
  await requireRoleForPage(['super_admin'], { next: '/super-admin/coupons' });

  // GET /api/super-admin/coupons 経由でデータ取得
  let coupons: Coupon[] = [];
  let fetchError = false;

  try {
    const res = await adminFetch('/api/super-admin/coupons?per_page=100');
    if (res.ok) {
      // 200 なのに本文が読めない・data が配列でない壊れた応答は、0 件と見せずに取得の失敗として扱う (#2101 X8)
      const rows = listRowsOfBody<Coupon>(await res.json().catch(() => null));
      if (rows === null) {
        fetchError = true;
        console.error('[super-admin/coupons page] malformed list body');
      } else {
        coupons = rows;
      }
    } else {
      fetchError = true;
      console.error('[super-admin/coupons page] API error:', res.status);
    }
  } catch (err) {
    fetchError = true;
    console.error('[super-admin/coupons page] fetch failed:', err);
  }

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
            {coupons.map((coupon) => {
              const statusInfo = STATUS_LABELS[coupon.status] ?? { label: coupon.status, color: 'bg-slate-100 text-slate-500' };
              const isExpired = isCouponExpiredAt(coupon.valid_until, new Date());
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
                      {couponValidityDay(coupon.valid_until)}
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
            {coupons.length === 0 && !fetchError && (
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
