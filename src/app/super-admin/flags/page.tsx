"use client";

/**
 * /super-admin/flags — 機能フラグの一覧
 *
 * 切り替え・削除の通信そのものが失敗した (fetch が reject した) ときは、サーバーが変更を済ませてから応答が切れたこともあるので、
 * 一覧を読み直して今の値を見せ、「「<フラグ>」の切り替え (削除) の応答を受け取れませんでした」の文を一覧の上に出す
 * (alert にしない。#2073)。読み直さないと、ON にできていても OFF のまま・消せていても行が残ったまま見える。
 * そのあとの読み直しが失敗したら「再試行」を出し、読み直せるまで切り替えと削除を止める (一覧の値が古いかもしれないため)。
 * 読み直しが 401 / 403 で断られたら、読み込み直しても変わらないので、理由の文 (401 は「ログインし直してください」・
 * 403 は二段階認証の確認が要る などの理由の文か「権限がありません」) を出し、「再試行」は出さず、切り替えと削除も止めない
 * (A/B テストの一覧などと同じ分け方。#2093 W6)。
 */

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  adminActionHttpFailedMessage,
  adminLoadFailedFallback,
  adminScreenErrorOfResponse,
  displayableAdminError,
  fetchAdminRows,
} from "@/lib/admin/admin-screen-messages";
import { rereadUnavailableMessage } from "@/lib/super-admin/detail-reread";
import {
  NO_RESPONSE_LIST_RELOADED_GUIDE,
  NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE,
  statusChangeNoResponseMessage,
} from "@/lib/super-admin/status-change-no-response";

interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  rollout_strategy: { type: string; value?: number } | null;
  constraints: Record<string, unknown> | null;
  /** 今 ON になっているユーザー数 (#1148)。ユーザーが多すぎる・集計に失敗したときは null */
  active_user_count: number | null;
  updated_at: string;
}

/** 読み込みの失敗の文の対象 (「機能フラグを読み込めませんでした (HTTP 502)」。#2086 V6) */
const FLAGS_SUBJECT = "機能フラグ";

/** 書き込みの操作の名前 (通信が reject されたときの文に使う。#2073) */
type FlagWriteOperation = "切り替え" | "削除";

/**
 * 一覧の読み直しの結果 (#2073・#2093 W6)。
 *   - loaded     : 読み直せた
 *   - failed     : 読み直せなかった (500・通信の reject・本文が読めない)。「再試行」を出し、切り替えと削除を止める
 *   - unavailable: 401 / 403 で断られた。読み込み直しても変わらないので、理由の文 (message) を出し、「再試行」は出さず、止めない
 */
type FlagsReloadOutcome = { kind: "loaded" } | { kind: "failed" } | { kind: "unavailable"; message: string };

/** 書き込みの通信が reject されたあとの一覧の読み直しについての文 (#2073)。reload は読み直しの結果 */
interface NoResponseNotice {
  key: string;
  operation: FlagWriteOperation;
  reload: FlagsReloadOutcome;
}

function noResponseNoticeText(notice: NoResponseNotice): string {
  const guide =
    notice.reload.kind === "loaded"
      ? NO_RESPONSE_LIST_RELOADED_GUIDE
      : notice.reload.kind === "failed"
        ? NO_RESPONSE_LIST_RELOAD_FAILED_GUIDE
        : notice.reload.message;
  return statusChangeNoResponseMessage(`「${notice.key}」の${notice.operation}`, guide);
}

export default function FlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  // 削除の応答を待っているフラグの key。待つあいだは削除のボタンを止める
  // (二度押しで 2 本目の DELETE を送ると、削除できているのに断られて失敗の文が出るため。#2050)
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  // 切り替えか削除のどちらかの書き込み (切り替えはそのあとの一覧の読み直しまで) の応答を待っているか (10/26 の整合ゲート 1026e。#2050)。
  // 切り替えのあとの読み直しは一覧を丸ごと差し替えるので、ほかの切り替え・削除と重ねると、応答が送った順と逆に届いたとき、
  // 後に届いた古い一覧 (例: 後から切り替えたフラグが前の値の一覧・消したフラグがまだある一覧) で表示が上書きされる
  // (#2053 のクーポン・機能パッケージと同じ型)。待つあいだはすべての切り替えと削除のボタンを止め、押されても送らない。
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const writeInFlightRef = useRef(false);
  // 書き込みの通信が reject されたあとの一覧の読み直しについての文 (#2073)
  const [noResponseNotice, setNoResponseNotice] = useState<NoResponseNotice | null>(null);
  // 通信の reject のあとの読み直しが失敗し、まだ読み直せていないか (#2073)。そのあいだは切り替えと削除を止める。
  // ref は描画を待たずに handler で読むための写し
  const listStaleRef = useRef(false);
  // 「再試行」の読み直しを待っているか
  const [isReloading, setIsReloading] = useState(false);
  const isWriting = toggling !== null || deletingKey !== null || isReloading;
  const listStale = noResponseNotice !== null && noResponseNotice.reload.kind === "failed";

  const fetchFlags = async () => {
    try {
      // 200 なのに本文が読めない・data が配列でない応答は、0 件と見せずに読み込めなかった文にする (#2093 W7)
      setFlags(await fetchAdminRows<FeatureFlag>("/api/super-admin/flags", FLAGS_SUBJECT));
    } catch (err) {
      // 画面に出すのは日本語の文だけ (ブラウザの英字の例外・JSON の SyntaxError の文は出さない。#2086 V6)
      setError(displayableAdminError(err, adminLoadFailedFallback(FLAGS_SUBJECT)));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchFlags();
  }, []);

  /**
   * 一覧を読み直す。読めたら一覧を今の値にして loaded を返す。読めなければ一覧は手元の値のまま failed か unavailable を返す
   * (読み直しの失敗で画面ごとエラーにしない)。401 / 403 は unavailable (理由の文つき。一覧の 404 は行の消えたことを
   * 意味しないので failed。#2093 W6)。
   * 使うところ: 切り替えのあと (対象ユーザー数 active_user_count を新しい値にする。#1148。読み直せなくても切り替えそのものは
   * 済んでいるので、結果は使わない) と、書き込みの通信が reject されたあと (#2073)
   */
  const reloadFlags = async (): Promise<FlagsReloadOutcome> => {
    try {
      const res = await fetch("/api/super-admin/flags");
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const unavailableMessage = rereadUnavailableMessage(res.status, body, null);
        return unavailableMessage === null ? { kind: "failed" } : { kind: "unavailable", message: unavailableMessage };
      }
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { kind: "failed" };
      setFlags(data as FeatureFlag[]);
      return { kind: "loaded" };
    } catch {
      return { kind: "failed" };
    }
  };

  /**
   * 書き込みの通信が reject されたあとの読み直しと文 (#2073)。
   * 読み直せなかった (failed) ときだけ、読み直せるまで切り替えと削除を止める。401 / 403 (unavailable) は読み込み直しても
   * 変わらないので止めない (#2093 W6)
   */
  const reloadAfterNoResponse = async (key: string, operation: FlagWriteOperation) => {
    const reload = await reloadFlags();
    listStaleRef.current = reload.kind === "failed";
    setNoResponseNotice({ key, operation, reload });
  };

  /** 「再試行」: 通信の reject のあとの失敗した読み直しをやり直す (#2073) */
  const retryReload = async () => {
    if (writeInFlightRef.current || !noResponseNotice) return;
    writeInFlightRef.current = true;
    setIsReloading(true);
    try {
      await reloadAfterNoResponse(noResponseNotice.key, noResponseNotice.operation);
    } finally {
      writeInFlightRef.current = false;
      setIsReloading(false);
    }
  };

  const handleToggle = async (key: string, currentEnabled: boolean) => {
    // 書き込みを待つあいだ (#2050) と、通信の reject のあとの読み直しが失敗しているあいだ (#2073) は送らない
    if (writeInFlightRef.current || listStaleRef.current) return;
    writeInFlightRef.current = true;
    setToggling(key);
    setNoResponseNotice(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/flags/${key}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !currentEnabled }),
        });
      } catch {
        // 応答を受け取れなかった (オフライン・接続が切れたなど)。切り替えが済んだかは分からないので、一覧を読み直して今の値を見せる (#2073)
        await reloadAfterNoResponse(key, "切り替え");
        return;
      }
      if (!res.ok) {
        // 本文は JSON でないこともある (プロキシの 502 の HTML など) ので読み失敗で例外にしない (#2086 V6)
        throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(`「${key}」の切り替え`, status));
      }
      setFlags((prev) => prev.map((f) => f.key === key ? { ...f, enabled: !currentEnabled } : f));
      // 読み直しの応答まで待ってからボタンを戻す (待たずに次の書き込みを送ると、この読み直しの古い一覧で上書きされうるため)
      await reloadFlags();
    } catch (err) {
      alert(displayableAdminError(err, `「${key}」の切り替えに失敗しました`));
    } finally {
      writeInFlightRef.current = false;
      setToggling(null);
    }
  };

  const handleDelete = async (key: string) => {
    // 切り替え (とその読み直し) の応答を待つあいだも送らない (writeInFlightRef)。
    // 通信の reject のあとの読み直しが失敗しているあいだも送らない (#2073)
    if (writeInFlightRef.current || listStaleRef.current) return;
    if (!confirm(`フラグ "${key}" を削除しますか？`)) return;
    writeInFlightRef.current = true;
    setDeletingKey(key);
    setNoResponseNotice(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/flags/${key}`, { method: "DELETE" });
      } catch {
        // 応答を受け取れなかった。削除が済んだかは分からないので、一覧を読み直して今の一覧を見せる (#2073)
        await reloadAfterNoResponse(key, "削除");
        return;
      }
      if (!res.ok) {
        throw await adminScreenErrorOfResponse(res, (status) => adminActionHttpFailedMessage(`「${key}」の削除`, status));
      }
      setFlags((prev) => prev.filter((f) => f.key !== key));
    } catch (err) {
      alert(displayableAdminError(err, `「${key}」の削除に失敗しました`));
    } finally {
      writeInFlightRef.current = false;
      setDeletingKey(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">機能フラグ管理</h1>
          <p className="text-slate-400 mt-1">機能の ON/OFF と段階公開を管理します</p>
        </div>
        <Link
          href="/super-admin/flags/new"
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors"
        >
          + 新規フラグ
        </Link>
      </div>

      {noResponseNotice && (
        <div className="mb-6 flex items-start justify-between gap-4 bg-amber-900/40 border border-amber-500 rounded-xl p-4 text-amber-200 text-sm">
          <p role="alert" data-testid="flags-reload-notice">
            {noResponseNoticeText(noResponseNotice)}
          </p>
          {noResponseNotice.reload.kind === "failed" && (
            <button
              type="button"
              onClick={() => void retryReload()}
              disabled={isWriting}
              className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            >
              {isReloading ? "読み込み中..." : "再試行"}
            </button>
          )}
        </div>
      )}

      {flags.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400">
          <div className="text-5xl mb-4">🚩</div>
          <p>機能フラグがありません</p>
          <Link href="/super-admin/flags/new" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
            最初のフラグを作成する
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">フラグキー</th>
                <th className="text-left px-6 py-4 font-medium">説明</th>
                <th className="text-left px-6 py-4 font-medium">ロールアウト</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">対象ユーザー数</th>
                <th className="text-left px-6 py-4 font-medium">更新日</th>
                <th className="text-left px-6 py-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {flags.map((flag) => (
                <tr key={flag.key} className="hover:bg-slate-700/50 transition-colors">
                  <td className="px-6 py-4">
                    <code className="text-purple-300 text-sm font-mono">{flag.key}</code>
                  </td>
                  <td className="px-6 py-4 text-slate-300 text-sm">{flag.description || "—"}</td>
                  <td className="px-6 py-4 text-slate-300 text-sm">
                    {flag.rollout_strategy ? (
                      <span className="bg-blue-900/50 text-blue-300 text-xs px-2 py-1 rounded">
                        {flag.rollout_strategy.type}
                        {flag.rollout_strategy.value !== undefined && ` ${flag.rollout_strategy.value}%`}
                      </span>
                    ) : (
                      <span className="text-slate-500 text-xs">全体</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggle(flag.key, flag.enabled)}
                      disabled={isWriting || listStale}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                        flag.enabled ? "bg-green-500" : "bg-slate-600"
                      } ${isWriting || listStale ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          flag.enabled ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span className={`ml-2 text-xs ${flag.enabled ? "text-green-400" : "text-slate-500"}`}>
                      {flag.enabled ? "ON" : "OFF"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-300 text-sm">
                    {flag.active_user_count === null ? (
                      <span className="text-slate-500" title="ユーザーが多すぎる、または集計に失敗したため、数えていません">
                        —
                      </span>
                    ) : (
                      `${flag.active_user_count.toLocaleString("ja-JP")} 人`
                    )}
                  </td>
                  <td className="px-6 py-4 text-slate-400 text-sm">
                    {new Date(flag.updated_at).toLocaleDateString("ja-JP")}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleDelete(flag.key)}
                      disabled={isWriting || listStale}
                      className="text-red-400 hover:text-red-300 text-sm transition-colors disabled:opacity-50"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
