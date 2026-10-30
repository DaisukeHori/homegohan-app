'use client';

/**
 * /admin/users/{id} の「手動のプラン付与」(billing/02 §8.6・§10)。
 * super_admin で、対象が自分でないときだけ page (src/app/admin/users/[id]/page.tsx) が描く。
 * 開いたとき GET /api/super-admin/users/{id}/manual-plan で、live な契約 (S / M)・付与できるプラン・履歴を読む。
 *   - 契約なし → 付与のフォーム (プラン・有効期限 (任意)・理由) → 確認ダイアログ → POST
 *   - 手動付与の契約あり → 取り消しのフォーム (理由) → 確認ダイアログ → DELETE
 *   - Stripe の契約あり → 「Stripe の契約があるため、手動付与はできません」(解約は利用者の操作か Stripe で)
 * 成功は GET で読み直して表示を更新し、失敗は manualGrantErrorMessage(code) を出す (応答の本文の文面は出さない。400 OP_INVALID_INPUT は画面用の文)。
 * 403 の文が理由の文 (二段階認証の確認が要る など) なら、manual-grant-client がその理由の code にして返すので、読み直し・読み込み・
 * 付与・取り消しのどれでも理由の文を出す (ほかの運営の画面の forbiddenMessageForScreen と同じ規則。#2086 V4)。
 * 通信は src/lib/billing/manual-grant-client.ts だけで行う (URL をここで組み立てない)。
 *
 * 付与・取り消しの応答を受け取れなかった (通信が reject された・2xx なのに本文が形に合わない。manual-grant-client の
 * MANUAL_GRANT_CLIENT_NO_STATUS) ときは、サーバーが付与・取り消しを済ませてから応答が切れたこともあるので、今の契約を読み直して見せ、
 * 「<付与|取り消し>の応答を受け取れませんでした（通信エラー）」に続けて読み直した旨を出す (#2080。運営の画面の #2073 と同じ形)。
 * 読み直さないと、付与のフォームのまま残り、もう一度押すと 409「すでに有効な契約があります」になる。
 * 読み直した契約で操作が済んでいた (付与なら契約がある・取り消しなら手動付与の契約が無い) ときは入力欄を空にする
 * (付与の理由が取り消しの理由の欄に残らないように。成功のときと同じ)。
 * 読み直しが失敗したら「再試行」を出し、読み直せるまで付与・取り消しのボタンを止める (表示の契約が古いかもしれないため)。
 * 読み直しが 401 / 403 / 404 で断られたら、読み込み直しても変わらないので、その理由の文を出し「再試行」は出さない。
 *
 * プラン (今の契約・履歴・付与と取り消しの成功の文) は、英字の内部の値 (plan_key) ではなく、同じ画面の「現在のサブスクリプション」と
 * 同じ表示名 (src/lib/admin/plan-key-labels.ts の adminPlanKeyLabel。表に無い plan_key はそのまま) で出す (#2112 Z3)。
 * 付与のフォームの選択肢は「表示名 (plan_key)」の組のまま (付与する plan_key を運営が確かめられるように)。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  MANUAL_GRANT_REASON_MAX_LENGTH,
  manualGrantErrorMessage,
  type ManualGrantHistoryEntry,
  type ManualPlanView,
} from '@/lib/billing/manual-grant';
import {
  MANUAL_GRANT_CLIENT_NO_STATUS,
  fetchManualPlanView,
  grantManualPlanRequest,
  revokeManualPlanRequest,
} from '@/lib/billing/manual-grant-client';
import { adminPlanKeyLabel } from '@/lib/admin/plan-key-labels';
import {
  NO_RESPONSE_STATE_RELOADED_GUIDE,
  NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
} from '@/lib/super-admin/status-change-no-response';

/** 付与の確認ダイアログの文 (§10) */
export const GRANT_CONFIRM_MESSAGE = 'この利用者に有料プランを手動で付与します。利用者は課金なしでプランを使えるようになります。続けますか?';
/** 取り消しの確認ダイアログの文 */
export const REVOKE_CONFIRM_MESSAGE = '手動で付与したプランを取り消します。利用者はすぐに無料プランに戻ります。続けますか?';
/** 履歴の action_type の表示 */
export const MANUAL_GRANT_HISTORY_LABELS: Readonly<Record<ManualGrantHistoryEntry['action_type'], string>> = {
  'admin.billing.manual_grant': '付与',
  'admin.billing.manual_revoke': '取り消し',
  'system.billing.manual_grant_expired': '期限切れ',
};
/** 由来の表示 */
export const MANUAL_PLAN_SOURCE_LABELS: Readonly<Record<'stripe' | 'manual' | 'store', string>> = {
  stripe: 'Stripe',
  manual: '手動付与',
  store: 'ストア (アプリ内課金)',
};
/** 日時の表示 (JST)。期限は「その日の終わり」なので、翌日の 0 時を 1 日戻した日付で出さず、日時のまま出す */
export const MANUAL_PLAN_DISPLAY_LOCALE = 'ja-JP';
export const MANUAL_PLAN_DISPLAY_TIME_ZONE = 'Asia/Tokyo';
function formatDateTime(iso: string | null): string {
  return iso === null ? '期限なし' : new Date(iso).toLocaleString(MANUAL_PLAN_DISPLAY_LOCALE, { timeZone: MANUAL_PLAN_DISPLAY_TIME_ZONE });
}

/** 付与・取り消しのどちらの操作か (応答を受け取れなかったあとの読み直しで使う。#2080) */
type ManualPlanOperation = 'grant' | 'revoke';

/** 応答を受け取れなかったときの文の操作の名前 (#2080) */
export const MANUAL_PLAN_OPERATION_LABELS: Readonly<Record<ManualPlanOperation, string>> = {
  grant: '付与',
  revoke: '取り消し',
};

/**
 * 読み直しが、読み込み直しても変わらない理由で断られたかを見分ける HTTP ステータス (#2080)。
 * 401 (ログインが切れた)・403 (権限が外れた・自分自身になった)・404 (利用者が消えた)
 */
const RELOAD_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** 読み直した契約で、その操作が済んでいるか (付与なら契約がある・取り消しなら手動付与の契約が無い。#2080) */
function operationTookEffect(operation: ManualPlanOperation, view: ManualPlanView): boolean {
  return operation === 'grant' ? view.current !== null : view.current === null || view.current.source !== 'manual';
}

export function ManualPlanGrantSection({ userId }: { userId: string }) {
  const [view, setView] = useState<ManualPlanView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 応答を受け取れなかったあとの読み直しが失敗し、まだ読み直せていない操作 (#2080)。あるあいだは「再試行」を出し、付与・取り消しを止める
  const [pendingReread, setPendingReread] = useState<ManualPlanOperation | null>(null);

  const load = useCallback(async () => {
    const result = await fetchManualPlanView(userId);
    if (result.ok) {
      setView(result.data);
      setLoadError(null);
    } else {
      setLoadError(manualGrantErrorMessage(result.code));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBlocked = submitting || pendingReread !== null;
  const canGrant = view !== null && view.current === null && planKey !== '' && reason.trim().length > 0 && !isBlocked;
  const canRevoke = view !== null && view.current !== null && view.current.source === 'manual' && reason.trim().length > 0 && !isBlocked;

  /**
   * 付与・取り消しの応答を受け取れなかったあとに今の契約を読み直し、結果に合わせて文を出す (#2080)。
   * 読み直せたら表示を今の契約にし、操作が済んでいれば入力欄を空にする。読み直しが失敗したら「再試行」を待つ操作として記録する。
   * 401 / 403 / 404 は読み込み直しても変わらないので、その理由の文を出し、「再試行」は待たない
   */
  const rereadAfterNoResponse = async (operation: ManualPlanOperation) => {
    const result = await fetchManualPlanView(userId);
    const label = MANUAL_PLAN_OPERATION_LABELS[operation];
    if (result.ok) {
      setView(result.data);
      setLoadError(null);
      if (operationTookEffect(operation, result.data)) {
        setPlanKey('');
        setExpiresOn('');
        setReason('');
      }
      setError(statusChangeNoResponseMessage(label, NO_RESPONSE_STATE_RELOADED_GUIDE));
      setPendingReread(null);
      return;
    }
    if (RELOAD_UNAVAILABLE_STATUSES.has(result.status)) {
      setError(statusChangeNoResponseMessage(label, manualGrantErrorMessage(result.code)));
      setPendingReread(null);
      return;
    }
    setError(statusChangeNoResponseMessage(label, NO_RESPONSE_STATE_RELOAD_FAILED_GUIDE));
    setPendingReread(operation);
  };

  /** 「再試行」: 応答を受け取れなかったあとの失敗した読み直しをやり直す (#2080) */
  const handleRetryReread = async () => {
    if (pendingReread === null || submitting) return;
    setSubmitting(true);
    await rereadAfterNoResponse(pendingReread);
    setSubmitting(false);
  };

  const handleGrant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canGrant) return;
    if (!window.confirm(GRANT_CONFIRM_MESSAGE)) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    const result = await grantManualPlanRequest(userId, { plan_key: planKey, expires_on: expiresOn === '' ? null : expiresOn, reason });
    if (result.ok) {
      setMessage(`${adminPlanKeyLabel(result.data.plan_key)} を付与しました (有効期限: ${formatDateTime(result.data.expires_at)})`);
      setPlanKey('');
      setExpiresOn('');
      setReason('');
      await load();
    } else if (result.status === MANUAL_GRANT_CLIENT_NO_STATUS) {
      // 応答を受け取れなかった。付与が済んだかは分からないので、今の契約を読み直して見せる (#2080)
      await rereadAfterNoResponse('grant');
    } else {
      setError(manualGrantErrorMessage(result.code));
    }
    setSubmitting(false);
  };

  const handleRevoke = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRevoke) return;
    if (!window.confirm(REVOKE_CONFIRM_MESSAGE)) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    const result = await revokeManualPlanRequest(userId, { reason });
    if (result.ok) {
      setMessage(`${adminPlanKeyLabel(result.data.plan_key)} の付与を取り消しました`);
      setReason('');
      await load();
    } else if (result.status === MANUAL_GRANT_CLIENT_NO_STATUS) {
      // 応答を受け取れなかった。取り消しが済んだかは分からないので、今の契約を読み直して見せる (#2080)
      await rereadAfterNoResponse('revoke');
    } else {
      setError(manualGrantErrorMessage(result.code));
    }
    setSubmitting(false);
  };

  return (
    <section data-testid="manual-plan-grant" className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">手動のプラン付与</h2>
      {loadError !== null && (
        <p data-testid="manual-plan-grant-load-error" role="alert" className="text-sm text-red-600">
          {loadError}
        </p>
      )}
      {view !== null && view.current !== null && (
        <dl data-testid="manual-plan-grant-current" className="grid grid-cols-3 gap-4 text-sm mb-4">
          <div>
            <dt className="text-gray-500 mb-1">プラン</dt>
            <dd>{adminPlanKeyLabel(view.current.plan_key)}</dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">由来</dt>
            <dd>{MANUAL_PLAN_SOURCE_LABELS[view.current.source]}</dd>
          </div>
          <div>
            <dt className="text-gray-500 mb-1">{view.current.source === 'manual' ? '有効期限' : '次回更新'}</dt>
            <dd>{formatDateTime(view.current.expires_at)}</dd>
          </div>
        </dl>
      )}
      {view !== null && view.current !== null && view.current.source === 'stripe' && (
        <p data-testid="manual-plan-grant-stripe-note" className="text-sm text-gray-600">
          Stripe の契約があるため、手動付与はできません (解約は利用者の操作か Stripe で行います)。
        </p>
      )}
      {view !== null && view.current !== null && view.current.source === 'store' && (
        <p data-testid="manual-plan-grant-store-note" className="text-sm text-gray-600">
          ストアの契約があります。手動付与はできません (解約は利用者が App Store・Google Play の定期購読の管理で行います)。
        </p>
      )}
      {view !== null && view.current === null && (
        <form onSubmit={handleGrant} className="space-y-4">
          <div>
            <label htmlFor="manual-plan-grant-plan" className="block text-sm font-medium text-gray-700 mb-1">
              プラン
            </label>
            <select
              id="manual-plan-grant-plan"
              data-testid="manual-plan-grant-plan"
              value={planKey}
              onChange={(event) => setPlanKey(event.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            >
              <option value="">選択してください</option>
              {view.plans.map((plan) => (
                <option key={plan.plan_key} value={plan.plan_key}>
                  {plan.display_name} ({plan.plan_key})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="manual-plan-grant-expires-on" className="block text-sm font-medium text-gray-700 mb-1">
              有効期限 (任意。その日の終わりまで)
            </label>
            <input
              id="manual-plan-grant-expires-on"
              data-testid="manual-plan-grant-expires-on"
              type="date"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="manual-plan-grant-reason" className="block text-sm font-medium text-gray-700 mb-1">
              理由
            </label>
            <textarea
              id="manual-plan-grant-reason"
              data-testid="manual-plan-grant-reason"
              required
              maxLength={MANUAL_GRANT_REASON_MAX_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              rows={3}
            />
          </div>
          <button
            type="submit"
            data-testid="manual-plan-grant-submit"
            disabled={!canGrant}
            className="px-4 py-2 rounded-lg bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '付与中…' : '付与する'}
          </button>
        </form>
      )}
      {view !== null && view.current !== null && view.current.source === 'manual' && (
        <form onSubmit={handleRevoke} className="space-y-4">
          <div>
            <label htmlFor="manual-plan-revoke-reason" className="block text-sm font-medium text-gray-700 mb-1">
              取り消しの理由
            </label>
            <textarea
              id="manual-plan-revoke-reason"
              data-testid="manual-plan-revoke-reason"
              required
              maxLength={MANUAL_GRANT_REASON_MAX_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              rows={3}
            />
          </div>
          <button
            type="submit"
            data-testid="manual-plan-revoke-submit"
            disabled={!canRevoke}
            className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '取り消し中…' : '取り消す'}
          </button>
        </form>
      )}
      {message !== null && (
        <p data-testid="manual-plan-grant-result" role="status" className="mt-4 text-sm text-green-700">
          {message}
        </p>
      )}
      {error !== null && (
        <div className="mt-4 flex items-start justify-between gap-4">
          <p data-testid="manual-plan-grant-error" role="alert" className="text-sm text-red-600">
            {error}
          </p>
          {pendingReread !== null && (
            <button
              type="button"
              data-testid="manual-plan-grant-retry"
              onClick={() => void handleRetryReread()}
              disabled={submitting}
              className="shrink-0 text-sm text-red-600 underline whitespace-nowrap hover:text-red-800 disabled:opacity-50"
            >
              再試行
            </button>
          )}
        </div>
      )}
      {view !== null && view.history.length > 0 && (
        <div data-testid="manual-plan-grant-history" className="mt-6 space-y-2 text-sm">
          <h3 className="text-sm font-semibold text-gray-700">履歴 (直近 {view.history.length} 件)</h3>
          {view.history.map((entry) => (
            <div key={entry.id} className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
              <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-600 flex-shrink-0">
                {MANUAL_GRANT_HISTORY_LABELS[entry.action_type]}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-gray-700">{entry.plan_key ? adminPlanKeyLabel(entry.plan_key) : '-'}</span>
                {entry.expires_at !== null && <span className="ml-2 text-xs text-gray-500">期限: {formatDateTime(entry.expires_at)}</span>}
                {entry.reason !== null && <p className="text-xs text-gray-600 break-words">{entry.reason}</p>}
              </div>
              <span className="text-gray-400 text-xs flex-shrink-0">{formatDateTime(entry.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
