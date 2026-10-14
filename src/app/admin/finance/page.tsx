"use client";

import { useEffect, useState } from "react";
import FinanceQuickLinks from "@/components/operator/finance/FinanceQuickLinks";
import type { FinanceDashboard } from "@/lib/admin/finance-schemas";
import { BILLING_NOT_STARTED_MESSAGE } from "@/components/operator/finance/BillingNotStartedNotice";

/**
 * 課金は未開始 (#1125)。収益の集計 (MRR・ARR・解約率・LTV) と契約数は、元になるデータ (Stripe の Webhook・
 * 収益の日次スナップショット) を作る処理がまだ無く、API は 0 を返すだけ。0 円・0 人に見えるのを避け、
 * 「準備中」と出す (pending)。MAU は daily_active_users から集計する実データなので、そのまま出す。
 */
function KpiCard({
  label,
  value,
  sub,
  icon,
  highlight,
  pending,
}: {
  label: string;
  value?: string;
  sub?: string;
  icon: string;
  highlight?: boolean;
  /** 課金は未開始のため準備中。値を出さず「準備中」と出す */
  pending?: boolean;
}) {
  return (
    <div
      className={`bg-white rounded-xl border p-5 shadow-sm ${highlight ? "border-indigo-200" : "border-slate-100"}`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-slate-500 text-sm font-medium">{label}</span>
        <span className="text-xl">{icon}</span>
      </div>
      {pending ? (
        <>
          <div className="text-2xl font-bold text-slate-500">準備中</div>
          <div className="text-xs text-slate-500 mt-1">{BILLING_NOT_STARTED_MESSAGE}</div>
        </>
      ) : (
        <>
          <div className="text-2xl font-bold text-slate-800">{value}</div>
          {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
        </>
      )}
    </div>
  );
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
        <KpiCard label="今月の MRR" icon="💴" highlight pending />
        <KpiCard label="ARR" icon="📅" pending />
        <KpiCard label="Churn Rate" icon="📉" pending />
        <KpiCard label="LTV" icon="💎" pending />
      </div>

      {/* MRR 内訳 (課金は未開始のため準備中) */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-slate-700 mb-2">MRR 内訳</h2>
        <p className="text-sm text-slate-500">{BILLING_NOT_STARTED_MESSAGE}</p>
      </div>

      {/* ユーザー数 */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-slate-700 mb-4">アクティブ契約数</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-slate-400 mb-1">個人課金者</div>
            <div className="text-xl font-bold text-slate-500">準備中</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">家族グループ</div>
            <div className="text-xl font-bold text-slate-500">準備中</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">法人</div>
            <div className="text-xl font-bold text-slate-500">準備中</div>
          </div>
          <div>
            <div className="text-xs text-slate-400 mb-1">MAU</div>
            <div className="text-xl font-bold text-slate-800">
              {data.mau.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* クイックリンク (NPS / CSAT は admin / super_admin にだけ出す。#1311) */}
      <FinanceQuickLinks />
    </div>
  );
}
