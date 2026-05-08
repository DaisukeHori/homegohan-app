"use client";

/**
 * /super-admin/plans/new — プラン新規作成
 * operator/03-ui-spec.md §23 / operator/04-plan-management.md §3.1 準拠
 *
 * 9 種公式 plan_key のみ UI から作成可能 (設計書 §4 確定方針)
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const OFFICIAL_PLANS = [
  { plan_key: 'free', display_name: 'Free', plan_type: 'personal', monthly_price_jpy: 0 },
  { plan_key: 'pro', display_name: 'Pro', plan_type: 'personal', monthly_price_jpy: 980 },
  { plan_key: 'family_basic', display_name: 'Family Basic', plan_type: 'family', monthly_price_jpy: 1480 },
  { plan_key: 'family_pro', display_name: 'Family Pro', plan_type: 'family', monthly_price_jpy: 2480 },
  { plan_key: 'family_addon', display_name: 'Family Addon', plan_type: 'family', monthly_price_jpy: 280 },
  { plan_key: 'org_starter', display_name: 'Org Starter', plan_type: 'org', monthly_price_jpy: 580 },
  { plan_key: 'org_standard', display_name: 'Org Standard', plan_type: 'org', monthly_price_jpy: 980 },
  { plan_key: 'org_pro', display_name: 'Org Pro', plan_type: 'org', monthly_price_jpy: 1980 },
  { plan_key: 'org_enterprise', display_name: 'Org Enterprise', plan_type: 'org', monthly_price_jpy: null },
] as const;

type OfficialPlanKey = typeof OFFICIAL_PLANS[number]['plan_key'];

export default function PlanNewPage() {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState<OfficialPlanKey | ''>('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [monthlyPrice, setMonthlyPrice] = useState('');
  const [yearlyPrice, setYearlyPrice] = useState('');
  const [maxMembers, setMaxMembers] = useState('');
  const [trialDays, setTrialDays] = useState('0');
  const [planType, setPlanType] = useState<'personal' | 'family' | 'org'>('personal');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSelectTemplate = (key: OfficialPlanKey) => {
    const template = OFFICIAL_PLANS.find((p) => p.plan_key === key);
    if (!template) return;
    setSelectedKey(key);
    setDisplayName(template.display_name);
    setPlanType(template.plan_type as 'personal' | 'family' | 'org');
    setMonthlyPrice(template.monthly_price_jpy != null ? String(template.monthly_price_jpy) : '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedKey) {
      setError('プランテンプレートを選択してください');
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/api/super-admin/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_key: selectedKey,
          display_name: displayName,
          plan_type: planType,
          description: description || undefined,
          monthly_price_jpy: monthlyPrice !== '' ? Number(monthlyPrice) : null,
          yearly_price_jpy: yearlyPrice !== '' ? Number(yearlyPrice) : null,
          max_members: maxMembers !== '' ? Number(maxMembers) : null,
          trial_days: Number(trialDays),
        }),
      });

      const data = await res.json() as { data?: { id: string }; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '作成に失敗しました');
        return;
      }
      router.push(`/super-admin/plans/${data.data!.id}`);
    } catch {
      setError('ネットワークエラーが発生しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/super-admin/plans" className="text-slate-400 hover:text-slate-600 transition-colors">
          ← 一覧に戻る
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">新規プラン作成</h1>
      </div>

      <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-lg mb-6 text-sm">
        <strong>設計上の制約:</strong> 9 種公式プランから選択してください。プランの種別・plan_key は変更できません。
        追加設定 (価格、説明等) はテンプレート選択後に入力します。
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* テンプレート選択 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4">1. プランテンプレート選択</h2>
          <div className="grid grid-cols-3 gap-2">
            {OFFICIAL_PLANS.map((p) => (
              <button
                key={p.plan_key}
                type="button"
                onClick={() => handleSelectTemplate(p.plan_key)}
                className={`px-3 py-2.5 rounded-lg border text-left transition-all ${
                  selectedKey === p.plan_key
                    ? 'border-orange-500 bg-orange-50 text-orange-700'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="text-xs font-mono text-slate-400">{p.plan_key}</div>
                <div className="text-sm font-medium mt-0.5">{p.display_name}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 基本情報 */}
        {selectedKey && (
          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">2. 基本情報</h2>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="例: Pro"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="プランの説明 (Markdown 使用可)"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">月額 (JPY)</label>
                <input
                  type="number"
                  value={monthlyPrice}
                  onChange={(e) => setMonthlyPrice(e.target.value)}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">年額 (JPY)</label>
                <input
                  type="number"
                  value={yearlyPrice}
                  onChange={(e) => setYearlyPrice(e.target.value)}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="未設定"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">最大メンバー数</label>
                <input
                  type="number"
                  value={maxMembers}
                  onChange={(e) => setMaxMembers(e.target.value)}
                  min="1"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="無制限"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  試用期間 (日)
                  {planType === 'org' && <span className="text-red-500 ml-1 text-xs">組織プランは 0 固定</span>}
                </label>
                <input
                  type="number"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  min="0"
                  disabled={planType === 'org'}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:bg-slate-100"
                />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <Link
            href="/super-admin/plans"
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors"
          >
            キャンセル
          </Link>
          <button
            type="submit"
            disabled={isLoading || !selectedKey}
            className="px-6 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isLoading ? '作成中...' : 'draft で作成'}
          </button>
        </div>
      </form>
    </div>
  );
}
