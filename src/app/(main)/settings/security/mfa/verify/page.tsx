'use client';

/**
 * /settings/security/mfa/verify?next= — ログインごとの 6 桁の確認 (challenge) (#1176。docs/design/cross/12-operator-mfa.md §15・§15.2)
 *
 * GET status → aal2 なら next へ・未登録なら setup へ・それ以外は 6 桁 (TotpCodeForm) → POST verify → next。
 * 認証アプリが使えないときは recover (バックアップコード) へ。
 * アプリの WebView の中では 6 桁の欄を出さず、Web の API も呼ばずに、ネイティブの確認画面に頼む (NativeAppMfaNotice kind=verify。§16.4)。
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { getMfaStatus, mfaErrorMessage } from '@/lib/auth/mfa/client';
import { NativeAppMfaNotice } from '@/components/auth/mfa/NativeAppMfaNotice';
import { TotpCodeForm } from '@/components/auth/mfa/TotpCodeForm';
import { useInNativeWebView } from '@/components/auth/mfa/useInNativeWebView';

/** 登録の画面 (未登録のときの行き先。next を引き継ぐ) */
const MFA_SETUP_PATH = '/settings/security/mfa/setup';
/** 回復の画面 (バックアップコード) */
const MFA_RECOVER_PATH = '/settings/security/mfa/recover';
/** next が無い・安全でないときの行き先 (§15 冒頭) */
const DEFAULT_NEXT_PATH = '/admin';
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;

type VerifyView = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'challenge'; factorId: string };

function MfaVerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = getSafeRedirectPath(searchParams.get('next')) ?? DEFAULT_NEXT_PATH;
  const [view, setView] = useState<VerifyView>({ kind: 'loading' });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const result = await getMfaStatus();
      if (!result.ok) {
        if (result.status === HTTP_UNAUTHORIZED) {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        setView({ kind: 'error', message: mfaErrorMessage(result.code) });
        return;
      }
      if (result.data.aal === 'aal2') {
        router.replace(next);
        return;
      }
      if (result.data.factor === null) {
        router.replace(`${MFA_SETUP_PATH}?next=${encodeURIComponent(next)}`);
        return;
      }
      setView({ kind: 'challenge', factorId: result.data.factor.id });
    })();
  }, [router, next]);

  if (view.kind === 'loading') return <p className="text-sm text-gray-500">読み込み中…</p>;
  if (view.kind === 'error') {
    return (
      <p data-testid="mfa-verify-error" role="alert" className="text-sm text-red-600">
        {view.message}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700">運営の画面を開くには、認証アプリに出ている 6 桁のコードを入力してください。</p>
      <TotpCodeForm
        factorId={view.factorId}
        onVerified={() => {
          router.push(next);
          router.refresh();
        }}
      />
      <Link href={MFA_RECOVER_PATH} data-testid="mfa-verify-recover-link" className="block text-sm text-[#E07A5F] underline">
        認証アプリが使えない (バックアップコード)
      </Link>
    </div>
  );
}

function MfaVerifyPageBody() {
  const place = useInNativeWebView();
  if (place === 'undecided') return null;
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white p-6 pb-4 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900">二段階認証の確認</h1>
      </div>
      <div className="p-6">
        {place === 'in_app' ? (
          <NativeAppMfaNotice kind="verify" />
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-6">
            <MfaVerifyContent />
          </div>
        )}
      </div>
    </div>
  );
}

export default function MfaVerifyPage() {
  // useSearchParams を使うため Suspense で包む
  return (
    <Suspense>
      <MfaVerifyPageBody />
    </Suspense>
  );
}
