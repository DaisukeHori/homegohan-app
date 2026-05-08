"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface ExperimentResults {
  experiment_id: string;
  experiment_key: string;
  experiment_name: string;
  status: string;
  total_assignments: number;
  by_variant: Array<{
    variant_key: string;
    assignment_count: number;
    percentage: number;
    conversion_rate: number | null;
    p_value: number | null;
  }>;
  is_significant: boolean | null;
  winner: string | null;
  stored_result: Record<string, unknown> | null;
}

interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  variants: Array<{ key: string; weight: number }>;
  primary_metric: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-600 text-slate-200",
  running: "bg-green-700 text-green-100",
  completed: "bg-blue-700 text-blue-100",
  cancelled: "bg-red-800 text-red-200",
};

export default function ExperimentDetailPage({ params }: { params: { id: string } }) {
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [results, setResults] = useState<ExperimentResults | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [expRes, resRes] = await Promise.all([
          fetch(`/api/super-admin/experiments/${params.id}`),
          fetch(`/api/super-admin/experiments/${params.id}/results`),
        ]);

        if (!expRes.ok) {
          const body = await expRes.json();
          throw new Error(body.error?.message ?? `HTTP ${expRes.status}`);
        }

        const expData = await expRes.json();
        setExperiment(expData.data);

        if (resRes.ok) {
          const resData = await resRes.json();
          setResults(resData.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "読み込みに失敗しました");
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [params.id]);

  const handleStatusChange = async (status: string) => {
    if (!confirm(`ステータスを "${status}" に変更しますか？`)) return;
    try {
      const res = await fetch(`/api/super-admin/experiments/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const { data } = await res.json();
      setExperiment(data);
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

  if (error || !experiment) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">
          {error ?? "実験が見つかりません"}
        </div>
      </div>
    );
  }

  const badgeClass = STATUS_BADGE[experiment.status] ?? STATUS_BADGE.draft;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <Link href="/super-admin/experiments" className="text-slate-400 hover:text-white transition-colors">
          ← A/B テスト一覧
        </Link>
      </div>

      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-white">{experiment.name}</h1>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badgeClass}`}>
              {experiment.status}
            </span>
          </div>
          <code className="text-slate-400 font-mono text-sm">{experiment.key}</code>
        </div>

        <div className="flex gap-2">
          {experiment.status === "draft" && (
            <button
              onClick={() => handleStatusChange("running")}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              実験開始
            </button>
          )}
          {experiment.status === "running" && (
            <>
              <button
                onClick={() => handleStatusChange("completed")}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
              >
                完了
              </button>
              <button
                onClick={() => handleStatusChange("cancelled")}
                className="bg-red-700 hover:bg-red-800 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
              >
                中止
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {/* 基本情報 */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4">基本情報</h2>
          <dl className="grid grid-cols-2 gap-4">
            {experiment.hypothesis && (
              <div className="col-span-2">
                <dt className="text-slate-400 text-sm">仮説</dt>
                <dd className="text-white mt-1">{experiment.hypothesis}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-400 text-sm">主要メトリクス</dt>
              <dd className="text-white mt-1">{experiment.primary_metric ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 text-sm">期間</dt>
              <dd className="text-white mt-1">
                {experiment.start_date ?? "未設定"} 〜 {experiment.end_date ?? "未設定"}
              </dd>
            </div>
          </dl>
        </div>

        {/* バリアント設定 */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4">バリアント設定</h2>
          <div className="space-y-3">
            {experiment.variants.map((v) => (
              <div key={v.key} className="flex items-center gap-4">
                <code className="font-mono text-sm text-purple-300 w-40">{v.key}</code>
                <div className="flex-1 bg-slate-700 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-purple-500 h-full rounded-full"
                    style={{ width: `${v.weight}%` }}
                  />
                </div>
                <span className="text-slate-300 text-sm w-12 text-right">{v.weight}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* 結果ダッシュボード */}
        {results && (
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold text-white mb-4">結果ダッシュボード</h2>
            <div className="mb-4">
              <span className="text-slate-400 text-sm">総割当数: </span>
              <span className="text-white font-semibold">{results.total_assignments.toLocaleString()} ユーザー</span>
            </div>
            <div className="space-y-3">
              {results.by_variant.map((v) => (
                <div key={v.variant_key} className="bg-slate-700/50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <code className="font-mono text-sm text-purple-300">{v.variant_key}</code>
                    <span className="text-slate-300 text-sm">{v.assignment_count.toLocaleString()} ユーザー ({v.percentage}%)</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full"
                      style={{ width: `${v.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {results.is_significant === null && (
              <p className="mt-4 text-slate-500 text-sm">
                統計的有意差の計算は外部分析ツール連携が必要です
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
