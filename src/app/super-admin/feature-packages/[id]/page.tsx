"use client";

/**
 * /super-admin/feature-packages/[id] — 機能パッケージ詳細・編集
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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

/** 機能フラグの入力欄 (改行かカンマ区切り) を、フラグの並びにする */
function parseFeatureFlags(raw: string): string[] {
  return raw.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
}

/** 入力欄 (表示名・説明・機能フラグ・表示順) の値。機能フラグは入力欄の文字 (改行かカンマ区切り) のまま */
type FeaturePackageInputs = { displayName: string; description: string; featureFlagsRaw: string; displayOrder: number };

/** 機能パッケージの行から作る入力欄の値 (機能フラグは 1 行に 1 つ) */
function featurePackageInputsOf(pkg: FeaturePackage): FeaturePackageInputs {
  return {
    displayName: pkg.display_name,
    description: pkg.description ?? '',
    featureFlagsRaw: pkg.feature_flags.join('\n'),
    displayOrder: pkg.display_order,
  };
}

/**
 * 保存に成功したあとの 1 つの入力欄の値 (#1917)。保存を押したときの値 (atSave) から応答を待つあいだに変えていなければ
 * 保存の応答の行の値 (saved) にし、変えていれば書きかけとして残す (次の保存で送る)
 */
function inputAfterSave<T extends string | number>(current: T, atSave: T, saved: T): T {
  return current === atSave ? saved : current;
}

/**
 * 読み直したあとの 1 つの入力欄の値 (#1917 の続き)。書きかけを残す読み直し (廃止に成功したあと) で、読み直す前の
 * 比べる元 (最後に読んだ・保存した行の値 = baseline) から変えていなければ読み直した値 (fresh) にし、変えていれば書きかけとして残す
 * (まだ保存していない入力を、読み直しで黙って消さない)。baseline が無い (書きかけを残さない読み込み) ときは読み直した値
 */
function inputAfterReload<T extends string | number>(current: T, baseline: T | undefined, fresh: T): T {
  return baseline !== undefined && current !== baseline ? current : fresh;
}

/** 保存で送る本文 (PATCH /api/super-admin/feature-packages/{id} の表示名・説明・機能フラグ・表示順) */
type FeaturePackageSaveBody = {
  display_name?: string;
  description?: string | null;
  feature_flags?: string[];
  display_order?: number;
};

/**
 * 保存で送る本文。最後に読んだ・保存した機能パッケージ (pkg) から変えた欄だけを入れる (#1917)。
 * 手を付けていない欄を送ると、画面を開いたあとに別の運営が変えたその欄を、開いたときの古い値で上書きしてしまう
 * (route は送られた項目をそのまま書く)。機能フラグは並びで比べる。説明の空欄は null にする (これまでと同じ)。
 * 手を付けていない入力欄は、読み込みと保存の成功のたびに pkg の値に揃える (handleSave) ので、ここで pkg と違う欄は運営が変えた欄
 */
function changedFeaturePackageFields(
  inputs: { displayName: string; description: string; flags: string[]; displayOrder: number },
  pkg: FeaturePackage,
): FeaturePackageSaveBody {
  const body: FeaturePackageSaveBody = {};
  if (inputs.displayName !== pkg.display_name) body.display_name = inputs.displayName;
  if (inputs.description !== (pkg.description ?? '')) body.description = inputs.description || null;
  const flagsChanged =
    inputs.flags.length !== pkg.feature_flags.length || inputs.flags.some((flag, i) => flag !== pkg.feature_flags[i]);
  if (flagsChanged) body.feature_flags = inputs.flags;
  if (inputs.displayOrder !== pkg.display_order) body.display_order = inputs.displayOrder;
  return body;
}

/** 保存を押したが、どの入力欄も最後に読んだ・保存した値から変えていなかったときの文 (送らない。#1917) */
const NO_FEATURE_PACKAGE_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

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
  // 保存を押したが送らなかったときの文 (変えた欄が無い。#1917)
  const [saveInfo, setSaveInfo] = useState('');
  // 入力欄の比べる元 (最後に読んだ・保存した行)。描画を待たずに、読み直しの応答の時点の値を読むための写し (#1917 の続き)
  const pkgRef = useRef<FeaturePackage | null>(null);

  /**
   * 機能パッケージを読む。keepEdits のときは、入力欄のうち比べる元 (最後に読んだ・保存した行) から変えている (書きかけの) 欄を残し、
   * ほかは読んだ値にする (廃止に成功したあとの読み直しで、まだ保存していない入力を黙って消さない。#1917 の続き)
   */
  const fetchPkg = useCallback(async (options: { keepEdits?: boolean } = {}) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`);
      const data = await res.json() as { data?: FeaturePackage; error?: { message: string } };
      if (!res.ok) {
        setError(data.error?.message ?? '取得に失敗しました');
        return;
      }
      const loaded = data.data!;
      const inputs = featurePackageInputsOf(loaded);
      const baseline = options.keepEdits === true && pkgRef.current ? featurePackageInputsOf(pkgRef.current) : undefined;
      pkgRef.current = loaded;
      setPkg(loaded);
      setDisplayName((current) => inputAfterReload(current, baseline?.displayName, inputs.displayName));
      setDescription((current) => inputAfterReload(current, baseline?.description, inputs.description));
      setFeatureFlagsRaw((current) => inputAfterReload(current, baseline?.featureFlagsRaw, inputs.featureFlagsRaw));
      setDisplayOrder((current) => inputAfterReload(current, baseline?.displayOrder, inputs.displayOrder));
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
    if (!pkg) return;
    setSaveInfo('');
    const flags = parseFeatureFlags(featureFlagsRaw);
    if (flags.length === 0) {
      setSaveError('機能フラグを少なくとも1つ入力してください');
      return;
    }
    setSaveError('');
    setSaveSuccess(false);
    // 送るのは、最後に読んだ・保存した値から変えた欄だけ (手を付けていない欄を古い値で上書きしない。#1917)。
    // 押したときの入力欄の値は写しておく (応答を待つあいだに変えた欄を、保存の成功のあとに見分けるため)
    const inputsAtSave: FeaturePackageInputs = { displayName, description, featureFlagsRaw, displayOrder };
    const changes = changedFeaturePackageFields({ displayName, description, flags, displayOrder }, pkg);
    if (Object.keys(changes).length === 0) {
      setSaveInfo(NO_FEATURE_PACKAGE_CHANGES_MESSAGE);
      return;
    }
    setIsSaving(true);

    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const data = await res.json() as { data?: FeaturePackage; error?: { message: string } };
      if (!res.ok) {
        setSaveError(data.error?.message ?? '保存に失敗しました');
        return;
      }
      // 保存の応答の行 (書いたあとの最新の行) を新しい比べる元にし、手を付けていない入力欄もその行の値に揃える (#1917)。
      // 送らなかった欄には、画面を開いたあとに別の運営が変えた値が入っていることがある。比べる元だけを新しくして入力欄を
      // 古い値のままにすると、その欄が変えた欄に見え、次の保存 (何も変えずに押しても) で開いたときの古い値を送って、
      // 別の運営の変更を上書きしてしまう。応答を待つあいだに変えた欄は書きかけとして残す (次の保存で送る)
      const saved = data.data!;
      const savedInputs = featurePackageInputsOf(saved);
      pkgRef.current = saved;
      setPkg(saved);
      setDisplayName((current) => inputAfterSave(current, inputsAtSave.displayName, savedInputs.displayName));
      setDescription((current) => inputAfterSave(current, inputsAtSave.description, savedInputs.description));
      setFeatureFlagsRaw((current) => inputAfterSave(current, inputsAtSave.featureFlagsRaw, savedInputs.featureFlagsRaw));
      setDisplayOrder((current) => inputAfterSave(current, inputsAtSave.displayOrder, savedInputs.displayOrder));
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
      // 書きかけの入力欄は残す (まだ保存していない入力を、廃止のあとの読み直しで黙って消さない。#1917 の続き)
      if (res.ok) fetchPkg({ keepEdits: true });
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

  const flags = parseFeatureFlags(featureFlagsRaw);

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
            onChange={(e) => { setDisplayName(e.target.value); setSaveInfo(''); }}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">説明</label>
          <textarea
            value={description}
            onChange={(e) => { setDescription(e.target.value); setSaveInfo(''); }}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">機能フラグ</label>
          <textarea
            value={featureFlagsRaw}
            onChange={(e) => { setFeatureFlagsRaw(e.target.value); setSaveInfo(''); }}
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
            onChange={(e) => { setDisplayOrder(Number(e.target.value)); setSaveInfo(''); }}
            min="0"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {saveError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {saveError}
          </div>
        )}
        {saveInfo && (
          <div
            data-testid="save-info"
            className="bg-slate-50 border border-slate-200 text-slate-600 px-4 py-3 rounded-lg text-sm"
          >
            {saveInfo}
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
