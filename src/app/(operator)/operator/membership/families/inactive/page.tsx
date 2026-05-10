'use client';

/**
 * /operator/membership/families/inactive
 * inactive representative を持つ家族グループ一覧
 * 05-operator-emergency-ui.md §5.2 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ForceActionConfirmModal from '@/components/operator/membership/ForceActionConfirmModal';
import InactiveOwnerTable, { type InactiveOwner } from '@/components/operator/membership/InactiveOwnerTable';

type FamilyRow = {
  family_id: string;
  family_name: string;
  representative_user_id: string;
  representative_email: string;
  member_count: number;
};

function toInactiveOwner(row: FamilyRow): InactiveOwner {
  return {
    scope_id: row.family_id,
    scope_name: row.family_name,
    owner_id: row.representative_user_id,
    owner_email: row.representative_email,
    last_login_at: null,
  };
}

export default function InactiveFamiliesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<FamilyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dissolveTarget, setDissolveTarget] = useState<InactiveOwner | null>(null);
  const [dissolveReason, setDissolveReason] = useState('');
  const [dissolveConfirm, setDissolveConfirm] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/membership/families/inactive');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  function handleDissolveClick(item: InactiveOwner) {
    setDissolveTarget(item);
    setDissolveReason('');
    setDissolveConfirm(false);
  }

  async function handleDissolveConfirm() {
    if (!dissolveTarget) return;
    const res = await fetch(`/api/operator/membership/family/${dissolveTarget.scope_id}/dissolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: dissolveReason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    setDissolveTarget(null);
    router.refresh();
    await fetchData();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">代表者長期不在の家族グループ</h1>
          <p className="text-sm text-gray-500 mt-1">30日以上未ログインまたは削除済みアカウントが代表者の家族グループ</p>
        </div>
        <button
          onClick={fetchData}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          更新
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
          読み込み中...
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {!loading && !error && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <InactiveOwnerTable
            items={rows.map(toInactiveOwner)}
            scope="family"
            onDissolve={handleDissolveClick}
          />
        </div>
      )}

      {/* 解散理由入力 */}
      {dissolveTarget && !dissolveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">
              家族グループ解散 — 「{dissolveTarget.scope_name}」
            </h2>
            <p className="text-sm text-gray-600 mb-3">
              解散理由を入力してください (全メンバに通知されます)
            </p>
            <textarea
              value={dissolveReason}
              onChange={(e) => setDissolveReason(e.target.value)}
              rows={4}
              className="w-full border border-gray-300 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400"
              placeholder="例: 代表者が90日以上未ログインのため、運営側で解散します。"
            />
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setDissolveTarget(null)}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                disabled={dissolveReason.trim().length === 0}
                onClick={() => setDissolveConfirm(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                次へ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 解散確認 modal */}
      {dissolveTarget && dissolveConfirm && (
        <ForceActionConfirmModal
          scope="family"
          scopeName={dissolveTarget.scope_name}
          action="dissolve"
          reason={dissolveReason}
          onConfirm={handleDissolveConfirm}
          onCancel={() => { setDissolveConfirm(false); }}
        />
      )}
    </div>
  );
}
