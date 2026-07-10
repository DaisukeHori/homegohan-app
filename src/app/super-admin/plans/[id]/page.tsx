"use client";

/**
 * /super-admin/plans/[id] — プラン詳細・編集
 * operator/03-ui-spec.md §24 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Plan = {
  id: string;
  plan_key: string;
  display_name: string;
  plan_type: string;
  description: string | null;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  max_members: number | null;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  status: string;
  display_order: number;
  trial_days: number;
  feature_packages: string[];
  price_history: PriceHistoryEntry[];
};

type PriceHistoryEntry = {
  id: string;
  old_monthly_price_jpy: number | null;
  new_monthly_price_jpy: number | null;
  reason: string | null;
  applies_to: string;
  changed_by: string;
  created_at: string;
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: '下書き', color: 'bg-slate-100 text-slate-600' },
  public: { label: '公開中', color: 'bg-green-100 text-green-700' },
  private: { label: '非公開', color: 'bg-yellow-100 text-yellow-700' },
  deprecated: { label: '廃止', color: 'bg-red-100 text-red-700' },
};

export default function PlanDetailPage() {
  const params = useParams();
  const planId = params.id as string;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  // 編集フィールド
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [activeTab, setActiveTab] = useState<'basic' | 'price' | 'history'>('basic');

  const fetchPlan = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`);
      const data = await res.json() as { data?: Plan; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? 'プランの取得に失敗しました');
        return;
      }
      setPlan(data.data!);
      setDisplayName(data.data!.display_name);
      setDescription(data.data!.description ?? '');
      setBannerUrl('');
      setDisplayOrder(data.data!.display_order);
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsLoading(false);
    }
  }, [planId]);

  useEffect(() => {
    fetchPlan();
  }, [fetchPlan]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          description: description || null,
          banner_url: bannerUrl || null,
          display_order: displayOrder,
        }),
      });
      const data = await res.json() as { data?: Plan; error?: { message: string } };
      if (!res.ok) {
        setSaveError(data.error?.message ?? '保存に失敗しました');
        return;
      }
      setSaveSuccess(true);
      setPlan(data.data!);
    } catch {
      setSaveError('ネットワークエラー');
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusChange = async (newStatus: 'public' | 'private') => {
    const confirm = window.confirm(
      newStatus === 'public' ? 'このプランを公開しますか？' : 'このプランを非公開にしますか？'
    );
    if (!confirm) return;

    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        fetchPlan();
        return;
      }
      // #1041 修正: 失敗時 (422/400/403 等) に無反応にせず、必ずエラーを表示する
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      alert(data?.error?.message ?? `ステータス変更に失敗しました (HTTP ${res.status})`);
    } catch {
      alert('ステータス変更に失敗しました (ネットワークエラー)');
    }
  };

  // #1041 修正: public/private --> deprecated への廃止移行を許可 (以前は恒久ロックされていた)
  const handleDeprecate = async () => {
    const endsAtInput = window.prompt('廃止予定日 (YYYY-MM-DD) を入力してください');
    if (!endsAtInput) return;
    const endsAtDate = new Date(`${endsAtInput}T00:00:00.000Z`);
    if (Number.isNaN(endsAtDate.getTime())) {
      alert('日付の形式が不正です (例: 2026-12-31)');
      return;
    }
    if (!window.confirm(`このプランを ${endsAtInput} 廃止予定で廃止しますか？`)) return;

    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated', ends_at: endsAtDate.toISOString() }),
      });
      if (res.ok) {
        fetchPlan();
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      alert(data?.error?.message ?? `廃止処理に失敗しました (HTTP ${res.status})`);
    } catch {
      alert('廃止処理に失敗しました (ネットワークエラー)');
    }
  };

  // deprecated --> private への緊急ロールバック (public には戻さない)
  const handleUndeprecate = async () => {
    if (!window.confirm('廃止を取り消し、非公開状態に戻しますか？')) return;
    try {
      const res = await fetch(`/api/super-admin/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'private' }),
      });
      if (res.ok) {
        fetchPlan();
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      alert(data?.error?.message ?? `廃止取り消しに失敗しました (HTTP ${res.status})`);
    } catch {
      alert('廃止取り消しに失敗しました (ネットワークエラー)');
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !plan) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || 'プランが見つかりません'}
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[plan.status] ?? { label: plan.status, color: 'bg-slate-100 text-slate-600' };
  const isEditable = plan.status === 'draft' || plan.status === 'public' || plan.status === 'private';

  return (
    <div className="max-w-3xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/plans" className="text-slate-400 hover:text-slate-600 transition-colors text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-xl font-bold text-slate-900">{plan.display_name}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {plan.status === 'draft' && (
            <button
              onClick={() => handleStatusChange('public')}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors"
            >
              公開する
            </button>
          )}
          {plan.status === 'public' && (
            <button
              onClick={() => handleStatusChange('private')}
              className="px-3 py-1.5 bg-yellow-500 text-white rounded-lg text-xs font-medium hover:bg-yellow-600 transition-colors"
            >
              非公開にする
            </button>
          )}
          {plan.status === 'private' && (
            <button
              onClick={() => handleStatusChange('public')}
              className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium hover:bg-green-600 transition-colors"
            >
              再公開する
            </button>
          )}
          {(plan.status === 'public' || plan.status === 'private') && (
            <Link
              href={`/super-admin/plans/${plan.id}/price-change`}
              className="px-3 py-1.5 bg-orange-500 text-white rounded-lg text-xs font-medium hover:bg-orange-600 transition-colors"
            >
              価格変更
            </Link>
          )}
          {(plan.status === 'public' || plan.status === 'private') && (
            <button
              onClick={handleDeprecate}
              className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs font-medium hover:bg-red-600 transition-colors"
            >
              廃止する
            </button>
          )}
          {plan.status === 'deprecated' && (
            <button
              onClick={handleUndeprecate}
              className="px-3 py-1.5 bg-slate-500 text-white rounded-lg text-xs font-medium hover:bg-slate-600 transition-colors"
            >
              廃止を取り消す
            </button>
          )}
        </div>
      </div>

      {/* タブ */}
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {(['basic', 'price', 'history'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab === 'basic' ? '基本情報' : tab === 'price' ? '価格設定' : '価格変更履歴'}
          </button>
        ))}
      </div>

      {/* 基本情報タブ */}
      {activeTab === 'basic' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">plan_key</label>
              <code className="font-mono text-sm bg-slate-100 px-2 py-1 rounded">{plan.plan_key}</code>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">種別</label>
              <span className="text-sm text-slate-700">{plan.plan_type}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={!isEditable}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!isEditable}
              rows={4}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示順</label>
            <input
              type="number"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(Number(e.target.value))}
              disabled={!isEditable}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-50"
            />
          </div>

          <div className="flex items-center gap-4 pt-2">
            <div className="text-sm text-slate-500">最大メンバー: {plan.max_members ?? '無制限'}</div>
            <div className="text-sm text-slate-500">試用期間: {plan.trial_days} 日</div>
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

          {isEditable && (
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
              >
                {isSaving ? '保存中...' : '保存する'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 価格設定タブ */}
      {activeTab === 'price' && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">月額</label>
              <p className="text-2xl font-bold text-slate-800">
                {plan.monthly_price_jpy != null ? `¥${plan.monthly_price_jpy.toLocaleString()}` : '—'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">年額</label>
              <p className="text-2xl font-bold text-slate-800">
                {plan.yearly_price_jpy != null ? `¥${plan.yearly_price_jpy.toLocaleString()}` : '—'}
              </p>
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-500 mb-2">Stripe 連携</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Product ID:</span>
                <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                  {plan.stripe_product_id ?? '未設定'}
                </code>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Price ID:</span>
                <code className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                  {plan.stripe_price_id ? `${plan.stripe_price_id.slice(0, 12)}...` : '未設定'}
                </code>
              </div>
            </div>
          </div>

          {(plan.status === 'public' || plan.status === 'private') && (
            <div className="pt-4">
              <Link
                href={`/super-admin/plans/${plan.id}/price-change`}
                className="inline-block px-4 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
              >
                価格変更フローを開始
              </Link>
              <p className="text-xs text-slate-400 mt-2">
                価格変更は影響シミュレーション → 確認 → 実行の 3 ステップで行います
              </p>
            </div>
          )}
        </div>
      )}

      {/* 価格変更履歴タブ */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">変更日</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">旧月額</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">新月額</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">適用範囲</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">理由</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(plan.price_history ?? []).map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-600">
                    {new Date(h.created_at).toLocaleDateString('ja-JP')}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-500">
                    {h.old_monthly_price_jpy != null ? `¥${h.old_monthly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-800">
                    {h.new_monthly_price_jpy != null ? `¥${h.new_monthly_price_jpy.toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">{h.applies_to}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs truncate max-w-xs">{h.reason ?? '—'}</td>
                </tr>
              ))}
              {(plan.price_history ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                    価格変更履歴がありません
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
