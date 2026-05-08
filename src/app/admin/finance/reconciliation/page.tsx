"use client";

import { useEffect, useState } from "react";

interface ReconciliationData {
  discrepancies: Array<{
    id: string;
    type: string;
    stripe_subscription_id: string | null;
    stripe_status: string | null;
    db_status: string | null;
    user_id: string | null;
    detail: string;
    detected_at: string;
  }>;
  db_summary: {
    total_active_in_db: number;
    by_status: Record<string, number>;
  };
  stripe_summary: {
    stripe_available: boolean;
    total_active_in_stripe?: number;
    message?: string;
  };
}

interface ApiMeta {
  total: number;
  page: number;
  per_page: number;
  note?: string;
}

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    missing_in_db: "bg-red-100 text-red-700",
    status_mismatch: "bg-yellow-100 text-yellow-700",
    amount_mismatch: "bg-orange-100 text-orange-700",
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${colors[type] ?? "bg-slate-100 text-slate-600"}`}>
      {type}
    </span>
  );
}

export default function ReconciliationPage() {
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fetchData = (currentPage = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(currentPage), per_page: "50" });
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    fetch(`/api/admin/finance/reconciliation?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error.message);
        else {
          setData(json.data as ReconciliationData);
          setMeta(json.meta as ApiMeta);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchData(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Stripe 整合チェック</h1>
        <p className="text-sm text-slate-500 mt-1">DB ↔ Stripe の subscription status 差分 (日次 cron 結果)</p>
      </div>

      {meta?.note && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-700 text-sm">
          {meta.note}
        </div>
      )}

      {/* サマリー */}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
            <div className="text-xs text-slate-400 mb-1">DB アクティブ数</div>
            <div className="text-2xl font-bold text-slate-800">
              {data.db_summary.total_active_in_db.toLocaleString()}
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(data.db_summary.by_status).map(([status, count]) => (
                <div key={status} className="flex justify-between text-xs text-slate-500">
                  <span>{status}</span>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5">
            <div className="text-xs text-slate-400 mb-1">Stripe (active)</div>
            {data.stripe_summary.stripe_available ? (
              <div className="text-2xl font-bold text-slate-800">
                {data.stripe_summary.total_active_in_stripe?.toLocaleString() ?? "-"}
              </div>
            ) : (
              <div className="text-sm text-slate-400 mt-2">
                {data.stripe_summary.message ?? "Stripe Secret 未設定"}
              </div>
            )}
          </div>

          <div className={`rounded-xl border shadow-sm p-5 ${(meta?.total ?? 0) > 0 ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
            <div className={`text-xs mb-1 ${(meta?.total ?? 0) > 0 ? "text-red-400" : "text-green-400"}`}>
              不一致件数
            </div>
            <div className={`text-2xl font-bold ${(meta?.total ?? 0) > 0 ? "text-red-700" : "text-green-700"}`}>
              {meta?.total ?? 0}
            </div>
            {(meta?.total ?? 0) === 0 && (
              <div className="text-xs text-green-600 mt-2">整合OK</div>
            )}
          </div>
        </div>
      )}

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">検出日 FROM</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">検出日 TO</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <button
          onClick={() => { setPage(1); fetchData(1); }}
          className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          検索
        </button>
      </div>

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
                    {["種別", "Stripe Sub ID", "Stripe Status", "DB Status", "ユーザー ID", "詳細", "検出日時"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {(data?.discrepancies ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                        不一致は検出されていません
                      </td>
                    </tr>
                  ) : (
                    (data?.discrepancies ?? []).map((d) => (
                      <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3"><TypeBadge type={d.type} /></td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500 max-w-40 truncate">
                          {d.stripe_subscription_id ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{d.stripe_status ?? "-"}</td>
                        <td className="px-4 py-3 text-slate-600">{d.db_status ?? "-"}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400 max-w-32 truncate">
                          {d.user_id ?? "-"}
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs max-w-48 truncate">{d.detail}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                          {new Date(d.detected_at).toLocaleString("ja-JP")}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {meta && meta.total > meta.per_page && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-slate-500">全 {meta.total} 件</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">前へ</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page * meta.per_page >= meta.total} className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">次へ</button>
              </div>
            </div>
          )}

          <div className="mt-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="text-sm font-medium text-amber-800 mb-1">自動修復は無効</div>
            <div className="text-xs text-amber-700">
              不整合を検出した場合、自動修復は行いません。原因を確認の上、super_admin が手動で修正してください。
              (operator/09-runbook.md §2.1 参照)
            </div>
          </div>
        </>
      )}
    </div>
  );
}
