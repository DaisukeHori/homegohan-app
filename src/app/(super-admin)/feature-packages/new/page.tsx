"use client";

/**
 * /super-admin/feature-packages/new — 機能パッケージ新規作成
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function FeaturePackageNewPage() {
  const router = useRouter();
  const [packageKey, setPackageKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [featureFlagsRaw, setFeatureFlagsRaw] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const flags = featureFlagsRaw
      .split(/[\n,]/)
      .map((f) => f.trim())
      .filter(Boolean);

    if (flags.length === 0) {
      setError('機能フラグを少なくとも1つ入力してください');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/api/super-admin/feature-packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package_key: packageKey,
          display_name: displayName,
          description: description || undefined,
          feature_flags: flags,
          display_order: Number(displayOrder),
        }),
      });

      const data = await res.json() as { data?: { id: string }; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '作成に失敗しました');
        return;
      }
      router.push(`/super-admin/feature-packages/${data.data!.id}`);
    } catch {
      setError('ネットワークエラーが発生しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/super-admin/feature-packages" className="text-slate-400 hover:text-slate-600 transition-colors text-sm">
          ← 一覧に戻る
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-bold text-slate-900">機能パッケージ新規作成</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            package_key *
            <span className="text-xs text-slate-400 ml-2">英小文字・数字・アンダースコアのみ</span>
          </label>
          <input
            type="text"
            value={packageKey}
            onChange={(e) => setPackageKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
            required
            pattern="^[a-z0-9_]+$"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="例: ai_analysis"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="例: AI 解析"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="パッケージの説明"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            機能フラグ *
            <span className="text-xs text-slate-400 ml-2">改行またはカンマ区切りで複数入力</span>
          </label>
          <textarea
            value={featureFlagsRaw}
            onChange={(e) => setFeatureFlagsRaw(e.target.value)}
            required
            rows={4}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="food_recognition&#10;ai_consultation&#10;ai_menu_generate"
          />
          {featureFlagsRaw && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {featureFlagsRaw.split(/[\n,]/).map((f) => f.trim()).filter(Boolean).map((flag) => (
                <span key={flag} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded font-mono">
                  {flag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示順</label>
          <input
            type="number"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(e.target.value)}
            min="0"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Link
            href="/super-admin/feature-packages"
            className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-sm hover:bg-slate-50 transition-colors"
          >
            キャンセル
          </Link>
          <button
            type="submit"
            disabled={isLoading}
            className="px-6 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isLoading ? '作成中...' : '作成する'}
          </button>
        </div>
      </form>
    </div>
  );
}
