"use client";

/**
 * /super-admin/plans/[id]/price-change — 価格変更フロー
 * operator/03-ui-spec.md §24 (価格変更モーダル) / operator/04-plan-management.md §3.3 準拠
 *
 * Step1: 新価格入力 + 影響シミュレーション
 * Step2: 確認 → 実行
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

type ImpactData = {
  affected_subscription_count: number;
  affected_mrr_change_jpy: number;
  current_monthly_price_jpy: number;
  new_monthly_price_jpy: number;
  applies_to: string;
};

type Plan = {
  id: string;
  plan_key: string;
  display_name: string;
  monthly_price_jpy: number | null;
  yearly_price_jpy: number | null;
  status: string;
};

const APPLIES_TO_LABELS: Record<string, string> = {
  new_only: '新規契約のみ',
  on_renewal: '次回更新時から全契約',
  immediately: '即時に全契約 (日割り適用)',
};

export default function PriceChangePage() {
  const params = useParams();
  const router = useRouter();
  const planId = params.id as string;

  const [plan, setPlan] = useState<Plan | null>(null);
  const [newMonthlyPrice, setNewMonthlyPrice] = useState('');
  const [newYearlyPrice, setNewYearlyPrice] = useState('');
  const [appliesTo, setAppliesTo] = useState<'new_only' | 'on_renewal' | 'immediately'>('new_only');
  const [reason, setReason] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(new Date().toISOString().slice(0, 16));
  const [impact, setImpact] = useState<ImpactData | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const [simulateError, setSimulateError] = useState('');

  useEffect(() => {
    const fetchPlan = async () => {
      const res = await fetch(`/api/super-admin/plans/${planId}`);
      const data = await res.json() as { data?: Plan };
      if (data.data) {
        setPlan(data.data);
        setNewMonthlyPrice(data.data.monthly_price_jpy != null ? String(data.data.monthly_price_jpy) : '');
        setNewYearlyPrice(data.data.yearly_price_jpy != null ? String(data.data.yearly_price_jpy) : '');
      }
    };
    fetchPlan();
  }, [planId]);

  const handleSimulate = useCallback(async () => {
    if (!newMonthlyPrice && !newYearlyPrice) {
      setSimulateError('月額または年額を入力してください');
      return;
    }
    setIsSimulating(true);
    setSimulateError('');
    try {
      const params = new URLSearchParams();
      if (newMonthlyPrice) params.set('new_monthly_price_jpy', newMonthlyPrice);
      params.set('applies_to', appliesTo);
      const res = await fetch(`/api/super-admin/plans/${planId}/price-impact?${params.toString()}`);
      const data = await res.json() as { data?: ImpactData; error?: { message: string } };
      if (!res.ok) {
        setSimulateError(data.error?.message ?? 'シミュレーションに失敗しました');
        return;
      }
      setImpact(data.data!);
    } catch {
      setSimulateError('ネットワークエラー');
    } finally {
      setIsSimulating(false);
    }
  }, [newMonthlyPrice, newYearlyPrice, appliesTo, planId]);

  const handleExecute = async () => {
    if (!reason) {
      setError('変更理由を入力してください');
      return;
    }
    if (!plan) {
      setError('プラン情報の読み込みに失敗しました');
      return;
    }
    setIsExecuting(true);
    setError('');
    try {
      // #1041 round-3 (C2): 月額・年額入力欄は常に現在価格で prefill されているため、
      // 変更していない方までそのまま送ると「両方変更」扱いになり、Stripe 同期が
      // 必須なプランでは (stripe_price_id が1本しか無いため) 片方が黙って
      // 無視される偽成功の原因になっていた。変更されたフィールドのみ送る。
      const monthlyChanged =
        newMonthlyPrice !== '' && Number(newMonthlyPrice) !== plan.monthly_price_jpy;
      const yearlyChanged =
        newYearlyPrice !== '' && Number(newYearlyPrice) !== plan.yearly_price_jpy;

      const res = await fetch(`/api/super-admin/plans/${planId}/price-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_monthly_price_jpy: monthlyChanged ? Number(newMonthlyPrice) : null,
          new_yearly_price_jpy: yearlyChanged ? Number(newYearlyPrice) : null,
          applies_to: appliesTo,
          reason,
          effective_at: new Date(effectiveAt).toISOString(),
        }),
      });
      const data = await res.json() as { error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '価格変更に失敗しました');
        return;
      }
      router.push(`/super-admin/plans/${planId}?tab=history`);
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsExecuting(false);
    }
  };

  if (!plan) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/super-admin/plans/${planId}`} className="text-slate-400 hover:text-slate-600 transition-colors text-sm">
          ← {plan.display_name}
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">価格変更</h1>
      </div>

      {/* Step 1: 価格入力 + シミュレーション */}
      {step === 1 && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">現在の価格</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-500">月額:</span>{' '}
                <strong>{plan.monthly_price_jpy != null ? `¥${plan.monthly_price_jpy.toLocaleString()}` : '—'}</strong>
              </div>
              <div>
                <span className="text-slate-500">年額:</span>{' '}
                <strong>{plan.yearly_price_jpy != null ? `¥${plan.yearly_price_jpy.toLocaleString()}` : '—'}</strong>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <h2 className="text-base font-semibold text-slate-800">新しい価格</h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">新しい月額 (JPY)</label>
                <input
                  type="number"
                  value={newMonthlyPrice}
                  onChange={(e) => setNewMonthlyPrice(e.target.value)}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">新しい年額 (JPY)</label>
                <input
                  type="number"
                  value={newYearlyPrice}
                  onChange={(e) => setNewYearlyPrice(e.target.value)}
                  min="0"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">適用範囲</label>
              <select
                value={appliesTo}
                onChange={(e) => setAppliesTo(e.target.value as typeof appliesTo)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              >
                {Object.entries(APPLIES_TO_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              {appliesTo === 'immediately' && (
                <p className="text-xs text-red-600 mt-1">
                  即時適用は全アクティブ契約に影響します。慎重に選択してください。
                </p>
              )}
            </div>

            {simulateError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
                {simulateError}
              </div>
            )}

            <button
              onClick={handleSimulate}
              disabled={isSimulating}
              className="w-full py-2.5 border-2 border-orange-500 text-orange-600 rounded-lg text-sm font-medium hover:bg-orange-50 transition-colors disabled:opacity-50"
            >
              {isSimulating ? 'シミュレーション中...' : '影響をシミュレーション'}
            </button>

            {/* 影響シミュレーション結果 */}
            {impact && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-orange-800 mb-3">影響シミュレーション結果</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-orange-600">影響契約数:</span>{' '}
                    <strong className="text-orange-800">{impact.affected_subscription_count.toLocaleString()} 件</strong>
                  </div>
                  <div>
                    <span className="text-orange-600">MRR 変化:</span>{' '}
                    <strong className={`${impact.affected_mrr_change_jpy >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                      {impact.affected_mrr_change_jpy >= 0 ? '+' : ''}
                      ¥{impact.affected_mrr_change_jpy.toLocaleString()}
                    </strong>
                  </div>
                </div>
                <p className="text-xs text-orange-600 mt-2">
                  適用範囲: {APPLIES_TO_LABELS[impact.applies_to]}
                </p>
              </div>
            )}
          </div>

          {impact && (
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="px-6 py-2.5 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors"
              >
                確認ステップへ →
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 2: 確認・理由入力 → 実行 */}
      {step === 2 && impact && (
        <div className="space-y-6">
          <div className="bg-orange-50 border border-orange-300 rounded-xl p-6">
            <h2 className="text-base font-semibold text-orange-800 mb-4">価格変更の確認</h2>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-orange-600">プラン:</span>
                <strong>{plan.display_name} ({plan.plan_key})</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">旧月額 → 新月額:</span>
                <strong>
                  ¥{(plan.monthly_price_jpy ?? 0).toLocaleString()} → ¥{Number(newMonthlyPrice).toLocaleString()}
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">適用範囲:</span>
                <strong>{APPLIES_TO_LABELS[appliesTo]}</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">影響契約数:</span>
                <strong>{impact.affected_subscription_count.toLocaleString()} 件</strong>
              </div>
              <div className="flex justify-between">
                <span className="text-orange-600">MRR 変化:</span>
                <strong className={impact.affected_mrr_change_jpy >= 0 ? 'text-green-700' : 'text-red-700'}>
                  {impact.affected_mrr_change_jpy >= 0 ? '+' : ''}
                  ¥{impact.affected_mrr_change_jpy.toLocaleString()}
                </strong>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">変更理由 * (監査ログに記録されます)</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                required
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="例: 物価上昇に伴うインフレ調整"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">適用開始日時</label>
              <input
                type="datetime-local"
                value={effectiveAt}
                onChange={(e) => setEffectiveAt(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-3 justify-between">
              <button
                onClick={() => setStep(1)}
                className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors"
              >
                ← 戻る
              </button>
              <button
                onClick={handleExecute}
                disabled={isExecuting || !reason}
                className="px-6 py-2 bg-red-500 text-white rounded-lg text-sm font-medium hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {isExecuting ? '実行中...' : '価格変更を実行する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
