"use client";

/**
 * /super-admin/experiments/[id] — A/B テストの詳細
 *
 * 状態の変更 (実験開始・完了・中止) が 409 で断られたら (遷移表に無い変更 OP_EXPERIMENT_INVALID_TRANSITION・
 * 読んでから書くまでに別の操作が状態を変えた CONFLICT_STALE_DATA。どちらも別のタブ・別の運営が先に状態を変えたとき)、
 * 画面が自分で実験を読み直し、読み直した旨と今の状態を画面の表示名 (下書き・実行中・完了・中止) で画面の上に出す (#2064)。
 * route の文は DB の値の英字の状態名を埋めるので出さない。読み直しは画面を外さずに行い、失敗したら文と「再試行」を出す。
 * 読み直しが 404 / 403 / 401 で断られたら、読み込み直しても変わらないので、その理由の文を出し「再試行」は出さない
 * (プランの詳細の reloadAfterStale と同じ形。401 は「ログインし直してください」。#2086 V4)。
 * 読み込み・状態の変更の失敗の文は日本語だけにする (本文の無い 502 の「HTTP 502」だけの文・通信の reject の英字の文を出さない。#2086 V6)。確認の文・状態のバッジも英字の状態名を出さない。
 * 状態の変更は、応答とそのあとの読み直しを待つあいだ、ほかの状態の変更を送らない (#2050。ref でも守る)。
 * 状態の変更の通信そのものが失敗した (fetch が reject した) ときは、サーバーが変更を済ませてから応答が切れたこともあるので、
 * 実験を読み直して今の状態とボタンを見せ、「状態の変更の応答を受け取れませんでした」の文を出す (alert にしない。#2073)。
 * 読み直さないと、古い状態のボタンをもう一度押して 409 になり、自分の操作なのに「別の操作で実験の状態が先に変わっていました」と出る。
 * そのあとの読み直しが失敗したら「再試行」を出し、読み直せるまで状態のボタンを止める (画面の状態が古いかもしれないため)。
 * 状態の変更が 200 で返ったのに本文を読み切れない (JSON でない・data が無い) ときも、変更は済んでいるのに画面の状態が古いままになるので、
 * 通信の reject と同じく読み直して今の状態を見せる (クーポン・機能パッケージの詳細と同じ。#2080)。
 * 409 のあとの読み直しが失敗したときも、読み直せるまで状態のボタンを止める (クーポン・機能パッケージ・プランの詳細と同じ。#2080)。
 */

import { useState, useEffect, useCallback, useRef, use } from "react";
import Link from "next/link";
import {
  adminActionHttpFailedMessage,
  adminLoadFailedMessage,
  screenApiErrorMessage,
} from "@/lib/admin/admin-screen-messages";
import { rereadUnavailableMessage } from "@/lib/super-admin/detail-reread";
import {
  EXPERIMENT_NOT_FOUND_ON_RELOAD_MESSAGE,
  EXPERIMENT_NO_RESPONSE_RELOAD_FAILED_MESSAGE,
  EXPERIMENT_STALE_RELOAD_FAILED_MESSAGE,
  EXPERIMENT_STATUS_CHANGE_CONFIRM_MESSAGES,
  experimentNoResponseReloadedMessage,
  experimentStaleReloadedMessage,
  experimentStatusLabel,
  isExperimentStatusConflict,
  type ExperimentStatusChangeTarget,
} from "@/lib/super-admin/experiment-status-display";

interface ExperimentResults {
  experiment_id: string;
  experiment_key: string;
  experiment_name: string;
  status: string;
  total_assignments: number;
  by_variant: Array<{
    variant_key: string;
    assignment_count: number;
    percentage: number;
    conversion_rate: number | null;
    p_value: number | null;
  }>;
  is_significant: boolean | null;
  winner: string | null;
  stored_result: Record<string, unknown> | null;
}

interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  variants: Array<{ key: string; weight: number }>;
  primary_metric: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-600 text-slate-200",
  running: "bg-green-700 text-green-100",
  completed: "bg-blue-700 text-blue-100",
  cancelled: "bg-red-800 text-red-200",
};

/** 読み込みの失敗の文の対象 (「実験を読み込めませんでした (HTTP 502)」。#2086 V6) */
const EXPERIMENT_SUBJECT = "実験";
/** 状態の変更の失敗の文の操作の名前 (「状態の変更に失敗しました (HTTP 502)」。#2086 V6) */
const STATUS_CHANGE_ACTION = "状態の変更";

/**
 * 実験の読み込みの結果。superseded は、読み込みの最中に新しい読み込みが始まったので結果を捨てた。
 * unavailable は、表示したあとの読み直しが 404 / 403 / 401 で断られた (読み込み直しても変わらない理由。401 は #2086 V4)
 */
type ExperimentLoadOutcome =
  | { kind: "loaded"; experiment: Experiment }
  | { kind: "failed" }
  | { kind: "unavailable"; message: string }
  | { kind: "superseded" };

/**
 * 画面の上に出す、409 のあと・通信の reject のあとの読み直しについての文 (#2064・#2073)。
 *   - stale                    : 409 のあとに読み直した (今の状態を添える)
 *   - stale-reload-failed      : 409 のあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める。#2080)
 *   - no-response              : 状態の変更の通信が reject されたあとに読み直した (今の状態を添える)
 *   - no-response-reload-failed: 通信が reject されたあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める)
 *   - unavailable              : 読み直しが 404 / 403 / 401 で断られた (「再試行」は出さない)
 */
type ReloadNotice =
  | { kind: "stale"; status: string }
  | { kind: "stale-reload-failed" }
  | { kind: "no-response"; status: string }
  | { kind: "no-response-reload-failed" }
  | { kind: "unavailable"; message: string };

function reloadNoticeText(notice: ReloadNotice): string {
  switch (notice.kind) {
    case "stale":
      return experimentStaleReloadedMessage(notice.status);
    case "stale-reload-failed":
      return EXPERIMENT_STALE_RELOAD_FAILED_MESSAGE;
    case "no-response":
      return experimentNoResponseReloadedMessage(notice.status);
    case "no-response-reload-failed":
      return EXPERIMENT_NO_RESPONSE_RELOAD_FAILED_MESSAGE;
    case "unavailable":
      return notice.message;
  }
}

export default function ExperimentDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [results, setResults] = useState<ExperimentResults | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 状態の変更 (開始・完了・中止) の応答と、409 のあとの読み直しを待っているか。待つあいだは状態のボタンを止める
  // (二度押しで 2 本目を送ると、変えられているのに断られて失敗の文が出るため。#2050)
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  // ref は再描画の前に続けて押されたとき (ボタンがまだ止まっていない) の守り (クーポン・プランの詳細と同じ形。#2064)
  const writeInFlightRef = useRef(false);
  // 画面の上に出す、409 のあとの読み直しについての文 (#2064)
  const [reloadNotice, setReloadNotice] = useState<ReloadNotice | null>(null);
  // 「再試行」の読み直しを待っているか
  const [isReloading, setIsReloading] = useState(false);
  // 一度実験を表示したか (表示したあとの読み直しは、画面を外さずに行う)
  const hasLoadedRef = useRef(false);
  // 読み込みを重ねたとき、古い読み込みの結果で上書きしないための連番
  const loadSeqRef = useRef(0);

  /**
   * 実験 (と結果) を読む。初めの読み込みは失敗したら画面をエラーにする。
   * 表示したあとの読み直しは画面を外さず、失敗しても画面を残す (結果は戻り値で返し、文は呼び出し側が決める)
   */
  const loadExperiment = useCallback(async (): Promise<ExperimentLoadOutcome> => {
    const seq = ++loadSeqRef.current;
    const isReload = hasLoadedRef.current;
    try {
      const [expRes, resRes] = await Promise.all([
        fetch(`/api/super-admin/experiments/${params.id}`),
        fetch(`/api/super-admin/experiments/${params.id}/results`),
      ]);
      // 403 の本文が JSON として読めなくても「権限がありません」を出せるよう、読めない本文は null にする
      const expBody: unknown = await expRes.json().catch(() => null);
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      const loaded = (expBody as { data?: Experiment } | null)?.data;
      if (!expRes.ok || !loaded) {
        if (!isReload) {
          // 本文に日本語の文が無ければ「実験を読み込めませんでした (HTTP 502)」。200 なのに本文が読めないときは通信エラーの文 (#2086 V6)。
          // 401 / 403 は読み直しと同じ理由の文 (「ログインし直してください」・403 の理由の文) にする (#2101 X4。初めの読み込みの 404 は従来どおり)
          const initialUnavailableMessage = expRes.ok ? null : rereadUnavailableMessage(expRes.status, expBody, null);
          setError(
            initialUnavailableMessage ??
              screenApiErrorMessage(expBody) ??
              adminLoadFailedMessage(EXPERIMENT_SUBJECT, expRes.ok ? null : expRes.status),
          );
          return { kind: "failed" };
        }
        // 表示したあとの読み直しが 404 / 403 / 401 なら、読み込み直しても変わらない理由を返す (401 も「再試行」を出さない。#2086 V4)
        const unavailableMessage = expRes.ok
          ? null
          : rereadUnavailableMessage(expRes.status, expBody, EXPERIMENT_NOT_FOUND_ON_RELOAD_MESSAGE);
        return unavailableMessage === null ? { kind: "failed" } : { kind: "unavailable", message: unavailableMessage };
      }
      hasLoadedRef.current = true;
      setExperiment(loaded);
      setError(null);

      if (resRes.ok) {
        const resBody: unknown = await resRes.json().catch(() => null);
        const loadedResults = (resBody as { data?: ExperimentResults } | null)?.data;
        if (seq === loadSeqRef.current && loadedResults) setResults(loadedResults);
      }
      return { kind: "loaded", experiment: loaded };
    } catch {
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      // 通信そのものの失敗 (ブラウザの英字の例外の文は出さない。#2086 V6)
      if (!isReload) setError(adminLoadFailedMessage(EXPERIMENT_SUBJECT, null));
      return { kind: "failed" };
    } finally {
      if (seq === loadSeqRef.current && !isReload) setIsLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void loadExperiment();
  }, [loadExperiment]);

  /**
   * 409 のあと・通信の reject のあとの読み直しが失敗し、まだ読み直せていないか (#2073・#2080)。そのあいだは状態のボタンを止める
   * (画面の状態が DB と食い違っているかもしれないのに、その状態を元にしたボタンを押させない)。ref は描画を待たずに handler で読むための写し
   */
  const reloadFailedRef = useRef(false);
  const [isReloadFailed, setIsReloadFailed] = useState(false);
  const markReloadFailed = useCallback((failed: boolean) => {
    reloadFailedRef.current = failed;
    setIsReloadFailed(failed);
  }, []);

  /**
   * 状態が分からなくなったあとの読み直し。cause は読み直す理由:
   *   - stale      : 409 (遷移表に無い変更・別の操作が先に状態を変えた)
   *   - no-response: 状態の変更の通信が reject された (応答を受け取れず、変更が済んだか分からない。#2073)
   * 結果に合わせて文を出す (読み直せなかったのに「読み込み直した」と出さない)
   */
  const reloadAfterUncertain = useCallback(async (cause: "stale" | "no-response") => {
    const outcome = await loadExperiment();
    if (outcome.kind === "superseded") return;
    // 読み直しが失敗したら、どちらの理由でも、読み直せるまで状態のボタンを止める (#2073・#2080)。
    // 404 / 403 / 401 (unavailable) は読み込み直しても変わらないので止めない (プランの詳細と同じ)
    markReloadFailed(outcome.kind === "failed");
    if (outcome.kind === "loaded") {
      setReloadNotice({ kind: cause, status: outcome.experiment.status });
    } else if (outcome.kind === "failed") {
      setReloadNotice({ kind: cause === "stale" ? "stale-reload-failed" : "no-response-reload-failed" });
    } else {
      setReloadNotice({ kind: "unavailable", message: outcome.message });
    }
  }, [loadExperiment, markReloadFailed]);

  /** 409 (遷移表に無い変更・別の操作が先に状態を変えた) のあとの読み直し */
  const reloadAfterStale = useCallback(() => reloadAfterUncertain("stale"), [reloadAfterUncertain]);

  /** 「再試行」: 409 のあと・通信の reject のあとの失敗した読み直しをやり直す */
  const retryReload = async () => {
    if (writeInFlightRef.current) return;
    writeInFlightRef.current = true;
    setIsReloading(true);
    try {
      await reloadAfterUncertain(reloadNotice?.kind === "no-response-reload-failed" ? "no-response" : "stale");
    } finally {
      writeInFlightRef.current = false;
      setIsReloading(false);
    }
  };

  const handleStatusChange = async (status: ExperimentStatusChangeTarget) => {
    // 応答 (とそのあとの読み直し) を待つあいだは送らない (#2050。ref は再描画の前の続けての押下の守り。#2064)。
    // 409 のあと・通信の reject のあとの読み直しが失敗して、まだ読み直せていないあいだも送らない (#2073・#2080)
    if (writeInFlightRef.current || reloadFailedRef.current) return;
    if (!confirm(EXPERIMENT_STATUS_CHANGE_CONFIRM_MESSAGES[status])) return;
    writeInFlightRef.current = true;
    setIsChangingStatus(true);
    setReloadNotice(null);
    try {
      let res: Response;
      try {
        res = await fetch(`/api/super-admin/experiments/${params.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
      } catch {
        // 応答を受け取れなかった (オフライン・接続が切れたなど)。変更が済んだかは分からないので、読み直して今の状態を見せる (#2073)
        await reloadAfterUncertain("no-response");
        return;
      }
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        if (isExperimentStatusConflict(res.status, body)) {
          // 別のタブ・別の運営が先に状態を変えていた (API は書いていない)。実験を読み直し、その旨を画面の上に出す
          await reloadAfterStale();
          return;
        }
        alert(screenApiErrorMessage(body) ?? adminActionHttpFailedMessage(STATUS_CHANGE_ACTION, res.status));
        return;
      }
      const updated = (body as { data?: Experiment } | null)?.data;
      if (!updated) {
        // 200 なので変更は済んでいるが、本文 (書いたあとの行) を読み切れなかった (JSON でない・data が無い)。
        // 画面の状態は古いままなので、通信の reject と同じく読み直して今の状態を見せる (#2080)
        await reloadAfterUncertain("no-response");
        return;
      }
      setExperiment(updated);
    } finally {
      writeInFlightRef.current = false;
      setIsChangingStatus(false);
    }
  };

  const isBusy = isChangingStatus || isReloading;
  // 状態のボタンを止めるか (応答・読み直しを待つあいだと、409 のあと・通信の reject のあとの読み直しが失敗しているあいだ。#2073・#2080)
  const statusButtonsDisabled = isBusy || isReloadFailed;

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center">
        <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !experiment) {
    return (
      <div className="p-8">
        <div className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300">
          {error ?? "実験が見つかりません"}
        </div>
      </div>
    );
  }

  const badgeClass = STATUS_BADGE[experiment.status] ?? STATUS_BADGE.draft;

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <Link href="/super-admin/experiments" className="text-slate-400 hover:text-white transition-colors">
          ← A/B テスト一覧
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
              onClick={() => void retryReload()}
              disabled={isBusy}
              className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            >
              再試行
            </button>
          )}
        </div>
      )}

      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold text-white">{experiment.name}</h1>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badgeClass}`}>
              {experimentStatusLabel(experiment.status)}
            </span>
          </div>
          <code className="text-slate-400 font-mono text-sm">{experiment.key}</code>
        </div>

        <div className="flex gap-2">
          {experiment.status === "draft" && (
            <button
              onClick={() => handleStatusChange("running")}
              disabled={statusButtonsDisabled}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            >
              実験開始
            </button>
          )}
          {experiment.status === "running" && (
            <>
              <button
                onClick={() => handleStatusChange("completed")}
                disabled={statusButtonsDisabled}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              >
                完了
              </button>
              <button
                onClick={() => handleStatusChange("cancelled")}
                disabled={statusButtonsDisabled}
                className="bg-red-700 hover:bg-red-800 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              >
                中止
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        {/* 基本情報 */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4">基本情報</h2>
          <dl className="grid grid-cols-2 gap-4">
            {experiment.hypothesis && (
              <div className="col-span-2">
                <dt className="text-slate-400 text-sm">仮説</dt>
                <dd className="text-white mt-1">{experiment.hypothesis}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-400 text-sm">主要メトリクス</dt>
              <dd className="text-white mt-1">{experiment.primary_metric ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-400 text-sm">期間</dt>
              <dd className="text-white mt-1">
                {experiment.start_date ?? "未設定"} 〜 {experiment.end_date ?? "未設定"}
              </dd>
            </div>
          </dl>
        </div>

        {/* バリアント設定 */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4">バリアント設定</h2>
          <div className="space-y-3">
            {experiment.variants.map((v) => (
              <div key={v.key} className="flex items-center gap-4">
                <code className="font-mono text-sm text-purple-300 w-40">{v.key}</code>
                <div className="flex-1 bg-slate-700 rounded-full h-3 overflow-hidden">
                  <div
                    className="bg-purple-500 h-full rounded-full"
                    style={{ width: `${v.weight}%` }}
                  />
                </div>
                <span className="text-slate-300 text-sm w-12 text-right">{v.weight}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* 結果ダッシュボード */}
        {results && (
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold text-white mb-4">結果ダッシュボード</h2>
            <div className="mb-4">
              <span className="text-slate-400 text-sm">総割当数: </span>
              <span className="text-white font-semibold">{results.total_assignments.toLocaleString()} ユーザー</span>
            </div>
            <div className="space-y-3">
              {results.by_variant.map((v) => (
                <div key={v.variant_key} className="bg-slate-700/50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <code className="font-mono text-sm text-purple-300">{v.variant_key}</code>
                    <span className="text-slate-300 text-sm">{v.assignment_count.toLocaleString()} ユーザー ({v.percentage}%)</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-purple-500 h-2 rounded-full"
                      style={{ width: `${v.percentage}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {results.is_significant === null && (
              <p className="mt-4 text-slate-500 text-sm">
                統計的有意差の計算は外部分析ツール連携が必要です
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
