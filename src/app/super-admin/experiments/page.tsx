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
 * 一覧はページで送る (#2107 Y9。以前は page / per_page なしで呼び、API の既定の 50 件より後ろの実験を出さず、件数もページ送りも無かった)。
 * 読むページは URL の page (parsePageParam で読む。1 以上の整数でなければ 1 ページ目)。meta.total で件数と「前へ」「次へ」
 * (URL の page を変えるリンク) を出す。件数より後ろのページは、空のページを見せずに最後のページへ移す (lastPageToRefetch)。
 * ページを移した先の読み込みは初めの読み込みと同じ扱いにする (前のページの行を残さず、失敗したら失敗の文だけを出す)。
 * 一覧の上の 409・通信の reject のあとの文は前のページの行についての文なので、運営がページを移したら消す
 * (読み直しで件数より後ろになって画面が自分で最後のページへ移したときは、読み直しの結果の文なので移した先にも出す)。
 * ページで送るので、409・通信の reject のあとに読み直した一覧 (表示しているページ) に押した実験が無くても、実験が消えたとは限らない
 * (応答を待つ間にページを移した・作成日の降順の一覧に新しい実験が増えて次のページへ押し出された)。そのときは詳細の API
 * (/api/super-admin/experiments/{id}) でその実験を読み、あれば今の状態を文に添えて「表示しているページにありません」と出し
 * (詳細の画面へのリンクを添える)、404 のときだけ「見つかりませんでした」と出す。詳細の読み込みが失敗したら「再試行」を出し、
 * 読み直せるまで状態のボタンを止める。401 / 403 なら理由の文を出す (一覧の読み直しと同じ分け方)。
 * 一覧の行にあるかどうかは、文を描くときに表示している行で決める (行にあれば状態は行のバッジで見せる)
 */

import { Suspense, useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { lastPageOf, lastPageToRefetch, parsePageParam } from "@/lib/list-pagination";
import { EXPERIMENTS_LIST_PER_PAGE_DEFAULT } from "@/lib/super-admin/experiments-schemas";
import {
  EXPERIMENT_STATUS_LABELS,
  experimentListNoResponseGoneMessage,
  experimentListNoResponseOffPageMessage,
  experimentListNoResponseReloadFailedMessage,
  experimentListNoResponseReloadedMessage,
  experimentListNoResponseStateReloadFailedMessage,
  experimentListStaleGoneMessage,
  experimentListStaleOffPageMessage,
  experimentListStaleReloadFailedMessage,
  experimentListStaleReloadedMessage,
  experimentListStaleStateReloadFailedMessage,
  isExperimentStatusConflict,
  type ExperimentStatusChangeTarget,
} from "@/lib/super-admin/experiment-status-display";
import {
  adminActionHttpFailedMessage,
  adminLoadFailedMessage,
  listTotalOfBody,
  screenApiErrorMessage,
  screenFailureMessage,
} from "@/lib/admin/admin-screen-messages";
import { rereadUnavailableMessage } from "@/lib/super-admin/detail-reread";

/** 読み込みの失敗の文の対象 (「実験の一覧を読み込めませんでした (HTTP 502)」。#2086 V6) */
const EXPERIMENTS_SUBJECT = "実験の一覧";
/** 状態の変更の失敗の文の操作の名前 (「状態の変更に失敗しました (HTTP 502)」。#2086 V6) */
const STATUS_CHANGE_ACTION = "状態の変更";
/** 一覧の画面のパス (ページ送りのリンク・最後のページへの移動の行き先) */
const EXPERIMENTS_PAGE_PATH = "/super-admin/experiments";
/** 1 ページの件数。一覧の API の既定 (per_page を省略したときの件数) と同じ値 (#2107 Y9) */
const EXPERIMENTS_PER_PAGE = EXPERIMENTS_LIST_PER_PAGE_DEFAULT;

/** page のページの一覧の画面の URL */
function experimentsPageHref(page: number): string {
  return `${EXPERIMENTS_PAGE_PATH}?page=${page}`;
}

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
 * unavailable は、表示したあとの読み直しが 401 / 403 で断られた (読み込み直しても変わらない理由。#2086 V4)。
 * moved は、読んだページが件数より後ろだったので最後のページへ移した (結果は移った先の読み込みで出す。page は移した先のページ。#2107 Y9)
 */
type ExperimentsLoadOutcome =
  | { kind: "loaded"; experiments: Experiment[] }
  | { kind: "failed" }
  | { kind: "unavailable"; message: string }
  | { kind: "superseded" }
  | { kind: "moved"; page: number };

/** 読み直しで読めなかったもの (list: 一覧・experiment: 一覧に無かった実験の詳細。#2107 Y9) */
type FailedRead = "list" | "experiment";

/**
 * 一覧の上に出す、409 のあと・通信の reject のあとの読み直しについての文 (#2064・#2073)。name は操作した実験の名前 (押したときの一覧の名前)。
 *   - stale                    : 409 のあとに読み直した
 *   - stale-reload-failed      : 409 のあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める。#2080)
 *   - no-response              : 状態の変更の通信が reject されたあとに読み直した
 *   - no-response-reload-failed: 通信が reject されたあとの読み直しに失敗した (「再試行」を出し、状態のボタンを止める)
 *   - unavailable              : 読み直しが 401 / 403 で断られた (理由の文を出す。「再試行」は出さず、状態のボタンも止めない。#2086 V4)
 * stale・no-response の status は、読み直した操作した実験の今の状態 (一覧の行か、一覧に無ければ詳細の API で読んだ値)。
 * null は詳細の API も 404 だった (実験が無い)。一覧はページで送るので、一覧の行にあるかどうかは描くときに表示している行で決める
 * (行にあれば状態は行のバッジで見せ、無ければ status を文に添えて「表示しているページにありません」と出す。#2107 Y9)。
 * failedRead は読めなかったもの (#2107 Y9)
 */
type ReloadNotice =
  | { kind: "stale"; id: string; name: string; status: string | null }
  | { kind: "stale-reload-failed"; id: string; name: string; failedRead: FailedRead }
  | { kind: "no-response"; id: string; name: string; status: string | null }
  | { kind: "no-response-reload-failed"; id: string; name: string; failedRead: FailedRead }
  | { kind: "unavailable"; id: string; name: string; message: string };

/**
 * 一覧の上の文。row は表示している一覧の行のうち、操作した実験の行 (無ければ undefined。#2107 Y9)。
 * status が null (詳細の API が 404) なら、行があっても (最後のページへ移す前の古い行) 「見つかりませんでした」。
 * 状態は読み直した値 (notice.status) で出す (最後のページへ移す前の古い行の状態を出さない)
 */
function reloadNoticeText(notice: ReloadNotice, row: Experiment | undefined): string {
  switch (notice.kind) {
    case "stale":
      if (notice.status === null) return experimentListStaleGoneMessage(notice.name);
      return row
        ? experimentListStaleReloadedMessage(notice.name, notice.status)
        : experimentListStaleOffPageMessage(notice.name, notice.status);
    case "stale-reload-failed":
      return notice.failedRead === "list"
        ? experimentListStaleReloadFailedMessage(notice.name)
        : experimentListStaleStateReloadFailedMessage(notice.name);
    case "no-response":
      if (notice.status === null) return experimentListNoResponseGoneMessage(notice.name);
      // 一覧の行にあれば、状態は行のバッジで見せる
      return row
        ? experimentListNoResponseReloadedMessage(notice.name)
        : experimentListNoResponseOffPageMessage(notice.name, notice.status);
    case "no-response-reload-failed":
      return notice.failedRead === "list"
        ? experimentListNoResponseReloadFailedMessage(notice.name)
        : experimentListNoResponseStateReloadFailedMessage(notice.name);
    case "unavailable":
      return notice.message;
  }
}

/** 一覧の上の文に、詳細の画面へのリンクを添えるか (読み直せた実験が表示している一覧の行に無いとき。#2107 Y9) */
function reloadNoticeLinksToDetail(notice: ReloadNotice, row: Experiment | undefined): boolean {
  return (notice.kind === "stale" || notice.kind === "no-response") && notice.status !== null && row === undefined;
}

/** 詳細の API が「実験が無い」と答えるときの HTTP ステータス (行が無いときだけ 404。DB の失敗は 500。route の GET) */
const EXPERIMENT_NOT_FOUND_HTTP_STATUS = 404;

/**
 * 一覧 (表示しているページ) に無かった、操作した実験の今の状態を詳細の API で読む (#2107 Y9)。投げない。
 *   - found      : 読めた (今の状態)
 *   - gone       : 404 (実験が無い)
 *   - unavailable: 401 / 403 (読み込み直しても変わらない理由の文。一覧の読み直しと同じ分け方。#2086 V4)
 *   - failed     : 500・通信の reject・本文が読めない・状態が文字列でない (「再試行」で変わりうる)
 */
type ExperimentStateRead =
  | { kind: "found"; status: string }
  | { kind: "gone" }
  | { kind: "unavailable"; message: string }
  | { kind: "failed" };

async function readExperimentState(id: string): Promise<ExperimentStateRead> {
  try {
    const res = await fetch(`/api/super-admin/experiments/${encodeURIComponent(id)}`);
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === EXPERIMENT_NOT_FOUND_HTTP_STATUS) return { kind: "gone" };
      const unavailableMessage = rereadUnavailableMessage(res.status, body, null);
      return unavailableMessage === null ? { kind: "failed" } : { kind: "unavailable", message: unavailableMessage };
    }
    const status = (body as { data?: { status?: unknown } | null } | null)?.data?.status;
    return typeof status === "string" ? { kind: "found", status } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** 読み込み中の表示 (初めの読み込み・ページを移した先の読み込み・URL を読む前) */
function ExperimentsLoadingSpinner() {
  return (
    <div className="p-8 flex justify-center">
      <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

/** URL の page (useSearchParams) を読むので Suspense で包む (他の画面の useSearchParams と同じ形。#2107 Y9) */
export default function ExperimentsPage() {
  return (
    <Suspense fallback={<ExperimentsLoadingSpinner />}>
      <ExperimentsList />
    </Suspense>
  );
}

function ExperimentsList() {
  const router = useRouter();
  // 読むページは URL の page (1 以上の整数でなければ 1 ページ目。#2107 Y9)
  const searchParams = useSearchParams();
  const page = parsePageParam(searchParams?.get("page") ?? undefined);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  // 一覧の全体の件数 (API の meta.total。#2107 Y9)
  const [total, setTotal] = useState(0);
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
  // 表示している一覧のページ (まだ表示していなければ null)。表示したページの読み直しは、一覧を外さずに行う。
  // 別のページの読み込みは初めの読み込みと同じ扱い (前のページの行を残さない。#2107 Y9)
  const loadedPageRef = useRef<number | null>(null);
  // 読み込みを重ねたとき、古い読み込みの結果で上書きしないための連番
  const loadSeqRef = useRef(0);
  // 件数より後ろのページから最後のページへ画面が自分で移した先のページ (#2107 Y9)。その読み込みは一覧の上の文を消さない
  // (409・通信の reject のあとの読み直しでページが移ったとき、読み直しの結果の文は移した先の画面に出す)。読み込みを始めるたびに消す
  const keepNoticeForPageRef = useRef<number | null>(null);
  // 今の URL のページ (handler で描画を待たずに読むための写し。ページを移したかどうかを見る。#2107 Y9)
  const pageRef = useRef(page);
  useLayoutEffect(() => {
    pageRef.current = page;
  }, [page]);

  // 409 のあと・通信の reject のあとの一覧の読み直しが失敗し、まだ読み直せていないか (#2073・#2080)。そのあいだは状態のボタンを止める。
  // ref は描画を待たずに handler で読むための写し
  const reloadFailedRef = useRef(false);
  const [isReloadFailed, setIsReloadFailed] = useState(false);
  const markReloadFailed = useCallback((failed: boolean) => {
    reloadFailedRef.current = failed;
    setIsReloadFailed(failed);
  }, []);

  /**
   * 一覧を読む。初めの読み込みは失敗したら画面をエラーにする。
   * 表示したあとの読み直しは一覧を外さず、失敗しても一覧を残す (結果は戻り値で返し、文は呼び出し側が決める)
   */
  const loadExperiments = useCallback(async (): Promise<ExperimentsLoadOutcome> => {
    const seq = ++loadSeqRef.current;
    const isReload = loadedPageRef.current === page;
    // 件数より後ろのページから最後のページへ移すときは、読み込み中のまま移った先の読み込みへ渡す (空の一覧を一瞬も見せない)
    let moved = false;
    // 画面が自分で移した先のページの読み込みか (一覧の上の文を消さない。#2107 Y9)
    const keepNotice = keepNoticeForPageRef.current === page;
    keepNoticeForPageRef.current = null;
    if (!isReload) {
      // 別のページ (初めの読み込みを含む) を読む。前のページの行・件数と、その行についての一覧の上の文を残さない (#2107 Y9)。
      // ただし画面が自分で移した先のページなら、文は移す前の読み直しの結果なので残す
      loadedPageRef.current = null;
      setIsLoading(true);
      setError(null);
      setExperiments([]);
      setTotal(0);
      if (!keepNotice) {
        setReloadNotice(null);
        markReloadFailed(false);
      }
    }
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(EXPERIMENTS_PER_PAGE) });
      const res = await fetch(`/api/super-admin/experiments?${params}`);
      const body: unknown = await res.json().catch(() => null);
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      if (!res.ok) {
        // 401 / 403 なら、読み込み直しても変わらない理由の文 (「ログインし直してください」・403 の理由の文) にする
        // (一覧の 404 は行の消えたことを意味しないので failed。#2086 V4)。初めの読み込みも同じ文にする (#2101 X4)
        const unavailableMessage = rereadUnavailableMessage(res.status, body, null);
        if (!isReload) {
          // 本文に日本語の文が無ければ「実験の一覧を読み込めませんでした (HTTP 502)」(#2086 V6)
          setError(unavailableMessage ?? screenApiErrorMessage(body) ?? adminLoadFailedMessage(EXPERIMENTS_SUBJECT, res.status));
          return { kind: "failed" };
        }
        return unavailableMessage === null ? { kind: "failed" } : { kind: "unavailable", message: unavailableMessage };
      }
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        // 200 なのに本文が読めない・data が配列でない。0 件と見せずに読み込めなかったものとして扱う (#2093 W7)
        if (!isReload) setError(adminLoadFailedMessage(EXPERIMENTS_SUBJECT, null));
        return { kind: "failed" };
      }
      const loaded = data as Experiment[];
      const metaTotal = listTotalOfBody(body);
      // 件数より後ろのページ (URL のページ番号・最後のページの唯一の行が消えたあとの読み直し) は、最後のページへ移す (#2107 Y9)
      const refetchPage = lastPageToRefetch({ rows: loaded.length, page, total: metaTotal, perPage: EXPERIMENTS_PER_PAGE });
      if (refetchPage !== null) {
        moved = true;
        keepNoticeForPageRef.current = refetchPage;
        router.replace(experimentsPageHref(refetchPage));
        return { kind: "moved", page: refetchPage };
      }
      loadedPageRef.current = page;
      setExperiments(loaded);
      // meta.total が無い・数でない応答でも、出している行より少ない件数にはしない
      setTotal(Math.max(metaTotal, (page - 1) * EXPERIMENTS_PER_PAGE + loaded.length));
      setError(null);
      return { kind: "loaded", experiments: loaded };
    } catch {
      if (seq !== loadSeqRef.current) return { kind: "superseded" };
      // 通信そのものの失敗 (ブラウザの英字の例外の文は出さない。#2086 V6)
      if (!isReload) setError(adminLoadFailedMessage(EXPERIMENTS_SUBJECT, null));
      return { kind: "failed" };
    } finally {
      if (seq === loadSeqRef.current && !isReload && !moved) setIsLoading(false);
    }
  }, [page, router, markReloadFailed]);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  // 今の URL のページを読む loadExperiments の写し。状態の変更のあとの読み直しは、応答を待つ間にページを移していても
  // 押したときのページでなく今のページを読む (押したときの関数のままだと前のページを読み、今のページの読み込みを追い越して
  // URL と違うページの行を出す。#2107 Y9)
  const loadExperimentsRef = useRef(loadExperiments);
  useLayoutEffect(() => {
    loadExperimentsRef.current = loadExperiments;
  }, [loadExperiments]);

  /**
   * 状態が分からなくなったあとの一覧の読み直し。cause は読み直す理由:
   *   - stale      : 409 (遷移表に無い変更・別の操作が先に状態を変えた)
   *   - no-response: 状態の変更の通信が reject された (応答を受け取れず、変更が済んだか分からない。#2073)
   * 結果に合わせて文を出す (読み直せなかったのに「読み込み直した」と出さない)
   */
  const reloadAfterUncertain = useCallback(
    async (target: { id: string; name: string }, cause: "stale" | "no-response") => {
      // 読み直すページ (loadExperimentsRef は今の URL のページを読む)
      const reloadedPage = pageRef.current;
      const outcome = await loadExperimentsRef.current();
      if (outcome.kind === "superseded") return;
      const failed = (failedRead: FailedRead): ReloadNotice =>
        cause === "stale"
          ? { kind: "stale-reload-failed", id: target.id, name: target.name, failedRead }
          : { kind: "no-response-reload-failed", id: target.id, name: target.name, failedRead };
      const reloaded = (status: string | null): ReloadNotice =>
        cause === "stale"
          ? { kind: "stale", id: target.id, name: target.name, status }
          : { kind: "no-response", id: target.id, name: target.name, status };
      const unavailable = (message: string): ReloadNotice => ({ kind: "unavailable", id: target.id, name: target.name, message });
      let notice: ReloadNotice;
      if (outcome.kind === "unavailable") {
        notice = unavailable(outcome.message);
      } else if (outcome.kind === "failed") {
        notice = failed("list");
      } else {
        const current = outcome.kind === "loaded" ? outcome.experiments.find((e) => e.id === target.id) : undefined;
        if (current) {
          notice = reloaded(current.status);
        } else {
          // 一覧はページで送るので、表示しているページに無いだけでは消えたと言わない (応答を待つ間にページを移した・
          // 新しい実験が増えて次のページへ押し出された・件数より後ろになって最後のページへ移した)。
          // 詳細の API で読み、あれば今の状態を添え、404 のときだけ「見つかりません」(#2107 Y9)
          const seq = loadSeqRef.current;
          const read = await readExperimentState(target.id);
          // 詳細を読む間に運営がページを移した (別の読み込みが始まった) なら、移した先の画面は初めの読み込みと同じ扱い (文を出さない)。
          // 最後のページへ画面が自分で移したとき (moved) は、移した先の読み込みが文を残すので、運営が別のページへ移したときだけ捨てる
          const navigatedAway =
            outcome.kind === "moved"
              ? pageRef.current !== reloadedPage && pageRef.current !== outcome.page
              : seq !== loadSeqRef.current;
          if (navigatedAway) return;
          notice =
            read.kind === "found"
              ? reloaded(read.status)
              : read.kind === "gone"
                ? reloaded(null)
                : read.kind === "unavailable"
                  ? unavailable(read.message)
                  : failed("experiment");
        }
      }
      // 読み直しが失敗したら、どちらの理由でも、読み直せるまで状態のボタンを止める (#2073・#2080)。
      // 401 / 403 (unavailable) は読み込み直しても変わらないので止めない (詳細の画面と同じ。#2086 V4)
      markReloadFailed(notice.kind === "stale-reload-failed" || notice.kind === "no-response-reload-failed");
      setReloadNotice(notice);
    },
    [markReloadFailed],
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
        alert(screenFailureMessage(res.status, body) ?? adminActionHttpFailedMessage(STATUS_CHANGE_ACTION, res.status));
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
  // ページ送り (#2107 Y9)。件数から出した最後のページ (0 件でも 1)
  const totalPages = lastPageOf(total, EXPERIMENTS_PER_PAGE);
  // 一覧の上の文の実験の、表示している一覧の行 (無ければ undefined。行にあるかで文を決める。#2107 Y9)
  const noticeRow = reloadNotice ? experiments.find((e) => e.id === reloadNotice.id) : undefined;

  if (isLoading) {
    return <ExperimentsLoadingSpinner />;
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
          {/* 一覧の全体の件数 (このページの行数ではない。#2107 Y9) */}
          <p data-testid="experiments-total" className="text-slate-400 text-sm mt-1">
            全 {total.toLocaleString()} 件
          </p>
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
          <p>
            {reloadNoticeText(reloadNotice, noticeRow)}
            {/* 表示しているページに無い実験は、詳細の画面で確かめられるようにする (#2107 Y9) */}
            {reloadNoticeLinksToDetail(reloadNotice, noticeRow) && (
              <Link
                href={`/super-admin/experiments/${reloadNotice.id}`}
                className="ml-2 underline text-amber-100 hover:text-white"
              >
                詳細を開く
              </Link>
            )}
          </p>
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

      {/* ページ送り (URL の page を変える。#2107 Y9) */}
      {totalPages > 1 && (
        <div data-testid="experiments-pagination" className="mt-4 flex items-center justify-between text-sm text-slate-400">
          <span>
            {(page - 1) * EXPERIMENTS_PER_PAGE + 1}〜{Math.min(page * EXPERIMENTS_PER_PAGE, total)} 件 / {total.toLocaleString()} 件
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={experimentsPageHref(page - 1)}
                className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-700 transition-colors"
              >
                前へ
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={experimentsPageHref(page + 1)}
                className="px-3 py-1 rounded border border-slate-600 hover:bg-slate-700 transition-colors"
              >
                次へ
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
