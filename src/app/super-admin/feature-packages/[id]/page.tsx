"use client";

/**
 * /super-admin/feature-packages/[id] — 機能パッケージ詳細・編集
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type FeaturePackage = {
  id: string;
  package_key: string;
  display_name: string;
  description: string | null;
  feature_flags: string[];
  display_order: number;
  status: string;
  created_at: string;
  updated_at: string;
};

export default function FeaturePackageDetailPage() {
  const params = useParams();
  const pkgId = params.id as string;

  const [pkg, setPkg] = useState<FeaturePackage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // 編集フィールド
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [featureFlagsRaw, setFeatureFlagsRaw] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);

  const fetchPkg = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`);
      const data = await res.json() as { data?: FeaturePackage; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '取得に失敗しました');
        return;
      }
      setPkg(data.data!);
      setDisplayName(data.data!.display_name);
      setDescription(data.data!.description ?? '');
      setFeatureFlagsRaw(data.data!.feature_flags.join('\n'));
      setDisplayOrder(data.data!.display_order);
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsLoading(false);
    }
  }, [pkgId]);

  useEffect(() => {
    fetchPkg();
  }, [fetchPkg]);

  const handleSave = async () => {
    const flags = featureFlagsRaw.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
    if (flags.length === 0) {
      setSaveError('機能フラグを少なくとも1つ入力してください');
      return;
    }
    setIsSaving(true);
    setSaveError('');
    setSaveSuccess(false);

    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName,
          description: description || null,
          feature_flags: flags,
          display_order: displayOrder,
        }),
      });
      const data = await res.json() as { data?: FeaturePackage; error?: { message: string } };
      if (!res.ok) {
        setSaveError(data.error?.message ?? '保存に失敗しました');
        return;
      }
      setPkg(data.data!);
      setSaveSuccess(true);
    } catch {
      setSaveError('ネットワークエラー');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeprecate = async () => {
    if (!confirm('この機能パッケージを廃止しますか？')) return;
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated' }),
      });
      if (res.ok) fetchPkg();
    } catch {
      alert('廃止処理に失敗しました');
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-400">読み込み中...</div>;
  }

  if (error || !pkg) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
        {error || '機能パッケージが見つかりません'}
      </div>
    );
  }

  const flags = featureFlagsRaw.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);

  return (
    <div className="max-w-2xl mx-auto">
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/super-admin/feature-packages" className="text-slate-400 hover:text-slate-600 text-sm">
            ← 一覧
          </Link>
          <span className="text-slate-300">/</span>
          <h1 className="text-xl font-bold text-slate-900">{pkg.display_name}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            pkg.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}>
            {pkg.status === 'active' ? '有効' : '廃止'}
          </span>
        </div>
        {pkg.status === 'active' && (
          <button
            onClick={handleDeprecate}
            className="px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50 transition-colors"
          >
            廃止する
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">package_key</label>
          <code className="font-mono text-sm bg-slate-100 px-2 py-1 rounded">{pkg.package_key}</code>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示名 *</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">機能フラグ</label>
          <textarea
            value={featureFlagsRaw}
            onChange={(e) => setFeatureFlagsRaw(e.target.value)}
            rows={5}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {flags.map((flag) => (
              <span key={flag} className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded font-mono">
                {flag}
              </span>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">表示順</label>
          <input
            type="number"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(Number(e.target.value))}
            min="0"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {saveError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {saveError}
          </div>
        )}
        {saveSuccess && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            保存しました
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isSaving ? '保存中...' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
