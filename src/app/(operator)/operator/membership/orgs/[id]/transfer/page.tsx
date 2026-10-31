'use client';

/**
 * /operator/membership/orgs/[id]/transfer
 * 組織 owner 強制譲渡画面
 * 05-operator-emergency-ui.md §5.3 準拠
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ForceActionConfirmModal from '@/components/operator/membership/ForceActionConfirmModal';
import {
  FORCE_TRANSFER_NOT_DONE_GUIDE,
  FORCE_TRANSFER_RELOAD_FAILED_GUIDE,
  FORCE_TRANSFER_RELOAD_UNAVAILABLE_GUIDE,
  OperatorLoadUnavailableError,
  OperatorScreenError,
  displayableOperatorError,
  fetchOperatorRows,
  isForceTransferDone,
  operatorForceActionNoResponseMessage,
  operatorForceActionReloadFailure,
  postOperatorForceAction,
} from '@/lib/membership/operator-screen-messages';
import { normalizeProfileName } from '@/lib/profile-name';
import { orgRoleLabel } from '@/lib/membership/role-labels';

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

/** 戻る先の一覧 */
const LIST_PATH = '/operator/membership/orgs/inactive';
/** 読み込みの失敗の文の対象 */
const CANDIDATES_SUBJECT = '譲渡の候補';
/** 候補の読み込みの失敗で、例外の文が出せないときの固定の文 */
const CANDIDATES_LOAD_FAILED_FALLBACK = `${CANDIDATES_SUBJECT}を読み込めませんでした`;
/** 譲渡の応答を受け取れなかったあとの候補の読み直しが失敗したときに続ける文 (「再試行」で確かめる / 401・403 で読み込み直しても変わらない。#2101 X4) */
const TRANSFER_RELOAD_GUIDES = {
  reloadFailedGuide: FORCE_TRANSFER_RELOAD_FAILED_GUIDE,
  unavailableGuide: FORCE_TRANSFER_RELOAD_UNAVAILABLE_GUIDE,
} as const;

export default function OrgTransferPage() {
  // パスの値は useParams で読む。props の params は Next 15 から Promise で、Next 14 では use(params) が例外になった (#1275)。
  // useParams はどちらでも同じに使えるので、こちらにそろえている (#1444)。
  const { id: orgId } = useParams<{ id: string }>();
  const router = useRouter();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // エラーに「再試行」を出すか。読み込みが 401 (ログインが切れた)・403 (権限が外れた) で断られたときは、読み込み直しても
  // 変わらないので false (押しても必ず同じ理由で断られる「再試行」を出さない。#2101 X4)
  const [errorRetryable, setErrorRetryable] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  // 譲渡の応答を受け取れず、候補の読み直しにも失敗して、済んだか分からない譲渡 (#2086 V1)。
  // あるあいだは候補と「強制譲渡を実行」を出さず (押し直すと同じ人への譲渡がもう一度通り、監査と通知メールが二重になる)、
  // 「再試行」で候補を読み直せたら済んだかを決める。status は応答を受け取れなかった理由 (null は通信の失敗、数は本文の無い 502 / 503 / 504)
  const [unknownTransfer, setUnknownTransfer] = useState<{ toUserId: string; status: number | null } | null>(null);
  // 読み直したら譲渡はまだ済んでいなかった、という知らせ (「再試行」の読み直しのあと。もう一度実行できる)
  const [notice, setNotice] = useState<string | null>(null);

  const candidatesUrl = `/api/operator/membership/org/${orgId}/candidates`;

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCandidates(await fetchOperatorRows<Candidate>(candidatesUrl, CANDIDATES_SUBJECT));
    } catch (err) {
      // 通信の失敗・本文に文の無い失敗も日本語の文にする (ブラウザの英字の文・「HTTP 502」だけを出さない。#2080 U5)
      setError(displayableOperatorError(err, CANDIDATES_LOAD_FAILED_FALLBACK));
      setErrorRetryable(!(err instanceof OperatorLoadUnavailableError));
    } finally {
      setLoading(false);
    }
  }, [candidatesUrl]);

  useEffect(() => { fetchCandidates(); }, [fetchCandidates]);

  const selected = candidates.find((c) => c.id === selectedId);

  async function handleTransferConfirm() {
    if (!selectedId) return;
    setNotice(null);
    // 失敗の応答は、日本語の文の例外を投げる (確認の枠が出す)
    const result = await postOperatorForceAction(
      `/api/operator/membership/org/${orgId}/transfer`,
      { to_user_id: selectedId, reason },
      'transfer',
    );
    if (result.kind === 'no-response') {
      // 応答を受け取れなかった (通信の失敗・本文の無い 502 / 503 / 504)。サーバーが譲渡を済ませてから切れたこともあるので、
      // 候補を読み直して確かめる (#2080 U5・#2086 V1)
      let reloaded: Candidate[];
      try {
        reloaded = await fetchOperatorRows<Candidate>(candidatesUrl, CANDIDATES_SUBJECT);
      } catch (reloadError) {
        // 済んだか分からない。確認の枠を閉じ、「再試行」で読み直せるまで譲渡を押させない (#2086 V1)。
        // 読み直しが 401 / 403 なら、理由の文を出し「再試行」は出さない (譲渡は止めたまま。#2101 X4)
        setShowConfirm(false);
        setUnknownTransfer({ toUserId: selectedId, status: result.status });
        const failure = operatorForceActionReloadFailure('transfer', result.status, reloadError, TRANSFER_RELOAD_GUIDES);
        setError(failure.message);
        setErrorRetryable(failure.retryable);
        return;
      }
      if (!isForceTransferDone(reloaded, selectedId)) {
        setCandidates(reloaded);
        throw new OperatorScreenError(
          operatorForceActionNoResponseMessage('transfer', result.status, FORCE_TRANSFER_NOT_DONE_GUIDE),
        );
      }
    }
    // 成功・読み直して済んでいた・譲渡先がすでに今の代表者 / オーナーだった (already-done。押し直しを route が止めた) なら一覧へ戻す
    router.push(LIST_PATH);
  }

  /**
   * エラーの「再試行」。済んだか分からない譲渡があれば、候補を読み直して済んだかを決める (#2086 V1):
   * 選んだメンバーが候補から外れていれば済んでいたので一覧へ戻し、まだ候補にいれば済んでいない旨を出して候補を戻す (もう一度実行できる)。
   * 読み直しにも失敗したら、済んだか分からない文のまま止め続ける。済んだか分からない譲渡が無ければ、候補を読み込み直すだけ
   */
  async function handleRetry() {
    if (!unknownTransfer) {
      await fetchCandidates();
      return;
    }
    setLoading(true);
    try {
      const reloaded = await fetchOperatorRows<Candidate>(candidatesUrl, CANDIDATES_SUBJECT);
      if (isForceTransferDone(reloaded, unknownTransfer.toUserId)) {
        router.push(LIST_PATH);
        return;
      }
      setCandidates(reloaded);
      setUnknownTransfer(null);
      setError(null);
      setNotice(operatorForceActionNoResponseMessage('transfer', unknownTransfer.status, FORCE_TRANSFER_NOT_DONE_GUIDE));
    } catch (reloadError) {
      // 済んだか分からない文 (error) のまま止め続ける。読み直しが 401 / 403 なら、理由の文にして「再試行」を外す (#2101 X4)
      if (reloadError instanceof OperatorLoadUnavailableError) {
        const failure = operatorForceActionReloadFailure('transfer', unknownTransfer.status, reloadError, TRANSFER_RELOAD_GUIDES);
        setError(failure.message);
        setErrorRetryable(failure.retryable);
      }
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = selectedId !== null && reason.trim().length > 0;

  return (
    <div>
      <div className="mb-6">
        <Link
          href={LIST_PATH}
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
        <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-lg text-sm space-y-2">
          <p>{error}</p>
          {errorRetryable && (
            <button
              type="button"
              onClick={handleRetry}
              disabled={loading}
              className="px-3 py-1 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              再試行
            </button>
          )}
        </div>
      )}

      {notice && !error && (
        <div className="mb-4 p-4 bg-amber-50 text-amber-800 rounded-lg text-sm">{notice}</div>
      )}

      {!loading && !error && !unknownTransfer && (
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
                        {c.email ?? normalizeProfileName(c.nickname) ?? c.id}
                      </p>
                      <p className="text-xs text-gray-500">
                        {orgRoleLabel(c.org_role)} &mdash; 最終ログイン: {formatLastLogin(c.last_login_at)}
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
              href={LIST_PATH}
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

      {showConfirm && selected && !unknownTransfer && (
        <ForceActionConfirmModal
          scope="organization"
          scopeName={`組織 (${orgId})`}
          action="transfer"
          newAssignee={{
            id: selected.id,
            label: selected.email ?? normalizeProfileName(selected.nickname) ?? selected.id,
          }}
          reason={reason}
          onConfirm={handleTransferConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
