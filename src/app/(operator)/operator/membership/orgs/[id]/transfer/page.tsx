'use client';

/**
 * /operator/membership/orgs/[id]/transfer
 * 組織 owner 強制譲渡画面
 * 05-operator-emergency-ui.md §5.3 準拠
 */

import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ForceActionConfirmModal from '@/components/operator/membership/ForceActionConfirmModal';

type Candidate = {
  id: string;
  nickname: string | null;
  org_role: string | null;
  last_login_at: string | null;
  email: string | null;
};

function formatLastLogin(v: string | null): string {
  if (!v) return '未ログイン';
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(v));
  } catch {
    return v;
  }
}

export default function OrgTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = use(params);
  const router = useRouter();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/membership/org/${orgId}/candidates`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setCandidates(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const selected = candidates.find((c) => c.id === selectedId);

  async function handleTransferConfirm() {
    if (!selectedId) return;
    const res = await fetch(`/api/operator/membership/org/${orgId}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_user_id: selectedId, reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    router.push('/operator/membership/orgs/inactive');
  }

  const canSubmit = selectedId !== null && reason.trim().length > 0;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/operator/membership/orgs/inactive"
          className="text-sm text-blue-600 hover:underline"
        >
          &#8592; 一覧に戻る
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">組織オーナー 強制譲渡</h1>
        <p className="text-sm text-gray-500 mt-1">組織 ID: {orgId}</p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
          候補メンバを読み込み中...
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {!loading && !error && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-6">
          {/* 候補メンバ一覧 */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">新オーナー候補</h2>
            {candidates.length === 0 ? (
              <p className="text-sm text-gray-500">譲渡可能なメンバがいません</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <label
                    key={c.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedId === c.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="candidate"
                      value={c.id}
                      checked={selectedId === c.id}
                      onChange={() => setSelectedId(c.id)}
                      className="text-blue-600"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {c.email ?? c.nickname ?? c.id}
                      </p>
                      <p className="text-xs text-gray-500">
                        {c.org_role ?? 'member'} &mdash; 最終ログイン: {formatLastLogin(c.last_login_at)}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* 理由入力 */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              理由 <span className="text-red-500">*</span>
              <span className="text-xs font-normal text-gray-500 ml-1">(全メンバへの通知メールに記載)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              className="w-full border border-gray-300 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="例: オーナーが90日以上未ログインのため、運営側で次期オーナーへ譲渡します。"
            />
          </div>

          {/* ボタン */}
          <div className="flex justify-end gap-3">
            <Link
              href="/operator/membership/orgs/inactive"
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              キャンセル
            </Link>
            <button
              disabled={!canSubmit}
              onClick={() => setShowConfirm(true)}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              強制譲渡を実行
            </button>
          </div>
        </div>
      )}

      {showConfirm && selected && (
        <ForceActionConfirmModal
          scope="organization"
          scopeName={`組織 (${orgId})`}
          action="transfer"
          newAssignee={{
            id: selected.id,
            label: selected.email ?? selected.nickname ?? selected.id,
          }}
          reason={reason}
          onConfirm={handleTransferConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
