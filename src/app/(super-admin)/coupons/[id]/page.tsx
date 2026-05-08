"use client";

/**
 * /super-admin/coupons/[id] — クーポン詳細・編集
 * operator/03-ui-spec.md §14 / operator/04-plan-management.md §4.1 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Coupon = {
  id: string;
  code: string;
  display_name: string | null;
  discount_type: 'fixed' | 'percentage';
  discount_value: number;
  applicable_to: string;
  applicable_plans: string[];
  valid_from: string;
  valid_until: string;
  max_uses: number | null;
  uses_count: number;
  per_user_limit: number;
  duration_months: number | null;
  gross_margin_preview_jpy: number | null;
  status: string;
  created_by: string;
  created_at: string;
};

type Redemption = {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  subscription_target: string;
  discount_amount_jpy: number;
  redeemed_at: string;
  ended_at: string | null;
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  active: { label: '有効', color: 'bg-green-100 text-green-700' },
  paused: { label: '停止中', color: 'bg-yellow-100 text-yellow-700' },
  expired: { label: '期限切れ', color: 'bg-slate-100 text-slate-500' },
};

export default function CouponDetailPage() {
  const params = useParams();
  const couponId = params.id as string;

  const [coupon, setCoupon] = useState<Coupon | null>(null);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'detail' | 'redemptions'>('detail');

  const [displayName, setDisplayName] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [maxUses, setMaxUses] = useState('');

  const fetchCoupon = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/super-admin/coupons/${couponId}`);
      const data = await res.json() as { data?: Coupon; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '取得に失敗しました');
        return;
      }
      setCoupon(data.data!);
      setDisplayName(data.data!.display_name ?? '');
      setValidUntil(data.data!.valid_until.slice(0, 10));
      setMaxUses(data.data!.max_uses != null ? String(data.data!.max_uses) : '');
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsLoading(false);
    }
  }, [couponId]);

  const fetchRedemptions = useCallback(async () => {
    if (!coupon) return;
    try {
      const res = await fetch(`/api/super-admin/coupons/${coupon.code}/redemptions`);
      const data = await res.json() as { data?: Redemption[] };
      if (data.data) setRedemptions(data.data);
    } catch {
      // non-critical
    }
  }, [coupon]);

  useEffect(() => {
    fetchCoupon();
  }, [fetchCoupon]);

  useEffect(() => {
    if (activeTab === 'redemptions') fetchRedemptions();
  }, [activeTab, fetchRedemptions]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const res = await fetch(`/api/super-admin/coupons/${couponId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName || null,
          valid_until: new Date(validUntil).toISOString(),
          max_uses: maxUses ? Number(maxUses) : null,
        }),
      });
      const data = await res.json() as { data?: Coupon; error?: { message: string } };
      if (!res.ok) {
        setSaveError(data.error?.message ?? '保存に失敗しました');
        return;
      }
      setCoupon(data.data!);
      setSaveSuccess(true);
    } catch {
      setSaveError('ネットワークエラー');
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusChange = async (newStatus: 'active' | 'paused') => {
    const label = newStatus === 'paused' ? '停止' : '再開';
    if (!confirm(`このクーポンを${label}しますか？`)) return;
    try {
      const res = await fetch(`/api/super-admin/coupons/${couponId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) fetchCoupon();
    } catch {
      alert('ステータス変更に失敗しました');
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !coupon) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || 'クーポンが見つかりません'}
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[coupon.status] ?? { label: coupon.status, color: 'bg-slate-100 text-slate-500' };

  return (
    <div className="max-w-3xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/coupons" className="text-slate-400 hover:text-slate-600 text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <code className="font-mono font-bold text-slate-900">{coupon.code}</code>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {coupon.status === 'active' && (
            <button
              onClick={() => handleStatusChange('paused')}
              className="px-3 py-1.5 border border-yellow-300 text-yellow-600 rounded-lg text-xs font-medium hover:bg-yellow-50 transition-colors"
            >
              一時停止
            </button>
          )}
          {coupon.status === 'paused' && (
            <button
              onClick={() => handleStatusChange('active')}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors"
            >
              再開する
            </button>
          )}
        </div>
      </div>

      {/* タブ */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(['detail', 'redemptions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab === 'detail' ? '詳細' : `適用履歴 (${coupon.uses_count})`}
          </button>
        ))}
      </div>

      {/* 詳細タブ */}
      {activeTab === 'detail' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4 pb-4 border-b border-slate-100">
            <div>
              <span className="text-xs text-slate-500">割引</span>
              <p className="text-2xl font-bold text-slate-800">
                {coupon.discount_type === 'percentage'
                  ? `${coupon.discount_value}%`
                  : `¥${coupon.discount_value.toLocaleString()} OFF`}
              </p>
            </div>
            <div>
              <span className="text-xs text-slate-500">利用数</span>
              <p className="text-2xl font-bold text-slate-800">
                {coupon.uses_count}
                {coupon.max_uses != null && <span className="text-slate-400 text-base"> / {coupon.max_uses}</span>}
              </p>
            </div>
            {coupon.gross_margin_preview_jpy != null && (
              <div>
                <span className="text-xs text-slate-500">実質粗利プレビュー</span>
                <p className="text-lg font-semibold text-slate-700">
                  ¥{coupon.gross_margin_preview_jpy.toLocaleString()}
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示名</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">有効期限</label>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">最大利用回数</label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                min={coupon.uses_count}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="無制限"
              />
            </div>
          </div>

          <div className="text-xs text-slate-400 grid grid-cols-2 gap-2">
            <div>適用対象: {coupon.applicable_to}</div>
            <div>1 ユーザー上限: {coupon.per_user_limit} 回</div>
            <div>割引期間: {coupon.duration_months != null ? `${coupon.duration_months} ヶ月` : 'ずっと'}</div>
            <div>作成日: {new Date(coupon.created_at).toLocaleDateString('ja-JP')}</div>
          </div>

          {saveError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {saveError}
            </div>
          )}
          {saveSuccess && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
              保存しました
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
            >
              {isSaving ? '保存中...' : '保存する'}
            </button>
          </div>
        </div>
      )}

      {/* 適用履歴タブ */}
      {activeTab === 'redemptions' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">適用日</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">対象</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">割引額</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">ステータス</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {redemptions.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">
                    {new Date(r.redeemed_at).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {r.subscription_target} / {r.user_id ? r.user_id.slice(0, 8) : r.organization_id?.slice(0, 8)}...
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-800">
                    ¥{r.discount_amount_jpy.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      r.ended_at ? 'bg-slate-100 text-slate-500' : 'bg-green-100 text-green-700'
                    }`}>
                      {r.ended_at ? '終了' : '有効'}
                    </span>
                  </td>
                </tr>
              ))}
              {redemptions.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    適用履歴がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
