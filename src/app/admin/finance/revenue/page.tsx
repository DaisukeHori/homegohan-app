"use client";

import { useEffect, useState } from "react";
import type { RevenueSnapshot } from "@/lib/admin/finance-schemas";

function formatJpy(n: number) {
  if (n >= 1_000_000) return `¥${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `¥${(n / 1_000).toFixed(1)}K`;
  return `¥${n.toLocaleString()}`;
}

export default function RevenueListPage() {
  const [snapshots, setSnapshots] = useState<RevenueSnapshot[]>([]);
  const [meta, setMeta] = useState<{
    total: number;
    page: number;
    per_page: number;
    summary?: { avg_mrr_jpy: number; latest_mrr_jpy: number; latest_arr_jpy: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const fetchData = (currentPage = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(currentPage), per_page: "24" });
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    fetch(`/api/admin/finance/revenue?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) {
          setError(json.error.message);
        } else {
          setSnapshots(json.data as RevenueSnapshot[]);
          setMeta(json.meta as typeof meta);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    setPage(1);
    fetchData(1);
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">収益推移</h1>
          <p className="text-sm text-slate-500 mt-1">revenue_snapshots — 日次スナップショット</p>
        </div>
      </div>

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">開始日</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">終了日</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
          />
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          検索
        </button>
      </div>

      {/* サマリー */}
      {meta?.summary && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <div className="text-xs text-slate-400 mb-1">最新 MRR</div>
            <div className="text-xl font-bold text-slate-800">
              {formatJpy(meta.summary.latest_mrr_jpy)}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <div className="text-xs text-slate-400 mb-1">最新 ARR</div>
            <div className="text-xl font-bold text-slate-800">
              {formatJpy(meta.summary.latest_arr_jpy)}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
            <div className="text-xs text-slate-400 mb-1">期間平均 MRR</div>
            <div className="text-xl font-bold text-slate-800">
              {formatJpy(meta.summary.avg_mrr_jpy)}
            </div>
          </div>
        </div>
      )}

      {/* テーブル */}
      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    {["日付", "Total MRR", "ARR", "個人 MAU", "個人 MRR", "組織数", "組織 MRR", "新規", "解約"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {snapshots.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                        データがありません
                      </td>
                    </tr>
                  ) : (
                    snapshots.map((s) => (
                      <tr key={s.date} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-mono text-slate-700">{s.date}</td>
                        <td className="px-4 py-3 font-semibold text-slate-800">{formatJpy(s.total_mrr_jpy)}</td>
                        <td className="px-4 py-3 text-slate-600">{formatJpy(s.total_arr_jpy)}</td>
                        <td className="px-4 py-3 text-slate-600">{s.personal_active_users.toLocaleString()}</td>
                        <td className="px-4 py-3 text-slate-600">{formatJpy(s.personal_mrr_jpy)}</td>
                        <td className="px-4 py-3 text-slate-600">{s.org_active_orgs.toLocaleString()}</td>
                        <td className="px-4 py-3 text-slate-600">{formatJpy(s.org_mrr_jpy)}</td>
                        <td className="px-4 py-3 text-green-600">{s.new_signups}</td>
                        <td className="px-4 py-3 text-red-500">{s.cancellations}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* ページネーション */}
          {meta && meta.total > meta.per_page && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-slate-500">
                全 {meta.total} 件 / ページ {meta.page}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50"
                >
                  前へ
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page * meta.per_page >= meta.total}
                  className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50"
                >
                  次へ
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
