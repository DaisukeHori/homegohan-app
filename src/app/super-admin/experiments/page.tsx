"use client";

/**
 * /super-admin/experiments — A/B テストの一覧
 *
 * 一覧の「開始」・「完了」が 409 で断られたら (遷移表に無い変更 OP_EXPERIMENT_INVALID_TRANSITION・
 * 読んでから書くまでに別の操作が状態を変えた CONFLICT_STALE_DATA。どちらも別のタブ・別の運営が先に状態を変えたとき)、
 * 画面が自分で一覧を読み直し、その実験の名前と今の状態を画面の表示名 (下書き・実行中・完了・中止) で一覧の上に出す (#2064)。
 * route の文は DB の値の英字の状態名を埋めるので出さない。読み直しは一覧を外さずに行い、失敗したら文と「再試行」を出す。
 * 「開始」・「完了」の通信そのものが失敗した (fetch が reject した) ときは、サーバーが変更を済ませてから応答が切れたこともあるので、
 * 一覧を読み直して今の状態を見せ、「「<実験の名前>」の状態の変更の応答を受け取れませんでした」の文を出す (alert にしない。#2073)。
 * 読み直さないと、古い状態のボタンをもう一度押して 409 になり、自分の操作なのに「別の操作で…先に変わっていました」と出る。
 * そのあとの読み直しが失敗したら「再試行」を出し、読み直せるまで状態のボタンを止める (一覧の状態が古いかもしれないため)。
 * 409 のあとの読み直しが失敗したときも、読み直せるまで状態のボタンを止める (詳細の画面と同じ。#2080)。
 * 一覧の読み直しが 401 / 403 で断られたら、読み込み直しても変わらないので、理由の文 (401 は「ログインし直してください」・
 * 403 は二段階認証の確認が要る などの理由の文か「権限がありません」) を出し、「再試行」は出さず、状態のボタンも止めない
 * (詳細の画面と同じ分け方。#2086 V4)。
 * 読み込み・状態の変更の失敗の文は日本語だけにする (本文の無い 502 の「HTTP 502」だけの文・通信の reject の英字の文を出さない。#2086 V6)。
 * 200 なのに本文が読めない・data が配列でない応答は、0 件と見せずに読み込めなかったものとして扱う (初めの読み込みは
 * 「実験の一覧を読み込めませんでした（通信エラー）」、読み直しは一覧を残して「再試行」。詳細の画面と同じ扱い。#2093 W7)。
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import {
  EXPERIMENT_STATUS_LABELS,
  experimentListNoResponseReloadFailedMessage,
  experimentListNoResponseReloadedMessage,
  experimentListStaleGoneMessage,
  experimentListStaleReloadFailedMessage,
  experimentListStaleReloadedMessage,
  isExperimentStatusConflict,
  type ExperimentStatusChangeTarget,
} from "@/lib/super-admin/experiment-status-display";
import {
  adminActionHttpFailedMessage,
  adminLoadFailedMessage,
  screenApiErrorMessage,
} from "@/lib/admin/admin-screen-messages";
import { rereadUnavailableMessage } from "@/lib/super-admin/detail-reread";

/** 読み込みの失敗の文の対象 (「実験の一覧を読み込めませんでした (HTTP 502)」。#2086 V6) */
const EXPERIMENTS_SUBJECT = "実験の一覧";
/** 状態の変更の失敗の文の操作の名前 (「状態の変更に失敗しました (HTTP 502)」。#2086 V6) */
const STATUS_CHANGE_ACTION = "状態の変更";

interface Experiment {
  id: string;
  key: string;
  name: string;
  status: "draft" | "running" | "completed" | "cancelled";
  start_date: string | null;
  end_date: string | null;
  variants: Array<{ key: string; weight: number }>;
  primary_metric: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  draft: { label: EXPERIMENT_STATUS_LABELS.draft, color: "bg-slate-600 text-slate-200" },
  running: { label: EXPERIMENT_STATUS_LABELS.running, color: "bg-green-700 text-green-100" },
  completed: { label: EXPERIMENT_STATUS_LABELS.completed, color: "bg-blue-700 text-blue-100" },
  cancelled: { label: EXPERIMENT_STATUS_LABELS.cancelled, color: "bg-red-800 text-red-200" },
};

/**
 * 一覧の読み込みの結果。superseded は、読み込みの最中に新しい読み込みが始まったので結果を捨てた。
 * unavailable は、表示したあとの読み直しが 401 / 403 で断られた (読み込み直しても変わらない理由。#2086 V4)
 */
type ExperimentsLoadOutcome =
  | { kind: "loaded"; experiments: Experiment[] }
  | { kind: "failed" }
  | { kind: "unavailable"; message: string }
  | { kind: "superseded" };

/**
 * 一覧の上に出す、409 のあと・通信の reject のあとの読み直しについての文 (#2064・#2073)。name は操作した実験の名前 (押したときの一覧の名前)。
 *   - stale                    : 409 のあとに読み直した。status は読み直した今の状態 (一覧に無ければ null)
 *   - stale-reload-failed      : 409 のあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める。#2080)
 *   - no-response              : 状態の変更の通信が reject されたあとに読み直した (状態は一覧の行で見せる)
 *   - no-response-reload-failed: 通信が reject されたあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める)
 *   - unavailable              : 読み直しが 401 / 403 で断られた (理由の文を出す。「再試行」は出さず、状態のボタンも止めない。#2086 V4)
 */
type ReloadNotice =
  | { kind: "stale"; id: string; name: string; status: string | null }
  | { kind: "stale-reload-failed"; id: string; name: string }
  | { kind: "no-response"; id: string; name: string }
  | { kind: "no-response-reload-failed"; id: string; name: string }
  | { kind: "unavailable"; id: string; name: string; message: string };

function reloadNoticeText(notice: ReloadNotice): string {
  switch (notice.kind) {
    case "stale-reload-failed":
      return experimentListStaleReloadFailedMessage(notice.name);
    case "no-response":
      return experimentListNoResponseReloadedMessage(notice.name);
    case "no-response-reload-failed":
      return experimentListNoResponseReloadFailedMessage(notice.name);
    case "stale":
      return notice.status === null
        ? experimentListStaleGoneMessage(notice.name)
        : experimentListStaleReloadedMessage(notice.name, notice.status);
    case "unavailable":
      return notice.message;
  }
}

export default function ExperimentsPage() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 状態の変更 (開始・完了) の応答と、409 のあとの読み直しを待っている実験の id。待つあいだは一覧の状態の変更のボタンを止め、
  // 押されても送らない (二度押しで 2 本目の PATCH を送ると、変えられているのに 2 本目が断られて (running → running)
  // 失敗の文が出るため。#2050)。ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り
  const [changingId, setChangingId] = useState<string | null>(null);
  const changingRef = useRef(false);
  // 一覧の上に出す、409 のあとの読み直しについての文 (#2064)
  const [reloadNotice, setReloadNotice] = useState<ReloadNotice | null>(null);
  // 「再試行」の読み直しを待っているか
  const [isReloading, setIsReloading] = useState(false);
  // 一度一覧を表示したか (表示したあとの読み直しは、一覧を外さずに行う)
  const hasLoadedRef = useRef(false);
  // 読み込みを重ねたとき、古い読み込みの結果で上書きしないための連番
  const loadSeqRef = useRef(0);

  /**
   * 一覧を読む。初めの読み込みは失敗したら画面をエラーにする。
   * 表示したあとの読み直しは一覧を外さず、失敗しても一覧を残す (結果は戻り値で返し、文は呼び出し側が決める)
   */
  const loadExperiments = useCallback(async (): Promise<ExperimentsLoadOutcome> => {
    const seq = ++loadSeqRef.current;
    const isReload = hasLoadedRef.current;
    try {
      const res = await fetch("/api/super-admin/experiments");
      const body: unknown = await res.json().catch(() => null);
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      if (!res.ok) {
        if (!isReload) {
          // 本文に日本語の文が無ければ「実験の一覧を読み込めませんでした (HTTP 502)」(#2086 V6)
          setError(screenApiErrorMessage(body) ?? adminLoadFailedMessage(EXPERIMENTS_SUBJECT, res.status));
          return { kind: "failed" };
        }
        // 表示したあとの読み直しが 401 / 403 なら、読み込み直しても変わらない理由を返す (一覧の 404 は行の消えたことを意味しないので failed。#2086 V4)
        const unavailableMessage = rereadUnavailableMessage(res.status, body, null);
        return unavailableMessage === null ? { kind: "failed" } : { kind: "unavailable", message: unavailableMessage };
      }
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        // 200 なのに本文が読めない・data が配列でない。0 件と見せずに読み込めなかったものとして扱う (#2093 W7)
        if (!isReload) setError(adminLoadFailedMessage(EXPERIMENTS_SUBJECT, null));
        return { kind: "failed" };
      }
      const loaded = data as Experiment[];
      hasLoadedRef.current = true;
      setExperiments(loaded);
      setError(null);
      return { kind: "loaded", experiments: loaded };
    } catch {
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      // 通信そのものの失敗 (ブラウザの英字の例外の文は出さない。#2086 V6)
      if (!isReload) setError(adminLoadFailedMessage(EXPERIMENTS_SUBJECT, null));
      return { kind: "failed" };
    } finally {
      if (seq === loadSeqRef.current && !isReload) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  // 409 のあと・通信の reject のあとの一覧の読み直しが失敗し、まだ読み直せていないか (#2073・#2080)。そのあいだは状態のボタンを止める。
  // ref は描画を待たずに handler で読むための写し
  const reloadFailedRef = useRef(false);
  const [isReloadFailed, setIsReloadFailed] = useState(false);
  const markReloadFailed = useCallback((failed: boolean) => {
    reloadFailedRef.current = failed;
    setIsReloadFailed(failed);
  }, []);

  /**
   * 状態が分からなくなったあとの一覧の読み直し。cause は読み直す理由:
   *   - stale      : 409 (遷移表に無い変更・別の操作が先に状態を変えた)
   *   - no-response: 状態の変更の通信が reject された (応答を受け取れず、変更が済んだか分からない。#2073)
   * 結果に合わせて文を出す (読み直せなかったのに「読み込み直した」と出さない)
   */
  const reloadAfterUncertain = useCallback(
    async (target: { id: string; name: string }, cause: "stale" | "no-response") => {
      const outcome = await loadExperiments();
      if (outcome.kind === "superseded") return;
      // 読み直しが失敗したら、どちらの理由でも、読み直せるまで状態のボタンを止める (#2073・#2080)。
      // 401 / 403 (unavailable) は読み込み直しても変わらないので止めない (詳細の画面と同じ。#2086 V4)
      markReloadFailed(outcome.kind === "failed");
      if (outcome.kind === "unavailable") {
        setReloadNotice({ kind: "unavailable", id: target.id, name: target.name, message: outcome.message });
      } else if (outcome.kind === "loaded") {
        if (cause === "no-response") {
          setReloadNotice({ kind: "no-response", id: target.id, name: target.name });
          return;
        }
        const current = outcome.experiments.find((e) => e.id === target.id);
        setReloadNotice({ kind: "stale", id: target.id, name: target.name, status: current?.status ?? null });
      } else {
        setReloadNotice({
          kind: cause === "stale" ? "stale-reload-failed" : "no-response-reload-failed",
          id: target.id,
          name: target.name,
        });
      }
    },
    [loadExperiments, markReloadFailed],
  );

  /** 「再試行」: 409 のあと・通信の reject のあとの失敗した読み直しをやり直す */
  const retryReload = async (target: { id: string; name: string }, cause: "stale" | "no-response") => {
    if (changingRef.current) return;
    changingRef.current = true;
    setIsReloading(true);
    try {
      await reloadAfterUncertain(target, cause);
    } finally {
      changingRef.current = false;
      setIsReloading(false);
    }
  };

  const handleStatusChange = async (target: Experiment, status: ExperimentStatusChangeTarget) => {
    // 応答 (とそのあとの読み直し) を待つあいだ (#2050) と、409 のあと・通信の reject のあとの読み直しが失敗しているあいだ (#2073・#2080) は送らない
    if (changingRef.current || reloadFailedRef.current) return;
    changingRef.current = true;
    setChangingId(target.id);
    setReloadNotice(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/experiments/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch {
        // 応答を受け取れなかった (オフライン・接続が切れたなど)。変更が済んだかは分からないので、一覧を読み直して今の状態を見せる (#2073)
        await reloadAfterUncertain({ id: target.id, name: target.name }, "no-response");
        return;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isExperimentStatusConflict(res.status, body)) {
          // 別のタブ・別の運営が先に状態を変えていた (API は書いていない)。一覧を読み直し、その旨を一覧の上に出す
          await reloadAfterUncertain({ id: target.id, name: target.name }, "stale");
          return;
        }
        alert(screenApiErrorMessage(body) ?? adminActionHttpFailedMessage(STATUS_CHANGE_ACTION, res.status));
        return;
      }
      setExperiments((prev) => prev.map((e) => e.id === target.id ? { ...e, status } : e));
    } finally {
      changingRef.current = false;
      setChangingId(null);
    }
  };

  const isBusy = changingId !== null || isReloading;
  // 状態のボタンを止めるか (応答・読み直しを待つあいだと、409 のあと・通信の reject のあとの読み直しが失敗しているあいだ。#2073・#2080)
  const statusButtonsDisabled = isBusy || isReloadFailed;

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
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">A/B テスト管理</h1>
          <p className="text-slate-400 mt-1">実験の作成・管理・結果分析</p>
        </div>
        <Link
          href="/super-admin/experiments/new"
          className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-lg font-semibold transition-colors"
        >
          + 新規実験
        </Link>
      </div>

      {reloadNotice && (
        <div
          data-testid="experiment-reload-notice"
          role="alert"
          className="mb-6 flex items-start justify-between gap-4 bg-amber-900/40 border border-amber-500 rounded-xl p-4 text-amber-200 text-sm"
        >
          <p>{reloadNoticeText(reloadNotice)}</p>
          {(reloadNotice.kind === "stale-reload-failed" || reloadNotice.kind === "no-response-reload-failed") && (
            <button
              onClick={() =>
                void retryReload(
                  { id: reloadNotice.id, name: reloadNotice.name },
                  reloadNotice.kind === "no-response-reload-failed" ? "no-response" : "stale",
                )
              }
              disabled={isBusy}
              className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            >
              再試行
            </button>
          )}
        </div>
      )}

      {experiments.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 text-center text-slate-400 border border-slate-700">
          <div className="text-5xl mb-4">🧪</div>
          <p>実験がありません</p>
          <Link href="/super-admin/experiments/new" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
            最初の実験を作成する
          </Link>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl overflow-hidden border border-slate-700">
          <table className="w-full">
            <thead className="border-b border-slate-700">
              <tr className="text-slate-400 text-sm">
                <th className="text-left px-6 py-4 font-medium">実験名</th>
                <th className="text-left px-6 py-4 font-medium">ステータス</th>
                <th className="text-left px-6 py-4 font-medium">期間</th>
                <th className="text-left px-6 py-4 font-medium">バリアント</th>
                <th className="text-left px-6 py-4 font-medium">主要メトリクス</th>
                <th className="text-left px-6 py-4 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {experiments.map((exp) => {
                const badge = STATUS_BADGE[exp.status] ?? STATUS_BADGE.draft;
                return (
                  <tr key={exp.id} className="hover:bg-slate-700/50 transition-colors">
                    <td className="px-6 py-4">
                      <div>
                        <div className="text-white font-medium">{exp.name}</div>
                        <code className="text-slate-400 text-xs font-mono">{exp.key}</code>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badge.color}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.start_date ?? "未設定"} 〜 {exp.end_date ?? "未設定"}
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.variants.map((v) => `${v.key}(${v.weight}%)`).join(" / ")}
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-sm">
                      {exp.primary_metric ?? "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/super-admin/experiments/${exp.id}`}
                          className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
                        >
                          詳細
                        </Link>
                        {exp.status === "draft" && (
                          <button
                            onClick={() => handleStatusChange(exp, "running")}
                            disabled={statusButtonsDisabled}
                            className="text-green-400 hover:text-green-300 text-sm transition-colors disabled:opacity-50"
                          >
                            開始
                          </button>
                        )}
                        {exp.status === "running" && (
                          <button
                            onClick={() => handleStatusChange(exp, "completed")}
                            disabled={statusButtonsDisabled}
                            className="text-blue-400 hover:text-blue-300 text-sm transition-colors disabled:opacity-50"
                          >
                            完了
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
