"use client";

// src/app/(main)/settings/security/sessions/page.tsx
// #1189・#1190: ログイン中の端末の一覧と個別の失効・他の端末のログアウト・最近のログイン。
// 設計の正典 docs/design/cross/16-auth-history-sessions.md §15。
//
// - 端末の見出しは device_label (UA から決まる言葉)。アプリが登録した端末名 (device_name) は「端末名: …」として添えるだけで、
//   見出しの代わりにしない (端末名はセッションを持つ誰でも書けるので、人を欺く見出しにさせない §7.1)。
// - この端末 (is_current) には解除のボタンを出さない (ログアウトは設定の「ログアウト」を使う)。
// - 通信は src/lib/auth/sessions/client.ts だけ (例外を投げず、結果で分ける)。401 は未ログインの案内、そのほかの失敗は読み込み失敗の案内。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ChevronLeft } from "lucide-react";
import {
  listLoginHistory,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  type SessionsClientResult,
} from "@/lib/auth/sessions/client";
import type { LoginHistoryEntry, SessionSummary } from "@/lib/auth/sessions/schemas";

/** 未ログイン (セッション切れ) の HTTP ステータス */
const HTTP_UNAUTHORIZED = 401;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DISPLAY_TIME_ZONE = "Asia/Tokyo";
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 終了の理由の言葉 (§15) */
const ENDED_REASON_LABELS: Record<NonNullable<LoginHistoryEntry["ended_reason"]>, string> = {
  signed_out: "ログアウト",
  revoked_by_user: "この一覧から解除",
  idle_expired: "使われずに期限切れ",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "signed-out" }
  | { kind: "ready"; sessions: SessionSummary[]; history: LoginHistoryEntry[] };

function formatDateTime(iso: string): string {
  return DATE_TIME_FORMAT.format(new Date(iso));
}

/** 「最後の利用」の文: 1 時間以内は「n 分前」、1 日以内は「n 時間前」、それより前は日時 */
function formatLastActive(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_MINUTE));
  if (minutes < MINUTES_PER_HOUR) return `${minutes} 分前`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} 時間前`;
  return formatDateTime(iso);
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-600">
      <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

function SessionCard({
  session,
  busy,
  onRevoke,
}: {
  session: SessionSummary;
  busy: boolean;
  onRevoke: (session: SessionSummary) => void;
}) {
  const now = new Date();
  return (
    <li className="p-4 space-y-1" data-testid="sessions-item">
      <div className="flex items-center justify-between gap-3">
        <span className="font-bold text-gray-800" data-testid="sessions-item-label">
          {session.device_label}
        </span>
        {session.is_current ? (
          <span
            className="text-xs font-bold text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5"
            data-testid="sessions-current-badge"
          >
            この端末
          </span>
        ) : null}
      </div>
      {session.device_name ? (
        <p className="text-xs text-gray-500" data-testid="sessions-item-device-name">
          端末名: {session.device_name}
        </p>
      ) : null}
      <p className="text-xs text-gray-500">
        {session.ip_address ? `IP: ${session.ip_address}` : "IP: 不明"}
        {session.country_code ? ` ・ 国: ${session.country_code}` : ""}
      </p>
      <p className="text-xs text-gray-500">
        最後の利用: {formatLastActive(session.last_active_at, now)} ・ ログインした日時: {formatDateTime(session.created_at)}
      </p>
      {session.is_current ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRevoke(session)}
          className="mt-2 text-sm font-bold text-red-600 hover:underline disabled:opacity-50"
          data-testid="sessions-revoke-button"
        >
          この端末をログアウトさせる
        </button>
      )}
    </li>
  );
}

function HistoryRow({ entry }: { entry: LoginHistoryEntry }) {
  const marks = [
    entry.is_new_device ? "新しい端末" : null,
    entry.is_new_country ? "新しい地域" : null,
    entry.is_new_ip ? "新しい接続元" : null,
  ].filter((mark): mark is string => mark !== null);
  return (
    <li className="p-4 space-y-1" data-testid="login-history-item">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold text-gray-800">{formatDateTime(entry.created_at)}</span>
        {entry.ended_reason ? (
          <span className="text-xs text-gray-500">{ENDED_REASON_LABELS[entry.ended_reason]}</span>
        ) : null}
      </div>
      <p className="text-xs text-gray-600">
        {entry.device_label}
        {entry.device_name ? ` (端末名: ${entry.device_name})` : ""}
      </p>
      <p className="text-xs text-gray-500">
        {entry.ip_address ? `IP: ${entry.ip_address}` : "IP: 不明"}
        {entry.country_code ? ` ・ 国: ${entry.country_code}` : ""}
      </p>
      {marks.length > 0 ? (
        <p className="flex flex-wrap gap-1" data-testid="login-history-marks">
          {marks.map((mark) => (
            <span
              key={mark}
              className={
                mark === "新しい接続元"
                  ? "text-[11px] text-gray-500 bg-gray-50 rounded px-1.5 py-0.5"
                  : "text-[11px] font-bold text-amber-700 bg-amber-50 rounded px-1.5 py-0.5"
              }
            >
              {mark}
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

function stateOfFailure<T>(result: Extract<SessionsClientResult<T>, { ok: false }>): LoadState {
  return result.status === HTTP_UNAUTHORIZED ? { kind: "signed-out" } : { kind: "error" };
}

export default function SessionsSettingsPage() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // 読み込みに失敗したときの「もう一度読み込む」用
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    const run = async () => {
      const [sessions, history] = await Promise.all([listSessions(), listLoginHistory()]);
      if (cancelled) return;
      if (!sessions.ok) {
        setLoad(stateOfFailure(sessions));
        return;
      }
      if (!history.ok) {
        setLoad(stateOfFailure(history));
        return;
      }
      setLoad({ kind: "ready", sessions: sessions.data, history: history.data });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const onRevoke = useCallback(async (session: SessionSummary) => {
    if (!window.confirm(`「${session.device_label}」をログアウトさせますか？`)) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const result = await revokeSession(session.session_id);
    setBusy(false);
    if (!result.ok) {
      if (result.status === HTTP_UNAUTHORIZED) {
        setLoad({ kind: "signed-out" });
        return;
      }
      setActionError(result.error.message);
      return;
    }
    setNotice("その端末をログアウトさせました。");
    setLoad((current) =>
      current.kind === "ready"
        ? { ...current, sessions: current.sessions.filter((s) => s.session_id !== session.session_id) }
        : current,
    );
  }, []);

  const onRevokeOthers = useCallback(async () => {
    if (!window.confirm("この端末以外のログインをすべてログアウトさせますか？")) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const result = await revokeOtherSessions();
    setBusy(false);
    if (!result.ok) {
      if (result.status === HTTP_UNAUTHORIZED) {
        setLoad({ kind: "signed-out" });
        return;
      }
      setActionError(result.error.message);
      return;
    }
    setNotice("この端末以外のログインをすべてログアウトさせました。");
    setAttempt((n) => n + 1);
  }, []);

  const hasOtherSessions = load.kind === "ready" && load.sessions.some((s) => !s.is_current);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="sticky top-0 z-20 bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3">
        <Link href="/settings" aria-label="設定に戻る" className="p-1.5 rounded-full text-gray-700 hover:bg-gray-100">
          <ChevronLeft size={20} aria-hidden="true" />
        </Link>
        <h1 className="text-lg font-bold text-gray-900">ログイン中の端末</h1>
      </div>

      <div className="px-4 py-6 space-y-6 max-w-2xl mx-auto">
        {load.kind === "loading" && (
          <div className="flex justify-center py-12" role="status" aria-label="読み込み中">
            <div className="w-6 h-6 border-2 border-[#E07A5F] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {load.kind === "error" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3" data-testid="sessions-load-error">
            <ErrorBanner message="ログイン中の端末を読み込めませんでした。通信の状態を確認して、もう一度お試しください。" />
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="w-full py-3 rounded-xl font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
            >
              もう一度読み込む
            </button>
          </div>
        )}

        {load.kind === "signed-out" && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 space-y-3" data-testid="sessions-signed-out">
            <p className="text-sm text-gray-600">ログインの有効期限が切れています。もう一度ログインしてください。</p>
            <Link
              href="/login?next=%2Fsettings%2Fsecurity%2Fsessions"
              className="block w-full py-3 rounded-xl font-bold text-white bg-[#E07A5F] hover:bg-[#D16A4F] transition-colors text-center"
            >
              ログイン画面へ
            </Link>
          </div>
        )}

        {load.kind === "ready" && (
          <>
            {notice ? (
              <p role="status" className="text-sm text-emerald-700 bg-emerald-50 rounded-xl p-3" data-testid="sessions-notice">
                {notice}
              </p>
            ) : null}
            {actionError ? <ErrorBanner message={actionError} /> : null}

            <section aria-labelledby="sessions-heading" className="space-y-3">
              <h2 id="sessions-heading" className="text-sm font-bold text-gray-700">
                ログイン中の端末
              </h2>
              <ul className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50" data-testid="sessions-list">
                {load.sessions.map((session) => (
                  <SessionCard key={session.session_id} session={session} busy={busy} onRevoke={onRevoke} />
                ))}
              </ul>
              {hasOtherSessions ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onRevokeOthers}
                  className="w-full py-3 rounded-xl font-bold text-red-600 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 transition-colors"
                  data-testid="sessions-revoke-others-button"
                >
                  他の端末をすべてログアウト
                </button>
              ) : null}
            </section>

            <section aria-labelledby="login-history-heading" className="space-y-3">
              <h2 id="login-history-heading" className="text-sm font-bold text-gray-700">
                最近のログイン
              </h2>
              {load.history.length === 0 ? (
                <p className="text-sm text-gray-500">記録はまだありません。</p>
              ) : (
                <ul className="bg-white rounded-2xl shadow-sm border border-gray-100 divide-y divide-gray-50" data-testid="login-history-list">
                  {load.history.map((entry) => (
                    <HistoryRow key={entry.session_id} entry={entry} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
