"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  rollout_strategy: { type: string; value?: number } | null;
  constraints: Record<string, unknown> | null;
  active_user_count: number;
  updated_at: string;
}

export default function FlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchFlags = async () => {
    try {
      const res = await fetch("/api/super-admin/flags");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const { data } = await res.json();
      setFlags(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchFlags();
  }, []);

  const handleToggle = async (key: string, currentEnabled: boolean) => {
    setToggling(key);
    try {
      const res = await fetch(`/api/super-admin/flags/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setFlags((prev) => prev.map((f) => f.key === key ? { ...f, enabled: !currentEnabled } : f));
    } catch (err) {
      alert(err instanceof Error ? err.message : "更新に失敗しました");
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`フラグ "${key}" を削除しますか？`)) return;
    try {
      const res = await fetch(`/api/super-admin/flags/${key}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      setFlags((prev) => prev.filter((f) => f.key !== key));
    } catch (err) {
      alert(err instanceof Error ? err.message : "削除に失敗しました");
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
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">機能フラグ管理</h1>
          <p className="text-slate-400 mt-1">機能の ON/OFF と段階公開を管理します</p>
        </div>
        <Link
          href="/super-admin/flags/new"
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors"
        >
          + 新規フラグ
        </Link>
      </div>

      {flags.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400">
          <div className="text-5xl mb-4">🚩</div>
          <p>機能フラグがありません</p>
          <Link href="/super-admin/flags/new" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
            最初のフラグを作成する
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">フラグキー</th>
                <th className="text-left px-6 py-4 font-medium">説明</th>
                <th className="text-left px-6 py-4 font-medium">ロールアウト</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">更新日</th>
                <th className="text-left px-6 py-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {flags.map((flag) => (
                <tr key={flag.key} className="hover:bg-slate-700/50 transition-colors">
                  <td className="px-6 py-4">
                    <code className="text-purple-300 text-sm font-mono">{flag.key}</code>
                  </td>
                  <td className="px-6 py-4 text-slate-300 text-sm">{flag.description || "—"}</td>
                  <td className="px-6 py-4 text-slate-300 text-sm">
                    {flag.rollout_strategy ? (
                      <span className="bg-blue-900/50 text-blue-300 text-xs px-2 py-1 rounded">
                        {flag.rollout_strategy.type}
                        {flag.rollout_strategy.value !== undefined && ` ${flag.rollout_strategy.value}%`}
                      </span>
                    ) : (
                      <span className="text-slate-500 text-xs">全体</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggle(flag.key, flag.enabled)}
                      disabled={toggling === flag.key}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                        flag.enabled ? "bg-green-500" : "bg-slate-600"
                      } ${toggling === flag.key ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          flag.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span className={`ml-2 text-xs ${flag.enabled ? "text-green-400" : "text-slate-500"}`}>
                      {flag.enabled ? "ON" : "OFF"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-400 text-sm">
                    {new Date(flag.updated_at).toLocaleDateString("ja-JP")}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleDelete(flag.key)}
                      className="text-red-400 hover:text-red-300 text-sm transition-colors"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
