"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { InvoiceItem } from "@/lib/admin/finance-schemas";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: "bg-green-100 text-green-700",
    processing: "bg-yellow-100 text-yellow-700",
    failed: "bg-red-100 text-red-700",
    pending: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${colors[status] ?? "bg-slate-100 text-slate-600"}`}>
      {status}
    </span>
  );
}

function formatAmount(amount: number | null, currency: string | null) {
  if (amount == null) return "-";
  const divisor = currency?.toLowerCase() === "jpy" ? 1 : 100;
  const value = amount / divisor;
  if (currency?.toLowerCase() === "jpy") {
    return `¥${value.toLocaleString()}`;
  }
  return `${currency?.toUpperCase()} ${value.toFixed(2)}`;
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [meta, setMeta] = useState<{ total: number; page: number; per_page: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const fetchData = (currentPage = 1) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(currentPage), per_page: "50" });
    if (statusFilter) params.set("status", statusFilter);
    if (from) params.set("from", from);
    if (to) params.set("to", to);

    fetch(`/api/admin/finance/invoices?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.error) setError(json.error.message);
        else {
          setInvoices(json.data as InvoiceItem[]);
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">請求書一覧</h1>
        <p className="text-sm text-slate-500 mt-1">stripe_webhook_events — invoice イベント</p>
      </div>

      {/* フィルタ */}
      <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-slate-500 mb-1">ステータス</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">すべて</option>
            <option value="completed">completed</option>
            <option value="processing">processing</option>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">受信日 FROM</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">受信日 TO</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
        </div>
        <button
          onClick={handleSearch}
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
                    {["イベント ID", "種別", "請求書番号", "金額", "ステータス", "受信日時", "詳細"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {invoices.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-400">データがありません</td>
                    </tr>
                  ) : (
                    invoices.map((inv) => (
                      <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-slate-500 max-w-32 truncate">{inv.stripe_event_id}</td>
                        <td className="px-4 py-3 text-slate-600">{inv.event_type}</td>
                        <td className="px-4 py-3 font-mono text-xs">{inv.invoice_number ?? "-"}</td>
                        <td className="px-4 py-3 font-semibold text-slate-800">
                          {formatAmount(inv.amount_paid, inv.currency)}
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                        <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">
                          {new Date(inv.received_at).toLocaleString("ja-JP")}
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/admin/finance/invoices/${inv.id}`}
                            className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                          >
                            詳細
                          </Link>
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
              <span className="text-sm text-slate-500">全 {meta.total} 件 / ページ {meta.page}</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">前へ</button>
                <button onClick={() => setPage((p) => p + 1)} disabled={page * meta.per_page >= meta.total} className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">次へ</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
