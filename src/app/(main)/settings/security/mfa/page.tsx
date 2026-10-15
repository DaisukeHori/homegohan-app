'use client';

/**
 * /settings/security/mfa — 運営ロールの二段階認証 (TOTP) の状態 (#1176。docs/design/cross/12-operator-mfa.md §15・§15.2)
 *
 * 段 A: 状態の表示 (登録済み: 登録日・残りのバックアップコードの数 / 未登録: [登録する])。
 * 段 B: 登録済みのとき [バックアップコードを再発行]・[認証アプリを解除] (どちらも AAL2 が要る。403 AUTH_2FA_REQUIRED なら
 * verify へ next=/settings/security/mfa で回す。500 などの失敗は文を出し、getMfaStatus を呼び直して今の状態を出し直す §15.2)。
 * アプリの WebView の中では API を呼ばず、「ブラウザで」の案内だけを出す (§16.4)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import {
  getMfaStatus,
  mfaErrorMessage,
  regenerateBackupCodes,
  unenrollMfaFactor,
  type MfaClientFailure,
} from '@/lib/auth/mfa/client';
import type { MfaStatusResponse } from '@/lib/auth/mfa/schemas';
import { BackupCodesPanel } from '@/components/auth/mfa/BackupCodesPanel';
import { NativeAppMfaNotice } from '@/components/auth/mfa/NativeAppMfaNotice';
import { useInNativeWebView } from '@/components/auth/mfa/useInNativeWebView';

/** 未登録のときの [登録する] の行き先 (登録の後はこの画面へ戻る) */
const SETUP_FROM_STATUS_PATH = '/settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa';
/** AAL2 が要る操作で aal1 のとき (403 AUTH_2FA_REQUIRED) の行き先 (確認の後にこの画面へ戻る) */
const VERIFY_FROM_STATUS_PATH = '/settings/security/mfa/verify?next=%2Fsettings%2Fsecurity%2Fmfa';
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;
/** AAL2 が要る操作を aal1 で呼んだ (HTTP 403 + AUTH_2FA_REQUIRED) */
const HTTP_FORBIDDEN = 403;
/** 再発行の確認の文 */
const REGENERATE_CONFIRM_MESSAGE = 'バックアップコードを発行し直します。今のコードはすべて使えなくなります。続けますか?';
/** 解除の確認の文 */
const UNENROLL_CONFIRM_MESSAGE =
  '認証アプリの登録を解除します。バックアップコードもすべて使えなくなります。解除の後は、運営の画面に入る前にもう一度登録が必要です。続けますか?';

/** セッション切れ (401) ならログインへ移る (§15.2 の共通の規則) */
function goToLoginForCurrentPage(): void {
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

type StatusView =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MfaStatusResponse }
  | { kind: 'error'; message: string };

function MfaStatusContent() {
  const router = useRouter();
  const [view, setView] = useState<StatusView>({ kind: 'loading' });
  /** 再発行で受け取ったコード (BackupCodesPanel で 1 回だけ出す。state にだけ持つ) */
  const [issuedCodes, setIssuedCodes] = useState<ReadonlyArray<string> | null>(null);
  /** 再発行・解除の失敗の文 (状態の表示は getMfaStatus の呼び直しで今のものに直す) */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 再発行・解除の送信中 (二重に送らない) */
  const [busy, setBusy] = useState(false);
  const startedRef = useRef(false);

  const loadStatus = useCallback(async () => {
    const result = await getMfaStatus();
    if (result.ok) {
      setView({ kind: 'ready', data: result.data });
      return;
    }
    if (result.status === HTTP_UNAUTHORIZED) {
      goToLoginForCurrentPage();
      return;
    }
    setView({ kind: 'error', message: mfaErrorMessage(result.code) });
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loadStatus();
  }, [loadStatus]);

  /** 再発行・解除の失敗 (§15.2 の表の段 B の 2 行): 401 はログイン・403 AUTH_2FA_REQUIRED は verify・それ以外は文 + 状態の呼び直し */
  const handleActionFailure = async (failure: MfaClientFailure) => {
    if (failure.status === HTTP_UNAUTHORIZED) {
      goToLoginForCurrentPage();
      return;
    }
    if (failure.status === HTTP_FORBIDDEN && failure.code === 'AUTH_2FA_REQUIRED') {
      router.push(VERIFY_FROM_STATUS_PATH);
      return;
    }
    setActionError(mfaErrorMessage(failure.code));
    await loadStatus();
  };

  const handleRegenerate = async () => {
    if (busy || !window.confirm(REGENERATE_CONFIRM_MESSAGE)) return;
    setBusy(true);
    setActionError(null);
    const result = await regenerateBackupCodes();
    setBusy(false);
    if (result.ok) {
      setIssuedCodes(result.data.backup_codes);
      return;
    }
    await handleActionFailure(result);
  };

  const handleUnenroll = async (factorId: string) => {
    if (busy || !window.confirm(UNENROLL_CONFIRM_MESSAGE)) return;
    setBusy(true);
    setActionError(null);
    const result = await unenrollMfaFactor(factorId);
    setBusy(false);
    if (result.ok) {
      // 応答の aal によらず (refresh に失敗すると 'aal2' §14.4) 登録の画面へ続ける (S-9)
      router.push(SETUP_FROM_STATUS_PATH);
      router.refresh();
      return;
    }
    await handleActionFailure(result);
  };

  if (issuedCodes !== null) {
    return (
      <BackupCodesPanel
        codes={issuedCodes}
        onDone={() => {
          setIssuedCodes(null);
          void loadStatus();
        }}
      />
    );
  }
  if (view.kind === 'loading') {
    return <p className="text-sm text-gray-500">読み込み中…</p>;
  }
  if (view.kind === 'error') {
    return (
      <p data-testid="mfa-status-error" role="alert" className="text-sm text-red-600">
        {view.message}
      </p>
    );
  }
  const { factor, backup_codes_remaining: backupCodesRemaining } = view.data;
  const actionErrorView = actionError ? (
    <p data-testid="mfa-status-action-error" role="alert" className="text-sm text-red-600">
      {actionError}
    </p>
  ) : null;
  if (factor === null) {
    return (
      <div className="space-y-4">
        {actionErrorView}
        <p className="text-sm text-gray-700">認証アプリはまだ登録されていません。</p>
        <button
          type="button"
          data-testid="mfa-status-enroll"
          onClick={() => router.push(SETUP_FROM_STATUS_PATH)}
          className="w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors"
        >
          登録する
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {actionErrorView}
      <dl data-testid="mfa-status-enrolled" className="space-y-2 text-sm text-gray-700">
        <div className="flex justify-between">
          <dt>認証アプリの登録日</dt>
          <dd>{formatJstDateTime(factor.created_at)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>残りのバックアップコード</dt>
          <dd data-testid="mfa-status-backup-codes-remaining">{backupCodesRemaining} 個</dd>
        </div>
      </dl>
      <button
        type="button"
        data-testid="mfa-status-regenerate"
        disabled={busy}
        onClick={() => void handleRegenerate()}
        className="w-full py-3 rounded-xl font-bold text-gray-800 bg-gray-100 hover:bg-gray-200 transition-colors disabled:opacity-50"
      >
        バックアップコードを再発行
      </button>
      <button
        type="button"
        data-testid="mfa-status-unenroll"
        disabled={busy}
        onClick={() => void handleUnenroll(factor.id)}
        className="w-full py-3 rounded-xl font-bold text-red-700 bg-red-50 hover:bg-red-100 transition-colors disabled:opacity-50"
      >
        認証アプリを解除
      </button>
    </div>
  );
}

export default function MfaStatusPage() {
  const place = useInNativeWebView();
  if (place === 'undecided') return null;
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white p-6 pb-4 border-b border-gray-100">
        <h1 className="text-2xl font-bold text-gray-900">二段階認証</h1>
      </div>
      <div className="p-6">
        {place === 'in_app' ? (
          <NativeAppMfaNotice kind="browser_only" />
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-6">
            <MfaStatusContent />
          </div>
        )}
      </div>
    </div>
  );
}
