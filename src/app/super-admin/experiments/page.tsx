"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Experiment {
  id: string;
  key: string;
  name: string;
  status: "draft" | "running" | "completed" | "cancelled";
  start_date: string | null;
  end_date: string | null;
  variants: Array<{ key: string; weight: number }>;
  primary_metric: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  draft: { label: "下書き", color: "bg-slate-600 text-slate-200" },
  running: { label: "実行中", color: "bg-green-700 text-green-100" },
  completed: { label: "完了", color: "bg-blue-700 text-blue-100" },
  cancelled: { label: "中止", color: "bg-red-800 text-red-200" },
};

export default function ExperimentsPage() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchExperiments = async () => {
      try {
        const res = await fetch("/api/super-admin/experiments");
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const { data } = await res.json();
        setExperiments(data ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setIsLoading(false);
      }
    };
    fetchExperiments();
  }, []);

  const handleStatusChange = async (id: string, status: string) => {
    try {
      const res = await fetch(`/api/super-admin/experiments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setExperiments((prev) => prev.map((e) => e.id === id ? { ...e, status: status as Experiment["status"] } : e));
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新に失敗しました");
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">A/B テスト管理</h1>
          <p className="text-slate-400 mt-1">実験の作成・管理・結果分析</p>
        </div>
        <Link
          href="/super-admin/experiments/new"
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors"
        >
          + 新規実験
        </Link>
      </div>

      {experiments.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">🧪</div>
          <p>実験がありません</p>
          <Link href="/super-admin/experiments/new" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
            最初の実験を作成する
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">実験名</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">期間</th>
                <th className="text-left px-6 py-4 font-medium">バリアント</th>
                <th className="text-left px-6 py-4 font-medium">主要メトリクス</th>
                <th className="text-left px-6 py-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {experiments.map((exp) => {
                const badge = STATUS_BADGE[exp.status] ?? STATUS_BADGE.draft;
                return (
                  <tr key={exp.id} className="hover:bg-slate-700/50 transition-colors">
                    <td className="px-6 py-4">
                      <div>
                        <div className="text-white font-medium">{exp.name}</div>
                        <code className="text-slate-400 text-xs font-mono">{exp.key}</code>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badge.color}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.start_date ?? "未設定"} 〜 {exp.end_date ?? "未設定"}
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.variants.map((v) => `${v.key}(${v.weight}%)`).join(" / ")}
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.primary_metric ?? "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/super-admin/experiments/${exp.id}`}
                          className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
                        >
                          詳細
                        </Link>
                        {exp.status === "draft" && (
                          <button
                            onClick={() => handleStatusChange(exp.id, "running")}
                            className="text-green-400 hover:text-green-300 text-sm transition-colors"
                          >
                            開始
                          </button>
                        )}
                        {exp.status === "running" && (
                          <button
                            onClick={() => handleStatusChange(exp.id, "completed")}
                            className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
                          >
                            完了
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
