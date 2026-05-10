'use client';

/**
 * 強制操作確認 modal
 * docs/design/membership/05-operator-emergency-ui.md §6.1 準拠
 */

import { useState } from 'react';

export type ForceActionConfirmModalProps = {
  scope: 'organization' | 'family';
  scopeName: string;
  action: 'transfer' | 'dissolve';
  newAssignee?: { id: string; label: string };
  reason: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

export default function ForceActionConfirmModal({
  scope,
  scopeName,
  action,
  newAssignee,
  reason,
  onConfirm,
  onCancel,
}: ForceActionConfirmModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = scope === 'organization' ? '組織' : '家族グループ';
  const actionLabel = action === 'transfer' ? '強制譲渡' : '強制解散';

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-bold text-gray-900">確認</h2>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {action === 'transfer' && newAssignee ? (
            <p className="text-gray-700">
              <span className="font-semibold">「{scopeName}」</span> の{scopeLabel}オーナーを
              <br />
              <span className="font-semibold text-blue-700">{newAssignee.label}</span> に{actionLabel}します。
            </p>
          ) : (
            <p className="text-gray-700">
              <span className="font-semibold">「{scopeName}」</span> を{actionLabel}します。
            </p>
          )}

          <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600">
            <span className="font-medium">理由:</span> {reason}
          </div>

          <p className="text-sm text-gray-500">全メンバに通知メールが送信されます。</p>
          <p className="text-sm font-semibold text-red-600">この操作は取り消せません。</p>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading && (
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            実行する
          </button>
        </div>
      </div>
    </div>
  );
}
