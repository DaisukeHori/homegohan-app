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
import {
  FORCE_DISSOLVE_NOT_DONE_GUIDE,
  FORCE_DISSOLVE_RELOAD_FAILED_GUIDE,
  OperatorScreenError,
  displayableOperatorError,
  fetchOperatorRows,
  operatorForceActionNoResponseMessage,
  postOperatorForceAction,
} from '@/lib/membership/operator-screen-messages';

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

/** 一覧の API */
const LIST_URL = '/api/operator/membership/families/inactive';
/** 読み込みの失敗の文の対象 */
const LIST_SUBJECT = '家族グループの一覧';
/** 一覧の読み込みの失敗で、例外の文が出せないときの固定の文 */
const LIST_LOAD_FAILED_FALLBACK = `${LIST_SUBJECT}を読み込めませんでした`;

/**
 * 読み直した一覧に、対象がまだ解散されずに残っているか (#2080 U5)。
 * 一覧の RPC (list_families_with_inactive_representative) は family_groups.status = 'active' の家族グループだけを返すので、
 * 解散が済めば一覧から外れる
 */
function isStillDissolvable(rows: readonly FamilyRow[], familyId: string): boolean {
  return rows.some((row) => row.family_id === familyId);
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
      setRows(await fetchOperatorRows<FamilyRow>(LIST_URL, LIST_SUBJECT));
    } catch (err) {
      // 通信の失敗・本文に文の無い失敗も日本語の文にする (ブラウザの英字の文・「HTTP 502」だけを出さない。#2080 U5)
      setError(displayableOperatorError(err, LIST_LOAD_FAILED_FALLBACK));
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
    const targetId = dissolveTarget.scope_id;
    // 失敗の応答は、日本語の文の例外を投げる (確認の枠が出す)
    const result = await postOperatorForceAction(
      `/api/operator/membership/family/${targetId}/dissolve`,
      { reason: dissolveReason },
      'dissolve',
    );
    if (result.kind === 'no-response') {
      // 応答を受け取れなかった (通信の失敗・本文の無い 502 / 503 / 504)。サーバーが解散を済ませてから切れたこともあるので、
      // 一覧を読み直して確かめる (#2080 U5・#2086 V1)
      let reloaded: FamilyRow[];
      try {
        reloaded = await fetchOperatorRows<FamilyRow>(LIST_URL, LIST_SUBJECT);
      } catch {
        // 済んだか分からない。確認の枠を閉じ、一覧 (行の「解散」) も出さずに、「更新」で読み直せるまで解散を押させない (#2086 V1)
        setDissolveTarget(null);
        setError(operatorForceActionNoResponseMessage('dissolve', result.status, FORCE_DISSOLVE_RELOAD_FAILED_GUIDE));
        return;
      }
      setRows(reloaded);
      if (isStillDissolvable(reloaded, targetId)) {
        throw new OperatorScreenError(
          operatorForceActionNoResponseMessage('dissolve', result.status, FORCE_DISSOLVE_NOT_DONE_GUIDE),
        );
      }
      // 解散が済んでいた (一覧から外れた)。確認の枠を閉じて、読み直した一覧を見せる
      setDissolveTarget(null);
      router.refresh();
      return;
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
