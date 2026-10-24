"use client";

/**
 * /super-admin/coupons/[id] — クーポン詳細・編集
 * operator/03-ui-spec.md §14 / operator/04-plan-management.md §4.1 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { couponValidityDay, couponValidUntilPatchValue } from '@/lib/super-admin/coupon-validity';

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

type RedemptionsResponse = {
  data?: Redemption[];
  meta?: { total?: number; page?: number; per_page?: number };
  error?: { message?: string };
};

/** 適用履歴の API (GET /api/super-admin/coupons/{id}/redemptions) のページ番号は 1 から */
const FIRST_REDEMPTIONS_PAGE = 1;

/** 保存で送る本文 (PATCH /api/super-admin/coupons/{id} の表示名・有効期限・最大利用回数) */
type CouponSaveBody = {
  display_name?: string | null;
  valid_until?: string;
  max_uses?: number | null;
};

/** 最大利用回数の入力欄の文字 (空欄は無制限) */
function maxUsesText(maxUses: number | null): string {
  return maxUses != null ? String(maxUses) : '';
}

/**
 * 保存で送る本文。最後に読んだ・保存したクーポン (coupon) から変えた欄だけを入れる (#1917)。
 * 手を付けていない欄を送ると、画面を開いたあとに別の運営が変えたその欄を、開いたときの古い値で上書きしてしまう
 * (route は送られた項目をそのまま書く)。有効期限は JST の暦日で比べる (#1483 の couponValidUntilPatchValue)。
 * 表示名の空欄は null、最大利用回数の空欄は null (無制限) にする (これまでと同じ)
 */
function changedCouponFields(
  inputs: { displayName: string; validUntil: string; maxUses: string },
  coupon: Coupon,
): CouponSaveBody {
  const body: CouponSaveBody = {};
  if (inputs.displayName !== (coupon.display_name ?? '')) body.display_name = inputs.displayName || null;
  const validUntil = couponValidUntilPatchValue(inputs.validUntil, coupon.valid_until);
  if (validUntil !== undefined) body.valid_until = validUntil;
  if (inputs.maxUses !== maxUsesText(coupon.max_uses)) body.max_uses = inputs.maxUses ? Number(inputs.maxUses) : null;
  return body;
}

/** 保存を押したが、どの入力欄も最後に読んだ・保存した値から変えていなかったときの文 (送らない。#1917) */
const NO_COUPON_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

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
  const [redemptionsTotal, setRedemptionsTotal] = useState<number | null>(null);
  const [redemptionsPage, setRedemptionsPage] = useState(FIRST_REDEMPTIONS_PAGE);
  const [redemptionsError, setRedemptionsError] = useState('');
  const [isLoadingRedemptions, setIsLoadingRedemptions] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  // 保存を押したが送らなかったときの文 (変えた欄が無い。#1917)
  const [saveInfo, setSaveInfo] = useState('');
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
      // 有効期限 (DB の時刻) を JST の暦日にして編集欄に入れる (#1483)
      setValidUntil(couponValidityDay(data.data!.valid_until));
      setMaxUses(maxUsesText(data.data!.max_uses));
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsLoading(false);
    }
  }, [couponId]);

  // 適用履歴 (#1571): API の既定のページ送り (1 ページ 50 件・meta.total) で読む。
  // 1 ページ目は ?page を付けずに呼び (API の既定)、「さらに読み込む」で次のページを足していく。
  // 取得に失敗したら黙って捨てず、画面に出す (#1570 の 404 が長く気づかれなかったため)。
  const fetchRedemptions = useCallback(async (page: number = FIRST_REDEMPTIONS_PAGE) => {
    if (!coupon) return;
    const isFirstPage = page === FIRST_REDEMPTIONS_PAGE;
    setIsLoadingRedemptions(true);
    setRedemptionsError('');
    try {
      const url = `/api/super-admin/coupons/${coupon.id}/redemptions${isFirstPage ? '' : `?page=${page}`}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({})) as RedemptionsResponse;
      if (!res.ok || !Array.isArray(data.data)) {
        // 1 ページ目が取れなかったときは、前に読んだ履歴を「いまの履歴」として残さない (次のページの失敗なら、読んだ分は残す)
        if (isFirstPage) {
          setRedemptions([]);
          setRedemptionsTotal(null);
        }
        setRedemptionsError(data.error?.message ?? '適用履歴の取得に失敗しました');
        return;
      }
      const rows = data.data;
      setRedemptions((prev) => (isFirstPage ? rows : [...prev, ...rows]));
      setRedemptionsTotal(data.meta?.total ?? null);
      setRedemptionsPage(page);
    } catch {
      if (isFirstPage) {
        setRedemptions([]);
        setRedemptionsTotal(null);
      }
      setRedemptionsError('ネットワークエラーで適用履歴を取得できませんでした');
    } finally {
      setIsLoadingRedemptions(false);
    }
  }, [coupon]);

  useEffect(() => {
    fetchCoupon();
  }, [fetchCoupon]);

  useEffect(() => {
    if (activeTab === 'redemptions') fetchRedemptions(FIRST_REDEMPTIONS_PAGE);
  }, [activeTab, fetchRedemptions]);

  const handleSave = async () => {
    if (!coupon) return;
    setSaveError('');
    setSaveSuccess(false);
    setSaveInfo('');
    // 送るのは、最後に読んだ・保存した値から変えた欄だけ (手を付けていない欄を古い値で上書きしない。#1917)。
    // 有効期限は JST の暦日 (YYYY-MM-DD) のまま送り、API がその日の JST 23:59:59 の時刻にして書く (#1483)
    const changes = changedCouponFields({ displayName, validUntil, maxUses }, coupon);
    if (Object.keys(changes).length === 0) {
      setSaveInfo(NO_COUPON_CHANGES_MESSAGE);
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`/api/super-admin/coupons/${couponId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
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
              onChange={(e) => { setDisplayName(e.target.value); setSaveInfo(''); }}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">有効期限</label>
              <input
                type="date"
                value={validUntil}
                onChange={(e) => { setValidUntil(e.target.value); setSaveInfo(''); }}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">最大利用回数</label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => { setMaxUses(e.target.value); setSaveInfo(''); }}
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
          {saveInfo && (
            <div
              data-testid="save-info"
              className="bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-sm"
            >
              {saveInfo}
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
          {redemptionsError && (
            <div role="alert" data-testid="redemptions-error" className="px-4 py-3 text-sm text-red-700 bg-red-50 border-b border-red-200">
              {redemptionsError}
            </div>
          )}
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
              {redemptions.length === 0 && !redemptionsError && !isLoadingRedemptions && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                    適用履歴がありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {redemptionsTotal !== null && redemptions.length < redemptionsTotal && (
            <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-sm text-slate-500">
              <span>{redemptions.length} / {redemptionsTotal} 件を表示</span>
              <button
                type="button"
                data-testid="redemptions-load-more"
                onClick={() => fetchRedemptions(redemptionsPage + 1)}
                disabled={isLoadingRedemptions}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoadingRedemptions ? '読み込み中...' : 'さらに読み込む'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
