"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { FinanceDashboard } from "@/lib/admin/finance-schemas";

function KpiCard({
  label,
  value,
  sub,
  icon,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-xl border p-5 shadow-sm ${highlight ? "border-indigo-200" : "border-slate-100"}`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-slate-500 text-sm font-medium">{label}</span>
        <span className="text-xl">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-slate-800">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function formatJpy(n: number) {
  if (n >= 1_000_000) return `¥${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `¥${(n / 1_000).toFixed(1)}K`;
  return `¥${n.toLocaleString()}`;
}

export default function FinanceDashboardPage() {
  const [data, setData] = useState<FinanceDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/finance/dashboard")
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          setError(json.error.message);
        } else {
          setData(json.data as FinanceDashboard);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-96">
        <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          エラー: {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">売上ダッシュボード</h1>
          <p className="text-sm text-slate-500 mt-1">Finance &bull; リアルタイム KPI</p>
        </div>
        <a
          href="https://dashboard.stripe.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <span>Stripe Dashboard</span>
          <span>↗</span>
        </a>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          label="今月の MRR"
          value={formatJpy(data.current_mrr_jpy)}
          icon="💴"
          highlight
        />
        <KpiCard
          label="ARR"
          value={formatJpy(data.current_arr_jpy)}
          icon="📅"
        />
        <KpiCard
          label="Churn Rate"
          value={`${data.churn_rate}%`}
          sub="月次解約率"
          icon="📉"
        />
        <KpiCard
          label="LTV"
          value={formatJpy(data.ltv_jpy)}
          sub="ライフタイムバリュー"
          icon="💎"
        />
      </div>

      {/* MRR 内訳 */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-slate-700 mb-4">MRR 内訳</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-slate-400 mb-1">新規 MRR</div>
            <div className="text-lg font-bold text-green-600">{formatJpy(data.new_mrr_jpy)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">拡張 MRR</div>
            <div className="text-lg font-bold text-blue-600">{formatJpy(data.expansion_mrr_jpy)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">縮小 MRR</div>
            <div className="text-lg font-bold text-yellow-600">{formatJpy(data.contraction_mrr_jpy)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">解約 MRR</div>
            <div className="text-lg font-bold text-red-600">{formatJpy(data.churned_mrr_jpy)}</div>
          </div>
        </div>
      </div>

      {/* ユーザー数 */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-slate-700 mb-4">アクティブ契約数</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-slate-400 mb-1">個人課金者</div>
            <div className="text-xl font-bold text-slate-800">
              {data.personal_active_users.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">家族グループ</div>
            <div className="text-xl font-bold text-slate-800">
              {data.family_active_groups.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">法人</div>
            <div className="text-xl font-bold text-slate-800">
              {data.org_active_orgs.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">MAU</div>
            <div className="text-xl font-bold text-slate-800">
              {data.mau.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* クイックリンク */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          { href: "/admin/finance/revenue", label: "収益推移グラフ", icon: "📈" },
          { href: "/admin/finance/invoices", label: "請求書一覧", icon: "🧾" },
          { href: "/admin/finance/reconciliation", label: "Stripe 整合チェック", icon: "🔄" },
          { href: "/admin/finance/nps", label: "NPS / CSAT", icon: "⭐" },
          { href: "/admin/finance/exports", label: "CSV エクスポート", icon: "📥" },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="bg-white border border-slate-100 rounded-xl p-4 flex items-center gap-3 hover:border-indigo-200 hover:shadow-sm transition-all"
          >
            <span className="text-2xl">{item.icon}</span>
            <span className="text-sm font-medium text-slate-700">{item.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
