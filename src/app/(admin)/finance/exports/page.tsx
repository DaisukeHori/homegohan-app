"use client";

import { useState } from "react";

type ExportType = "revenue" | "invoices" | "subscriptions" | "nps";

interface ExportConfig {
  type: ExportType;
  label: string;
  description: string;
  icon: string;
}

const EXPORT_CONFIGS: ExportConfig[] = [
  {
    type: "revenue",
    label: "収益スナップショット",
    description: "revenue_snapshots テーブルの MRR/ARR/ユーザー数データ",
    icon: "📈",
  },
  {
    type: "invoices",
    label: "請求書ログ",
    description: "stripe_webhook_events の invoice イベント一覧",
    icon: "🧾",
  },
  {
    type: "subscriptions",
    label: "サブスクリプション",
    description: "personal_subscriptions の契約一覧 (PII: user_id のみ)",
    icon: "💳",
  },
  {
    type: "nps",
    label: "NPS 回答",
    description: "nps_surveys テーブルのスコア/コメント (PII: user_id のみ)",
    icon: "⭐",
  },
];

export default function ExportsPage() {
  const [selectedType, setSelectedType] = useState<ExportType>("revenue");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const body = {
        export_type: selectedType,
        from: from || undefined,
        to: to || undefined,
        format: "csv",
      };

      const res = await fetch("/api/admin/finance/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json() as { error?: { message?: string } };
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      }

      // CSV をダウンロード
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? `${selectedType}_export.csv`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(true);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const selectedConfig = EXPORT_CONFIGS.find((c) => c.type === selectedType);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">CSV エクスポート</h1>
        <p className="text-sm text-slate-500 mt-1">finance データの CSV ダウンロード</p>
      </div>

      <div className="max-w-2xl">
        {/* エクスポート種別選択 */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-4">エクスポート種別</h2>
          <div className="grid grid-cols-2 gap-3">
            {EXPORT_CONFIGS.map((config) => (
              <button
                key={config.type}
                onClick={() => setSelectedType(config.type)}
                className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-all ${
                  selectedType === config.type
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <span className="text-2xl">{config.icon}</span>
                <div>
                  <div className={`text-sm font-medium ${selectedType === config.type ? "text-indigo-700" : "text-slate-700"}`}>
                    {config.label}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{config.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 期間設定 */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 mb-6">
          <h2 className="text-base font-semibold text-slate-700 mb-4">期間フィルタ (任意)</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-500 mb-1">開始日</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">終了日</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-3">
            未設定の場合は全期間のデータを出力します。
          </p>
        </div>

        {/* エクスポートボタン */}
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">{selectedConfig?.icon}</span>
            <div>
              <div className="font-semibold text-slate-800">{selectedConfig?.label}</div>
              <div className="text-xs text-slate-400">{selectedConfig?.description}</div>
            </div>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
              CSV ダウンロードを開始しました
            </div>
          )}

          <button
            onClick={handleExport}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                生成中...
              </>
            ) : (
              <>
                <span>📥</span>
                CSV ダウンロード
              </>
            )}
          </button>

          <p className="text-xs text-slate-400 mt-3 text-center">
            エクスポートは監査ログに記録されます
          </p>
        </div>
      </div>
    </div>
  );
}
