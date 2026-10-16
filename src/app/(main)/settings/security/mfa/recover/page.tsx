'use client';

/**
 * /settings/security/mfa/recover — バックアップコードで回復する (#1176。docs/design/cross/12-operator-mfa.md §15・§15.2)
 *
 * 回復すると、認証アプリ (TOTP) と残りのバックアップコードが全部消え、Supabase が全端末のセッションを終える。
 * 成功したら応答の next (ログイン → 登録) へページごと移る。
 * アプリの WebView の中では API を呼ばず、「ブラウザで」の案内だけを出す (§16.4)。
 */
import { useState, type FormEvent } from 'react';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { mfaErrorMessage, recoverWithBackupCode } from '@/lib/auth/mfa/client';
import { BACKUP_CODE_INPUT_MAX_LENGTH } from '@/lib/auth/mfa/schemas';
import { NativeAppMfaNotice } from '@/components/auth/mfa/NativeAppMfaNotice';
import { useInNativeWebView } from '@/components/auth/mfa/useInNativeWebView';

/** 応答の next を使えないときの行き先 (セッションは終わっているのでログインへ) */
const RECOVER_FALLBACK_PATH = '/login';
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;

function MfaRecoverForm() {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || code.trim() === '') return;
    setSubmitting(true);
    setError(null);
    const result = await recoverWithBackupCode({ code: code.trim() });
    if (result.ok) {
      window.location.assign(getSafeRedirectPath(result.data.next) ?? RECOVER_FALLBACK_PATH);
      return;
    }
    if (result.status === HTTP_UNAUTHORIZED) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- セッション切れ (401) はページごとログインへ移る (docs/design/cross/12-operator-mfa.md §15.2)
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    setError(mfaErrorMessage(result.code));
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-gray-700">
        バックアップコードを 1 つ入力すると、登録している認証アプリと残りのバックアップコードが全部消え、すべての端末でログアウトされます。
        もう一度ログインしてから、認証アプリを登録し直してください。
      </p>
      <label htmlFor="mfa-recover-code" className="block text-sm font-bold text-gray-700">
        バックアップコード (XXXXX-XXXXX)
      </label>
      <input
        id="mfa-recover-code"
        data-testid="mfa-recover-code-input"
        type="text"
        autoComplete="off"
        maxLength={BACKUP_CODE_INPUT_MAX_LENGTH}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className="w-full h-12 rounded-xl border border-gray-200 px-4 font-mono"
      />
      {error ? (
        <p data-testid="mfa-recover-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="mfa-recover-submit"
        disabled={submitting || code.trim() === ''}
        className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? '処理中…' : '回復する'}
      </button>
    </form>
  );
}

export default function MfaRecoverPage() {
  const place = useInNativeWebView();
  if (place === 'undecided') return null;
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white p-6 pb-4 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900">バックアップコードで回復</h1>
      </div>
      <div className="p-6">
        {place === 'in_app' ? (
          <NativeAppMfaNotice kind="browser_only" />
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-6">
            <MfaRecoverForm />
          </div>
        )}
      </div>
    </div>
  );
}
