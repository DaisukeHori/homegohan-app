"use client";

import { useEffect, useState } from "react";
import FinanceQuickLinks from "@/components/operator/finance/FinanceQuickLinks";
import type { FinanceDashboard } from "@/lib/admin/finance-schemas";

/**
 * 売上・経理のダッシュボード。
 * 収益の集計 (MRR・ARR・解約率・LTV) と契約数は、元になるデータ (Stripe の Webhook・収益の日次スナップショット) を
 * 作る処理が無く、API は 0 を返すだけ (#1125)。0 円・0 人に見えるのを避けるため、これらのカードは出さない
 * (#1911: 未完成の機能は画面に出さない。「準備中」とも出さない)。MAU は daily_active_users から集計する実データなので出す。
 */
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
          <p className="text-sm text-slate-500 mt-1">Finance</p>
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

      {/* ユーザー数 */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-slate-700 mb-4">ユーザー数</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
