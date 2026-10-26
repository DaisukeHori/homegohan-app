"use client";

/**
 * /super-admin/feature-packages/[id] — 機能パッケージ詳細・編集
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { isStatusChangeConflict, operationFailureMessage, operationNetworkFailureMessage } from '@/lib/admin/api-error-message';
import { FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE } from '@/lib/super-admin/feature-packages-schemas';

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
 * 手を付けていない入力欄は、読み込み・保存の成功・廃止の成功・廃止の 409 のあとの読み直しのたびに pkg の値に揃える (handleSave・handleDeprecate の applyLatestPackage) ので、ここで pkg と違う欄は運営が変えた欄
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

/** 廃止が失敗したときの文の頭 (後ろに理由を添える) */
const DEPRECATE_FAILURE_SUMMARY = '廃止できませんでした';

/**
 * 廃止が 409 (遷移表に無い変更・同時の変更) で断られ、機能パッケージを読み直せたときの理由の文 (#2064)。
 * 画面の status が古かった (別の操作で廃止されていた)。英字の状態の値は出さない
 */
const STATUS_CONFLICT_RELOADED_REASON = '別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込み直しました';

/** 廃止が 409 で断られ、読み直しも失敗したときの理由の文 (#2064) */
const STATUS_CONFLICT_RELOAD_FAILED_REASON =
  '別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込めなかったので、ページを読み込み直してください';

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
  // 廃止の応答を待っているか・失敗したときの文
  const [isDeprecating, setIsDeprecating] = useState(false);
  const [deprecateError, setDeprecateError] = useState('');
  // 保存か廃止のどちらかの応答を待っているか (#2050)。どちらの応答も、その行 (書いたあとの行) をそのまま画面の行にするので、
  // 2 つを重ねると、応答が送った順と逆に届いたとき、後に届いた古い方の行 (例: 廃止の前の status) が画面に残る。
  // 待つあいだは両方のボタンを止め、押されても送らない。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  const isWriting = isSaving || isDeprecating;

  const fetchPkg = useCallback(async () => {
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
      setPkg(loaded);
      setDisplayName(inputs.displayName);
      setDescription(inputs.description);
      setFeatureFlagsRaw(inputs.featureFlagsRaw);
      setDisplayOrder(inputs.displayOrder);
    } catch {
      setError('ネットワークエラー');
    } finally {
      setIsLoading(false);
    }
  }, [pkgId]);

  useEffect(() => {
    fetchPkg();
  }, [fetchPkg]);

  /**
   * 書いたあと・読み直したあとの最新の行 (latest) を画面の行にする。入力欄は、inputsBefore (押したときの最後に読んだ・保存した行の値)
   * から変えていない欄だけ latest の値に揃え、書きかけは残す (inputAfterSave。#1917)
   */
  const applyLatestPackage = (latest: FeaturePackage, inputsBefore: FeaturePackageInputs) => {
    const latestInputs = featurePackageInputsOf(latest);
    setPkg(latest);
    setDisplayName((current) => inputAfterSave(current, inputsBefore.displayName, latestInputs.displayName));
    setDescription((current) => inputAfterSave(current, inputsBefore.description, latestInputs.description));
    setFeatureFlagsRaw((current) => inputAfterSave(current, inputsBefore.featureFlagsRaw, latestInputs.featureFlagsRaw));
    setDisplayOrder((current) => inputAfterSave(current, inputsBefore.displayOrder, latestInputs.displayOrder));
  };

  /** 409 のあとに機能パッケージを読み直す (全体を「読み込み中」にしない)。読めなければ null (#2064) */
  const rereadPackage = async (): Promise<FeaturePackage | null> => {
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`);
      if (!res.ok) return null;
      const data = await res.json() as { data?: FeaturePackage };
      return data.data ?? null;
    } catch {
      return null;
    }
  };

  const handleSave = async () => {
    // 廃止の応答を待つあいだは送らない (#2050。writeInFlightRef)
    if (!pkg || writeInFlightRef.current) return;
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
    writeInFlightRef.current = true;
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
      applyLatestPackage(data.data!, inputsAtSave);
      setSaveSuccess(true);
    } catch {
      setSaveError('ネットワークエラー');
    } finally {
      writeInFlightRef.current = false;
      setIsSaving(false);
    }
  };

  /**
   * 廃止。失敗の応答を黙って捨てず、理由を画面に出す (403 は理由の文 (二段階認証の確認が要る など) だけを通す。operationFailureMessage)。
   * 成功したら PATCH の応答の行 (書いたあとの最新の行) で表示を新しくする。全体を「読み込み中」にして読み直さない。
   * 入力欄は保存の経路と同じく、手を付けていない欄だけ応答の行の値に揃え、書きかけは残す (inputAfterSave。#1917)。
   * 保存の応答を待つあいだは送らない (#2050。writeInFlightRef)。
   * 409 で、画面の status が古かった (遷移表に無い変更 OP_FEATURE_PACKAGE_INVALID_TRANSITION・同時の変更 CONFLICT_STALE_DATA) ときは、
   * 機能パッケージを読み直して状態の表示とボタンを今の状態にし、日本語の文を出す (書きかけは残す。#2064)
   */
  const handleDeprecate = async () => {
    if (!pkg || writeInFlightRef.current) return;
    if (!confirm('この機能パッケージを廃止しますか？')) return;
    // 押したときの最後に読んだ・保存した行から作る入力欄の値 (入力欄がこれと同じなら手を付けていない欄)
    const loadedInputs = featurePackageInputsOf(pkg);
    setDeprecateError('');
    writeInFlightRef.current = true;
    setIsDeprecating(true);
    try {
      const res = await fetch(`/api/super-admin/feature-packages/${pkgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deprecated' }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStatusChangeConflict(res.status, body, FEATURE_PACKAGE_INVALID_TRANSITION_ERROR_CODE)) {
          const latest = await rereadPackage();
          if (latest) applyLatestPackage(latest, loadedInputs);
          const reason = latest ? STATUS_CONFLICT_RELOADED_REASON : STATUS_CONFLICT_RELOAD_FAILED_REASON;
          setDeprecateError(`${DEPRECATE_FAILURE_SUMMARY}（${reason}）`);
          return;
        }
        setDeprecateError(operationFailureMessage(DEPRECATE_FAILURE_SUMMARY, res.status, body));
        return;
      }
      // 応答は { data: 書いたあとの行 } (保存の経路と同じ形。route は .update().select() の行を返す)
      applyLatestPackage((await res.json() as { data: FeaturePackage }).data, loadedInputs);
    } catch {
      setDeprecateError(operationNetworkFailureMessage(DEPRECATE_FAILURE_SUMMARY));
    } finally {
      writeInFlightRef.current = false;
      setIsDeprecating(false);
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
            disabled={isWriting}
            className="px-3 py-1.5 border border-red-300 text-red-600 rounded-lg text-xs font-medium hover:bg-red-50 transition-colors disabled:opacity-50"
          >
            廃止する
          </button>
        )}
      </div>

      {deprecateError && (
        <div
          role="alert"
          data-testid="status-change-error"
          className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm"
        >
          {deprecateError}
        </div>
      )}

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
            disabled={isWriting}
            className="px-5 py-2 bg-orange-500 text-white rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-50"
          >
            {isSaving ? '保存中...' : '保存する'}
          </button>
        </div>
      </div>
    </div>
  );
}
