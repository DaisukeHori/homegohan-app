'use client';

/**
 * /admin/users/{id} の「手動のプラン付与」(billing/02 §8.6・§10)。
 * super_admin で、対象が自分でないときだけ page (src/app/admin/users/[id]/page.tsx) が描く。
 * 開いたとき GET /api/super-admin/users/{id}/manual-plan で、live な契約 (S / M)・付与できるプラン・履歴を読む。
 *   - 契約なし → 付与のフォーム (プラン・有効期限 (任意)・理由) → 確認ダイアログ → POST
 *   - 手動付与の契約あり → 取り消しのフォーム (理由) → 確認ダイアログ → DELETE
 *   - Stripe の契約あり → 「Stripe の契約があるため、手動付与はできません」(解約は利用者の操作か Stripe で)
 * 成功は GET で読み直して表示を更新し、失敗は manualGrantErrorMessage(code) を出す (応答の本文の文面は読まない。400 OP_INVALID_INPUT は画面用の文)。
 * 通信は src/lib/billing/manual-grant-client.ts だけで行う (URL をここで組み立てない)。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  MANUAL_GRANT_REASON_MAX_LENGTH,
  manualGrantErrorMessage,
  type ManualGrantHistoryEntry,
  type ManualPlanView,
} from '@/lib/billing/manual-grant';
import { fetchManualPlanView, grantManualPlanRequest, revokeManualPlanRequest } from '@/lib/billing/manual-grant-client';

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

export function ManualPlanGrantSection({ userId }: { userId: string }) {
  const [view, setView] = useState<ManualPlanView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planKey, setPlanKey] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const canGrant = view !== null && view.current === null && planKey !== '' && reason.trim().length > 0 && !submitting;
  const canRevoke = view !== null && view.current !== null && view.current.source === 'manual' && reason.trim().length > 0 && !submitting;

  const handleGrant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canGrant) return;
    if (!window.confirm(GRANT_CONFIRM_MESSAGE)) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    const result = await grantManualPlanRequest(userId, { plan_key: planKey, expires_on: expiresOn === '' ? null : expiresOn, reason });
    if (result.ok) {
      setMessage(`${result.data.plan_key} を付与しました (有効期限: ${formatDateTime(result.data.expires_at)})`);
      setPlanKey('');
      setExpiresOn('');
      setReason('');
      await load();
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
      setMessage(`${result.data.plan_key} の付与を取り消しました`);
      setReason('');
      await load();
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
            <dd className="font-mono">{view.current.plan_key}</dd>
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
        <p data-testid="manual-plan-grant-error" role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
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
                <span className="font-mono text-gray-700">{entry.plan_key ?? '-'}</span>
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
