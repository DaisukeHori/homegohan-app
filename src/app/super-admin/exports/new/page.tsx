"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EXPORT_TYPES = [
  { value: "user_data", label: "ユーザーデータ", description: "全ユーザーの基本情報・プロファイル" },
  { value: "audit_logs", label: "監査ログ", description: "admin_audit_logs 全件 (7年保管対象)" },
  { value: "meal_records", label: "食事記録", description: "meal_logs テーブル" },
  { value: "org_data", label: "組織データ", description: "組織・ライセンス情報" },
  { value: "gdpr", label: "GDPR 削除対象データ", description: "GDPR 削除リクエストに関連するデータ" },
] as const;

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "parquet", label: "Parquet" },
] as const;

export default function NewExportPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    export_type: "user_data",
    format: "csv",
    mask_pii: true,
    registered_from: "",
    registered_to: "",
    plan_key: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const filters: Record<string, string> = {};
      if (form.registered_from) filters.registered_from = form.registered_from;
      if (form.registered_to) filters.registered_to = form.registered_to;
      if (form.plan_key) filters.plan_key = form.plan_key;

      const res = await fetch("/api/super-admin/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          export_type: form.export_type,
          format: form.format,
          mask_pii: form.mask_pii,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }

      router.push("/super-admin/exports");
    } catch (err) {
      alert(err instanceof Error ? err.message : "作成に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <Link href="/super-admin/exports" className="text-slate-400 hover:text-white transition-colors">
          ← データエクスポート
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-white mb-8">新規エクスポートリクエスト</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-3">エクスポート種別</label>
            <div className="space-y-2">
              {EXPORT_TYPES.map((t) => (
                <label
                  key={t.value}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    form.export_type === t.value
                      ? "border-purple-500 bg-purple-900/20"
                      : "border-slate-700 hover:border-slate-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="export_type"
                    value={t.value}
                    checked={form.export_type === t.value}
                    onChange={() => setForm({ ...form, export_type: t.value })}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-white text-sm font-medium">{t.label}</div>
                    <div className="text-slate-400 text-xs mt-0.5">{t.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">出力形式</label>
            <div className="flex gap-3">
              {FORMATS.map((f) => (
                <label
                  key={f.value}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border cursor-pointer transition-colors ${
                    form.format === f.value
                      ? "border-purple-500 bg-purple-900/20 text-white"
                      : "border-slate-700 text-slate-400 hover:border-slate-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    value={f.value}
                    checked={form.format === f.value}
                    onChange={() => setForm({ ...form, format: f.value })}
                    className="sr-only"
                  />
                  <span className="text-sm font-medium">{f.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, mask_pii: !form.mask_pii })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                form.mask_pii ? "bg-green-500" : "bg-slate-600"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.mask_pii ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <div>
              <div className="text-slate-300 text-sm">PII マスキング</div>
              <div className="text-slate-500 text-xs">個人情報をハッシュ化して出力</div>
            </div>
          </div>
        </div>

        {/* フィルタ */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-4">
          <h2 className="text-lg font-semibold text-white">フィルタ (任意)</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">登録日 FROM</label>
              <input
                type="date"
                value={form.registered_from}
                onChange={(e) => setForm({ ...form, registered_from: e.target.value })}
                className="w-full bg-slate-700 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-purple-500 outline-none text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">登録日 TO</label>
              <input
                type="date"
                value={form.registered_to}
                onChange={(e) => setForm({ ...form, registered_to: e.target.value })}
                className="w-full bg-slate-700 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-purple-500 outline-none text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">プランキー</label>
            <input
              type="text"
              value={form.plan_key}
              onChange={(e) => setForm({ ...form, plan_key: e.target.value })}
              placeholder="例: pro, org_standard"
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-purple-500 outline-none text-sm"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition-colors"
          >
            {isSubmitting ? "リクエスト中..." : "エクスポート開始"}
          </button>
          <Link
            href="/super-admin/exports"
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg font-semibold transition-colors text-center"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
