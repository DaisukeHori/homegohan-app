'use client';

/**
 * /admin/users/{id} の「二段階認証を解除」(段 C。#1707・#1176。docs/design/cross/12-operator-mfa.md §15.3・§15.2・§14.7)
 *
 * 実行者が super_admin で、対象が MFA_REQUIRED_ROLES のどれかを持つときだけ、ページ (src/app/admin/users/[id]/page.tsx) が描く。
 * 理由・本人確認の方法・「本人確認を行った」のチェックの 3 つがそろうまで [解除する] を押せない。
 * 押すと確認ダイアログ → POST /api/super-admin/admins/{id}/mfa/reset (src/lib/auth/mfa/client.ts の resetOperatorMfa だけで呼ぶ)。
 * 成功は消した数・失敗は mfaErrorMessage(code) を出す。ただし 401 は code に関わらず、同じページのほかの運営の form (凍結・手動のプラン付与) と同じ
 * 「ログインし直してください」(UNAUTHENTICATED_SCREEN_MESSAGE。#2112 Z4。mfaErrorMessage の 401 の code の文は、利用者の二段階認証の画面の言い回し)。
 * 401 も文を出すだけ (運営の画面の移動は layout の requireRoleForPage が受け持つ)。
 * 500 は、監査の後のセッションの終了・factor・コードの削除の失敗のことがあり、もう一度押してよい (残りを消す §14.7)。
 */
import { useState, type FormEvent } from 'react';
import { UNAUTHENTICATED_SCREEN_MESSAGE } from '@/lib/admin/api-error-message';
import { mfaErrorMessage, resetOperatorMfa } from '@/lib/auth/mfa/client';
import { MFA_RESET_IDENTITY_CHECKS, MFA_RESET_REASON_MAX_LENGTH } from '@/lib/auth/mfa/schemas';

type IdentityCheck = (typeof MFA_RESET_IDENTITY_CHECKS)[number];

/** 本人確認の方法の表示 (値は MFA_RESET_IDENTITY_CHECKS) */
export const MFA_RESET_IDENTITY_CHECK_LABELS: Readonly<Record<IdentityCheck, string>> = {
  video_call: 'ビデオ通話で確認',
  in_person: '対面で確認',
  id_document_shown: '身分証を見せてもらい確認 (画像は預からない)',
  other: 'その他',
};

/** 401 (Unauthorized。ログインが切れた) の HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;

/** [解除する] の後の確認ダイアログの文 (§15.3) */
const RESET_CONFIRM_MESSAGE =
  'この利用者の認証アプリとバックアップコードを消します。対象はすべての端末でログアウトされます。続けますか?';

function isIdentityCheck(value: string): value is IdentityCheck {
  return (MFA_RESET_IDENTITY_CHECKS as ReadonlyArray<string>).includes(value);
}

export function OperatorMfaResetSection({ userId }: { userId: string }) {
  const [reason, setReason] = useState('');
  const [identityCheck, setIdentityCheck] = useState<IdentityCheck | ''>('');
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = reason.trim().length > 0 && identityCheck !== '' && identityConfirmed && !submitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (!window.confirm(RESET_CONFIRM_MESSAGE)) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    const result = await resetOperatorMfa(userId, { reason, identity_check: identityCheck, identity_confirmed: true });
    if (result.ok) {
      const { factors_deleted: factorsDeleted, backup_codes_deleted: backupCodesDeleted } = result.data.data;
      setMessage(`認証アプリ ${factorsDeleted} 件・バックアップコード ${backupCodesDeleted} 件を消しました`);
    } else {
      // 401 は code (reset の route は UNAUTHORIZED) から引いた利用者の画面の言い回しではなく、運営の画面で揃えた文 (#2112 Z4)
      setError(result.status === HTTP_UNAUTHORIZED ? UNAUTHENTICATED_SCREEN_MESSAGE : mfaErrorMessage(result.code));
    }
    setSubmitting(false);
  };

  return (
    <section data-testid="operator-mfa-reset" className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">二段階認証を解除</h2>
      <p className="text-sm text-gray-600 mb-4">
        認証アプリとバックアップコードを失った運営の方の二段階認証を解除します。対象はすべての端末でログアウトされ、次のログインで認証アプリを登録し直します。
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="operator-mfa-reset-reason" className="block text-sm font-medium text-gray-700 mb-1">
            理由
          </label>
          <textarea
            id="operator-mfa-reset-reason"
            data-testid="operator-mfa-reset-reason"
            required
            maxLength={MFA_RESET_REASON_MAX_LENGTH}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            rows={3}
          />
        </div>
        <div>
          <label htmlFor="operator-mfa-reset-identity-check" className="block text-sm font-medium text-gray-700 mb-1">
            本人確認の方法
          </label>
          <select
            id="operator-mfa-reset-identity-check"
            data-testid="operator-mfa-reset-identity-check"
            value={identityCheck}
            onChange={(event) => setIdentityCheck(isIdentityCheck(event.target.value) ? event.target.value : '')}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="">選択してください</option>
            {MFA_RESET_IDENTITY_CHECKS.map((value) => (
              <option key={value} value={value}>
                {MFA_RESET_IDENTITY_CHECK_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            data-testid="operator-mfa-reset-identity-confirmed"
            checked={identityConfirmed}
            onChange={(event) => setIdentityConfirmed(event.target.checked)}
          />
          本人確認を行った
        </label>
        {message ? (
          <p data-testid="operator-mfa-reset-result" role="status" className="text-sm text-green-700">
            {message}
          </p>
        ) : null}
        {error ? (
          <p data-testid="operator-mfa-reset-error" role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          data-testid="operator-mfa-reset-submit"
          disabled={!canSubmit}
          className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? '解除中…' : '解除する'}
        </button>
      </form>
    </section>
  );
}
