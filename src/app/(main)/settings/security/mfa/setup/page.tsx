'use client';

/**
 * /settings/security/mfa/setup?next= — 認証アプリ (TOTP) の登録 (#1176。docs/design/cross/12-operator-mfa.md §15・§15.2)
 *
 *   1. GET status → 登録済みなら状態の画面へ (enroll を呼ばない)。未登録なら POST enroll (最初の描画の後に 1 回だけ。
 *      useRef の印で 2 回目を止める: React の開発時の effect の 2 回の実行で factor を作り直さない)
 *   2. QR と手入力用の secret → 6 桁 (TotpCodeForm) → POST verify
 *   3. verify の成功にバックアップコードがあれば 1 回だけ表示 (BackupCodesPanel)。無ければ (コードの発行の失敗・
 *      1 回目の応答が届かず打ち直した 2 回目) 「表示できなかった」案内 (MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE)
 * アプリの WebView の中では API を呼ばず、「ブラウザで登録」の案内だけを出す (§16.4)。
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSafeRedirectPath } from '@/lib/auth/safe-redirect';
import { MFA_QR_SVG_DATA_URL_PREFIX } from '@/lib/auth/mfa/factors';
import {
  MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE,
  getMfaStatus,
  mfaErrorMessage,
  startMfaEnrollment,
} from '@/lib/auth/mfa/client';
import type { MfaEnrollResponse, MfaVerifyResponse } from '@/lib/auth/mfa/schemas';
import { BackupCodesPanel } from '@/components/auth/mfa/BackupCodesPanel';
import { NativeAppMfaNotice } from '@/components/auth/mfa/NativeAppMfaNotice';
import { TotpCodeForm } from '@/components/auth/mfa/TotpCodeForm';
import { useInNativeWebView } from '@/components/auth/mfa/useInNativeWebView';

/** 状態の画面 (登録済みのときの行き先・[二段階認証の設定へ]) */
const MFA_STATUS_PATH = '/settings/security/mfa';
/** next が無い・安全でないときの行き先 (§15 冒頭) */
const DEFAULT_NEXT_PATH = '/admin';
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;
/** 登録済みで enroll (HTTP 409 AUTH_2FA_ALREADY_ENROLLED) */
const ALREADY_ENROLLED_CODE = 'AUTH_2FA_ALREADY_ENROLLED';

type SetupView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'enroll'; enrollment: MfaEnrollResponse }
  | { kind: 'codes'; codes: ReadonlyArray<string> }
  | { kind: 'codes_not_shown' };

function goToLogin(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- セッション切れ (401) はページごとログインへ移る (docs/design/cross/12-operator-mfa.md §15.2)
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

function MfaSetupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = getSafeRedirectPath(searchParams.get('next')) ?? DEFAULT_NEXT_PATH;
  const [view, setView] = useState<SetupView>({ kind: 'loading' });
  const [secretVisible, setSecretVisible] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const status = await getMfaStatus();
      if (!status.ok) {
        if (status.status === HTTP_UNAUTHORIZED) {
          goToLogin();
          return;
        }
        setView({ kind: 'error', message: mfaErrorMessage(status.code) });
        return;
      }
      if (status.data.enrolled) {
        router.replace(MFA_STATUS_PATH);
        return;
      }
      const enrollment = await startMfaEnrollment();
      if (enrollment.ok) {
        setView({ kind: 'enroll', enrollment: enrollment.data });
        return;
      }
      if (enrollment.status === HTTP_UNAUTHORIZED) {
        goToLogin();
        return;
      }
      if (enrollment.code === ALREADY_ENROLLED_CODE) {
        router.replace(MFA_STATUS_PATH);
        return;
      }
      setView({ kind: 'error', message: mfaErrorMessage(enrollment.code) });
    })();
  }, [router]);

  const goNext = () => {
    router.push(next);
    router.refresh();
  };

  const handleVerified = (data: MfaVerifyResponse) => {
    if (data.backup_codes && data.backup_codes.length > 0) {
      setView({ kind: 'codes', codes: data.backup_codes });
      return;
    }
    setView({ kind: 'codes_not_shown' });
  };

  switch (view.kind) {
    case 'loading':
      return <p className="text-sm text-gray-500">読み込んでいます…</p>;
    case 'error':
      return (
        <p data-testid="mfa-setup-error" role="alert" className="text-sm text-red-600">
          {view.message}
        </p>
      );
    case 'codes':
      return <BackupCodesPanel codes={view.codes} onDone={goNext} />;
    case 'codes_not_shown':
      return (
        <div className="space-y-4">
          <p data-testid="backup-codes-not-shown" className="text-sm text-gray-700">
            {MFA_BACKUP_CODES_NOT_SHOWN_MESSAGE}
          </p>
          <button
            type="button"
            data-testid="backup-codes-not-shown-settings"
            onClick={() => {
              router.push(MFA_STATUS_PATH);
              router.refresh();
            }}
            className="w-full py-3 rounded-xl font-bold text-[#E07A5F] border border-[#E07A5F] hover:bg-orange-50 transition-colors"
          >
            二段階認証の設定へ
          </button>
          <button
            type="button"
            data-testid="backup-codes-not-shown-continue"
            onClick={goNext}
            className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors"
          >
            続ける
          </button>
        </div>
      );
    case 'enroll': {
      const { enrollment } = view;
      return (
        <div className="space-y-6">
          <ol className="list-decimal pl-5 space-y-1 text-sm text-gray-700">
            <li>認証アプリ (Google Authenticator など) で、下の QR コードを読み取ってください。</li>
            <li>読み取れないときは、下のキーを認証アプリに手で入力してください。</li>
            <li>認証アプリに出た 6 桁のコードを入力してください。</li>
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element -- Supabase が返す SVG を data URL にして出す (最適化の対象外)。前置きは 1 回だけ (qr_code_svg は素の SVG) */}
          <img
            data-testid="mfa-setup-qr"
            src={`${MFA_QR_SVG_DATA_URL_PREFIX}${enrollment.qr_code_svg}`}
            alt="認証アプリで読み取る QR コード"
            className="mx-auto h-48 w-48"
          />
          <div className="space-y-2">
            <label htmlFor="mfa-setup-secret" className="block text-sm font-bold text-gray-700">
              手入力用のキー
            </label>
            <div className="flex gap-2">
              <input
                id="mfa-setup-secret"
                data-testid="mfa-setup-secret"
                type={secretVisible ? 'text' : 'password'}
                readOnly
                value={enrollment.secret}
                className="flex-1 h-12 rounded-xl border border-gray-200 px-4 font-mono text-sm"
              />
              <button
                type="button"
                data-testid="mfa-setup-secret-toggle"
                onClick={() => setSecretVisible((visible) => !visible)}
                className="px-4 rounded-xl border border-gray-200 text-sm font-bold text-gray-700 hover:bg-gray-50"
              >
                {secretVisible ? '隠す' : '表示'}
              </button>
            </div>
          </div>
          <TotpCodeForm factorId={enrollment.factor_id} onVerified={handleVerified} />
        </div>
      );
    }
  }
}

function MfaSetupPageBody() {
  const place = useInNativeWebView();
  if (place === 'undecided') return null;
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white p-6 pb-4 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900">二段階認証の登録</h1>
      </div>
      <div className="p-6">
        {place === 'in_app' ? (
          <NativeAppMfaNotice kind="browser_only" />
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-6">
            <MfaSetupContent />
          </div>
        )}
      </div>
    </div>
  );
}

export default function MfaSetupPage() {
  // useSearchParams を使うため Suspense で包む
  return (
    <Suspense>
      <MfaSetupPageBody />
    </Suspense>
  );
}
