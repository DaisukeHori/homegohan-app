'use client';

/**
 * /settings/security/mfa — 運営ロールの二段階認証 (TOTP) の状態 (#1176。docs/design/cross/12-operator-mfa.md §15・§15.2)
 *
 * 段 A: 状態の表示だけ (登録済み: 登録日・残りのバックアップコードの数 / 未登録: [登録する])。
 * [バックアップコードを再発行]・[認証アプリを解除] は段 B で足す (AAL2 を確かめる仕組みが段 B で入るため §0.2)。
 * アプリの WebView の中では API を呼ばず、「ブラウザで」の案内だけを出す (§16.4)。
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatJstDateTime } from '@/lib/admin/format-datetime';
import { getMfaStatus, mfaErrorMessage } from '@/lib/auth/mfa/client';
import type { MfaStatusResponse } from '@/lib/auth/mfa/schemas';
import { NativeAppMfaNotice } from '@/components/auth/mfa/NativeAppMfaNotice';
import { useInNativeWebView } from '@/components/auth/mfa/useInNativeWebView';

/** 未登録のときの [登録する] の行き先 (登録の後はこの画面へ戻る) */
const SETUP_FROM_STATUS_PATH = '/settings/security/mfa/setup?next=%2Fsettings%2Fsecurity%2Fmfa';
/** セッション切れ (HTTP 401) */
const HTTP_UNAUTHORIZED = 401;

type StatusView =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MfaStatusResponse }
  | { kind: 'error'; message: string };

function MfaStatusContent() {
  const router = useRouter();
  const [view, setView] = useState<StatusView>({ kind: 'loading' });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const result = await getMfaStatus();
      if (result.ok) {
        setView({ kind: 'ready', data: result.data });
        return;
      }
      if (result.status === HTTP_UNAUTHORIZED) {
        window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      setView({ kind: 'error', message: mfaErrorMessage(result.code) });
    })();
  }, []);

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
  if (factor === null) {
    return (
      <div className="space-y-4">
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
