"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Variant {
  key: string;
  weight: number;
}

export default function NewExperimentPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    key: "",
    name: "",
    hypothesis: "",
    primary_metric: "",
    start_date: "",
    end_date: "",
  });
  const [variants, setVariants] = useState<Variant[]>([
    { key: "control", weight: 50 },
    { key: "variant_a", weight: 50 },
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!form.key) newErrors.key = "キーは必須です";
    else if (!/^[a-z0-9_]+$/.test(form.key)) newErrors.key = "小文字英数字とアンダースコアのみ";
    if (!form.name) newErrors.name = "名前は必須です";
    if (totalWeight !== 100) newErrors.variants = "バリアントの weight 合計は 100 である必要があります";
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
      const res = await fetch("/api/super-admin/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: form.key,
          name: form.name,
          hypothesis: form.hypothesis || undefined,
          primary_metric: form.primary_metric || undefined,
          start_date: form.start_date || undefined,
          end_date: form.end_date || undefined,
          variants,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }

      router.push("/super-admin/experiments");
    } catch (err) {
      alert(err instanceof Error ? err.message : "作成に失敗しました");
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateVariant = (index: number, field: keyof Variant, value: string | number) => {
    setVariants((prev) => prev.map((v, i) => i === index ? { ...v, [field]: value } : v));
  };

  const addVariant = () => {
    setVariants((prev) => [...prev, { key: `variant_${String.fromCharCode(97 + prev.length - 1)}`, weight: 0 }]);
  };

  const removeVariant = (index: number) => {
    if (variants.length <= 2) return;
    setVariants((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-8">
        <Link href="/super-admin/experiments" className="text-slate-400 hover:text-white transition-colors">
          ← A/B テスト一覧
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-white mb-8">新規実験作成</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-5">
          <h2 className="text-lg font-semibold text-white">基本情報</h2>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              実験キー <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="例: new_chat_ui_2026_05"
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none font-mono"
            />
            {errors.key && <p className="mt-1 text-sm text-red-400">{errors.key}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              実験名 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例: 新チャット UI テスト"
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none"
            />
            {errors.name && <p className="mt-1 text-sm text-red-400">{errors.name}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">仮説</label>
            <textarea
              value={form.hypothesis}
              onChange={(e) => setForm({ ...form, hypothesis: e.target.value })}
              placeholder="例: 新 UI でメッセージ送信率が +20% 向上する"
              rows={3}
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">主要メトリクス</label>
            <input
              type="text"
              value={form.primary_metric}
              onChange={(e) => setForm({ ...form, primary_metric: e.target.value })}
              placeholder="例: message_send_rate"
              className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">開始日</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">終了日</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                className="w-full bg-slate-700 text-white rounded-lg px-4 py-3 border border-slate-600 focus:border-purple-500 outline-none"
              />
            </div>
          </div>
        </div>

        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">バリアント設定</h2>
            <span className={`text-sm ${totalWeight === 100 ? "text-green-400" : "text-red-400"}`}>
              合計: {totalWeight}%
            </span>
          </div>
          {errors.variants && <p className="text-sm text-red-400">{errors.variants}</p>}

          {variants.map((variant, i) => (
            <div key={i} className="flex items-center gap-3">
              <input
                type="text"
                value={variant.key}
                onChange={(e) => updateVariant(i, "key", e.target.value)}
                placeholder="バリアントキー"
                className="flex-1 bg-slate-700 text-white rounded-lg px-4 py-2.5 border border-slate-600 focus:border-purple-500 outline-none font-mono text-sm"
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={variant.weight}
                  onChange={(e) => updateVariant(i, "weight", parseInt(e.target.value) || 0)}
                  min={0}
                  max={100}
                  className="w-20 bg-slate-700 text-white rounded-lg px-3 py-2.5 border border-slate-600 focus:border-purple-500 outline-none text-sm"
                />
                <span className="text-slate-400 text-sm">%</span>
              </div>
              {variants.length > 2 && (
                <button
                  type="button"
                  onClick={() => removeVariant(i)}
                  className="text-red-400 hover:text-red-300 text-sm"
                >
                  削除
                </button>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={addVariant}
            className="w-full py-2.5 border border-dashed border-slate-600 text-slate-400 hover:text-white hover:border-slate-500 rounded-lg transition-colors text-sm"
          >
            + バリアントを追加
          </button>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex-1 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition-colors"
          >
            {isSubmitting ? "作成中..." : "実験を作成"}
          </button>
          <Link
            href="/super-admin/experiments"
            className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg font-semibold transition-colors text-center"
          >
            キャンセル
          </Link>
        </div>
      </form>
    </div>
  );
}
