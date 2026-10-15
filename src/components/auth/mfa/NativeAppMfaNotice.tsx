'use client';

/**
 * アプリの WebView の中で MFA の画面を開いたときの案内 (#1176。docs/design/cross/12-operator-mfa.md §16.4.3)
 *
 * WebView の Cookie のセッションはネイティブのセッションの借り物で、token を発行し直す持ち主はネイティブだけ (#1038 F7-05)。
 * そのため WebView の中では Web の MFA の API を 1 つも呼ばない:
 *   kind='verify'       : 6 桁の確認をネイティブの確認画面に頼む ({ type: 'mfa-verify-required' } を描画の後に 1 回送る)
 *   kind='browser_only' : 登録・回復・設定はブラウザ (アプリの外) で行うよう案内するだけ
 */
import { useEffect } from 'react';
import { requestNativeMfaVerify } from '@/lib/native-auth-bridge';

export const NATIVE_APP_MFA_VERIFY_NOTICE =
  'アプリの中では、この画面で確認コードを入力できません。開いた確認画面で、認証アプリの 6 桁を入力してください。';
export const NATIVE_APP_MFA_FALLBACK_NOTICE =
  '確認画面が開かないときは、アプリを最新版に更新するか、ブラウザ (Safari・Chrome・パソコンなど) で開いてください。';
export const NATIVE_APP_MFA_BROWSER_ONLY_NOTICE =
  '二段階認証の登録・回復・設定は、アプリの中ではできません。ブラウザ (Safari・Chrome・パソコンなど) で、ほめゴハンの「設定 → セキュリティ (二段階認証)」を開いてください。';

export function NativeAppMfaNotice({ kind }: { kind: 'verify' | 'browser_only' }) {
  useEffect(() => {
    if (kind === 'verify') requestNativeMfaVerify();
  }, [kind]);

  return (
    <div data-testid="native-app-mfa-notice" className="rounded-2xl border border-gray-100 bg-white p-6 space-y-4">
      {kind === 'verify' ? (
        <>
          <p className="text-sm text-gray-700">{NATIVE_APP_MFA_VERIFY_NOTICE}</p>
          <p className="text-xs text-gray-500">{NATIVE_APP_MFA_FALLBACK_NOTICE}</p>
          <button
            type="button"
            data-testid="native-app-mfa-open-verify"
            onClick={() => requestNativeMfaVerify()}
            className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors"
          >
            確認画面を開く
          </button>
        </>
      ) : (
        <p className="text-sm text-gray-700">{NATIVE_APP_MFA_BROWSER_ONLY_NOTICE}</p>
      )}
    </div>
  );
}
