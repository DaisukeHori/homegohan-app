"use client";

/**
 * /super-admin/coupons/new — クーポン新規作成
 * operator/03-ui-spec.md §14 (「+ 新規クーポン」モーダル相当) /
 * operator/04-plan-management.md §4.1 準拠
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { todayLocal } from '@/lib/date-utils';
import {
  AdminScreenError,
  adminActionHttpFailedMessage,
  adminActionNoResponseMessage,
  adminCreatedButUnreadableMessage,
  adminScreenErrorOfResponse,
  createdRowIdOfResponse,
  displayableAdminError,
} from '@/lib/admin/admin-screen-messages';
import { PLAN_CATALOG, formatJpy, planDisplayName, type PaidPlanKey } from '@homegohan/shared';
import {
  COUPON_APPLICABLE_TO,
  COUPON_APPLICABLE_TO_LABELS,
  type CouponApplicableTo,
} from '@/lib/super-admin/coupons-schemas';

/** 作成の失敗の文の操作の名前 (「クーポンの作成に失敗しました (HTTP 502)」。#2093 W7) */
const COUPON_CREATE_ACTION = 'クーポンの作成';

const COUPON_PREVIEW_PLAN_KEY: PaidPlanKey = 'pro'; // 粗利のプレビューの基準 = 個人 Pro の月額 (billing/03 §8.9)

// Stripe 手数料: 3.6% + ¥40 (operator/04-plan-management.md §4.1 §15.12)
function calcGrossMargin(priceJpy: number, discountPercent: number = 0): number {
  const effective = priceJpy * (1 - discountPercent / 100);
  const fee = effective * 0.036 + 40;
  return Math.round(effective - fee);
}

export default function CouponNewPage() {
  const router = useRouter();

  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [discountType, setDiscountType] = useState<'fixed' | 'percentage'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [applicableTo, setApplicableTo] = useState<CouponApplicableTo>('all');
  // 有効開始日の初期値は JST の今日 (#1483。API は JST の暦日を受け取り、その日の JST 0:00 から有効にする)
  const [validFrom, setValidFrom] = useState(todayLocal());
  const [validUntil, setValidUntil] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [perUserLimit, setPerUserLimit] = useState('1');
  const [durationMonths, setDurationMonths] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // 粗利プレビュー (個人 Pro の月額で計算。価格は公開の価格の写し PLAN_CATALOG から読む)
  const typicalPrice = PLAN_CATALOG.find((p) => p.plan_key === COUPON_PREVIEW_PLAN_KEY)?.monthly_price_jpy ?? 0;
  const grossMarginPreview = discountType === 'percentage' && discountValue
    ? calcGrossMargin(typicalPrice, Number(discountValue))
    : null;

  const handleGenerateCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    setCode(code);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // 失敗は日本語の文の例外にする。ok を先に確かめ、JSON でない 502 を「ネットワークエラー」と見せない
      // (本文に日本語の文が無ければ「<作成>に失敗しました (HTTP 502)」、通信そのものの失敗は「<作成>の応答を受け取れませんでした」。#2093 W7)
      let res: Response;
      try {
        res = await fetch('/api/super-admin/coupons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: code.toUpperCase(),
            display_name: displayName || undefined,
            discount_type: discountType,
            discount_value: Number(discountValue),
            applicable_to: applicableTo,
            // JST の暦日 (YYYY-MM-DD) のまま送る。API が開始日の JST 0:00・期限の日の JST 23:59:59 の時刻にして書く (#1483)
            valid_from: validFrom,
            valid_until: validUntil,
            max_uses: maxUses ? Number(maxUses) : null,
            per_user_limit: Number(perUserLimit),
            duration_months: durationMonths ? Number(durationMonths) : null,
            gross_margin_preview_jpy: grossMarginPreview,
          }),
        });
      } catch {
        throw new AdminScreenError(adminActionNoResponseMessage(COUPON_CREATE_ACTION));
      }
      if (!res.ok) {
        throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(COUPON_CREATE_ACTION, status));
      }
      // 成功の応答の本文が読めない: 作成は済んでいるので失敗とは言わず、一覧で確かめるよう促す (作った行の画面へは移れない)
      const createdId = await createdRowIdOfResponse(res);
      if (createdId === null) {
        setError(adminCreatedButUnreadableMessage(COUPON_CREATE_ACTION));
        return;
      }
      router.push(`/super-admin/coupons/${createdId}`);
    } catch (err) {
      setError(displayableAdminError(err, `${COUPON_CREATE_ACTION}に失敗しました`));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/super-admin/coupons" className="text-slate-400 hover:text-slate-600 text-sm">
          ← 一覧に戻る
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">新規クーポン作成</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        {/* コード */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">クーポンコード *</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              pattern="^[A-Z0-9_-]+$"
              className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
              placeholder="例: SUMMER2026"
            />
            <button
              type="button"
              onClick={handleGenerateCode}
              className="px-3 py-2 border border-slate-200 text-slate-600 rounded-lg text-xs hover:bg-slate-50 transition-colors whitespace-nowrap"
            >
              自動生成
            </button>
          </div>
        </div>

        {/* 表示名 */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示名</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="例: 夏のスペシャルキャンペーン"
          />
        </div>

        {/* 割引種別・値 */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">割引種別 *</label>
          <div className="flex gap-4 mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="percentage"
                checked={discountType === 'percentage'}
                onChange={() => setDiscountType('percentage')}
                className="accent-orange-500"
              />
              <span className="text-sm">パーセント (%)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="fixed"
                checked={discountType === 'fixed'}
                onChange={() => setDiscountType('fixed')}
                className="accent-orange-500"
              />
              <span className="text-sm">固定額 (円)</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              required
              min="0.01"
              max={discountType === 'percentage' ? '100' : undefined}
              step="0.01"
              className="w-32 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              placeholder="20"
            />
            <span className="text-slate-500 text-sm">{discountType === 'percentage' ? '%' : '円'}</span>
          </div>
          {/* 粗利プレビュー (operator/04-plan-management.md §4.1) */}
          {grossMarginPreview !== null && (
            <div className="mt-2 bg-slate-50 border border-slate-200 rounded px-3 py-2 text-xs text-slate-600">
              実質粗利プレビュー ({planDisplayName(COUPON_PREVIEW_PLAN_KEY)} {formatJpy(typicalPrice)} 基準): <strong>¥{grossMarginPreview.toLocaleString()}</strong>
              <span className="text-slate-400 ml-2">(Stripe 手数料 3.6%+¥40 控除後)</span>
            </div>
          )}
        </div>

        {/* 適用対象 */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">適用対象</label>
          <select
            value={applicableTo}
            onChange={(e) => {
              const next = COUPON_APPLICABLE_TO.find((value) => value === e.target.value);
              if (next !== undefined) setApplicableTo(next);
            }}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          >
            {/* 選択肢は値の一覧と表示名の表から作る (一覧・詳細と同じ語。#2112 Z3) */}
            {COUPON_APPLICABLE_TO.map((value) => (
              <option key={value} value={value}>
                {COUPON_APPLICABLE_TO_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {/* 有効期限 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">有効開始日 *</label>
            <input
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">有効終了日 *</label>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              required
              min={validFrom}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>

        {/* 利用上限 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">最大利用回数</label>
            <input
              type="number"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              min="1"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              placeholder="無制限"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">ユーザー毎の上限</label>
            <input
              type="number"
              value={perUserLimit}
              onChange={(e) => setPerUserLimit(e.target.value)}
              min="1"
              required
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>
        </div>

        {/* 割引期間 */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">割引期間 (月)</label>
          <input
            type="number"
            value={durationMonths}
            onChange={(e) => setDurationMonths(e.target.value)}
            min="1"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="ずっと (空欄)"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Link
            href="/super-admin/coupons"
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors"
          >
            キャンセル
          </Link>
          <button
            type="submit"
            disabled={isLoading}
            className="px-6 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isLoading ? '作成中...' : '作成する'}
          </button>
        </div>
      </form>
    </div>
  );
}
