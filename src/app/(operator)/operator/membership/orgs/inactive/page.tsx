'use client';

/**
 * /operator/membership/orgs/inactive
 * inactive owner を持つ組織一覧
 * 05-operator-emergency-ui.md §5.2 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ForceActionConfirmModal from '@/components/operator/membership/ForceActionConfirmModal';
import InactiveOwnerTable, { type InactiveOwner } from '@/components/operator/membership/InactiveOwnerTable';

type OrgRow = {
  organization_id: string;
  organization_name: string;
  owner_user_id: string;
  owner_email: string;
  owner_last_sign_in: string | null;
  member_count: number;
  dissolved: boolean;
};

function toInactiveOwner(row: OrgRow): InactiveOwner {
  return {
    scope_id: row.organization_id,
    scope_name: row.organization_name,
    owner_id: row.owner_user_id,
    owner_email: row.owner_email,
    last_login_at: row.owner_last_sign_in,
  };
}

export default function InactiveOrgsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dissolveTarget, setDissolveTarget] = useState<InactiveOwner | null>(null);
  const [dissolveReason, setDissolveReason] = useState('');
  const [dissolveConfirm, setDissolveConfirm] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/membership/orgs/inactive');
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
    const res = await fetch(`/api/operator/membership/org/${dissolveTarget.scope_id}/dissolve`, {
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

  const activeRows = rows.filter((r) => !r.dissolved);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">オーナー長期不在の組織</h1>
          <p className="text-sm text-gray-500 mt-1">30日以上未ログインまたは削除済みアカウントが owner の組織</p>
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
            items={activeRows.map(toInactiveOwner)}
            scope="org"
            onDissolve={handleDissolveClick}
          />
        </div>
      )}

      {/* 解散理由入力 */}
      {dissolveTarget && !dissolveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">
              組織解散 — 「{dissolveTarget.scope_name}」
            </h2>
            <p className="text-sm text-gray-600 mb-3">
              解散理由を入力してください (全メンバに通知されます)
            </p>
            <textarea
              value={dissolveReason}
              onChange={(e) => setDissolveReason(e.target.value)}
              rows={4}
              className="w-full border border-gray-300 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-400"
              placeholder="例: オーナーが90日以上未ログインのため、運営側で解散します。"
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
          scope="organization"
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
