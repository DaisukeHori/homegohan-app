"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NewFlagPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    key: "",
    description: "",
    enabled: false,
    rollout_type: "all",
    rollout_percentage: 100,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!form.key) newErrors.key = "フラグキーは必須です";
    else if (!/^[a-z0-9_]+$/.test(form.key)) newErrors.key = "小文字英数字とアンダースコアのみ使用可能です";
    return newErrors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        key: form.key,
        description: form.description || undefined,
        enabled: form.enabled,
        rollout_strategy: form.rollout_type !== "all"
          ? { type: form.rollout_type, value: form.rollout_percentage }
          : undefined,
      };

      const res = await fetch("/api/super-admin/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }

      router.push("/super-admin/flags");
    } catch (err) {
      alert(err instanceof Error ? err.message : "作成に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/super-admin/flags" className="text-slate-400 hover:text-white transition-colors">
          ← 機能フラグ一覧
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-white mb-8">新規機能フラグ作成</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              フラグキー <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="例: new_meal_ai_v2"
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none font-mono"
            />
            {errors.key && <p className="mt-1 text-sm text-red-400">{errors.key}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">説明</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="このフラグの目的を説明してください"
              rows={3}
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 focus:ring-1 focus:ring-purple-500 outline-none resize-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setForm({ ...form, enabled: !form.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                form.enabled ? "bg-green-500" : "bg-slate-600"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className="text-slate-300 text-sm">
              {form.enabled ? "作成後すぐに有効化" : "無効状態で作成"}
            </span>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">ロールアウト戦略</label>
            <select
              value={form.rollout_type}
              onChange={(e) => setForm({ ...form, rollout_type: e.target.value })}
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none"
            >
              <option value="all">全ユーザー</option>
              <option value="percentage">段階公開 (%)</option>
              <option value="plan">プラン別</option>
              <option value="role">ロール別</option>
            </select>
          </div>

          {form.rollout_type === "percentage" && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                公開率: {form.rollout_percentage}%
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={form.rollout_percentage}
                onChange={(e) => setForm({ ...form, rollout_percentage: parseInt(e.target.value) })}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition-colors"
          >
            {isSubmitting ? "作成中..." : "フラグを作成"}
          </button>
          <Link
            href="/super-admin/flags"
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg font-semibold transition-colors text-center"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
