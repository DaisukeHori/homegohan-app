'use client';

/**
 * 認証アプリの 6 桁の入力と送信 (#1176。docs/design/cross/12-operator-mfa.md §15.3)
 *
 * setup (登録) と verify (確認) の画面が使う。POST /api/auth/mfa/verify は src/lib/auth/mfa/client.ts の verifyMfaCode だけで呼ぶ。
 * 401 はセッション切れなのでログインへ (§15.2 の共通の規則)。それ以外の失敗は欄を空にして文言を出す。
 */
import { useState, type FormEvent } from 'react';
import { mfaErrorMessage, verifyMfaCode } from '@/lib/auth/mfa/client';
import { TOTP_CODE_PATTERN, type MfaVerifyResponse } from '@/lib/auth/mfa/schemas';

/** 6 桁の欄の長さ (TOTP_CODE_PATTERN の桁数) */
const TOTP_CODE_INPUT_MAX_LENGTH = 6;
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;

export function TotpCodeForm({
  factorId,
  onVerified,
}: {
  factorId: string;
  onVerified: (data: MfaVerifyResponse) => void;
}) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = TOTP_CODE_PATTERN.test(code) && !submitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await verifyMfaCode({ factor_id: factorId, code });
    if (result.ok) {
      setSubmitting(false);
      onVerified(result.data);
      return;
    }
    if (result.status === HTTP_UNAUTHORIZED) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    setCode('');
    setError(mfaErrorMessage(result.code));
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label htmlFor="totp-code" className="block text-sm font-bold text-gray-700">
        認証アプリの 6 桁のコード
      </label>
      <input
        id="totp-code"
        data-testid="totp-code-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={TOTP_CODE_INPUT_MAX_LENGTH}
        value={code}
        onChange={(event) => setCode(event.target.value.trim())}
        className="w-full h-12 rounded-xl border border-gray-200 px-4 text-lg tracking-widest"
      />
      {error ? (
        <p data-testid="totp-code-error" role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="totp-code-submit"
        disabled={!canSubmit}
        className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? '確認中…' : '確認'}
      </button>
    </form>
  );
}
