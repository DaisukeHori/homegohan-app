"use client";

// AI の 1 日の利用回数の上限 (プランごと) の画面 (#1149 / T40)
//
// GET /api/super-admin/llm/quotas で一覧を読み、行ごとに上限を保存する (PATCH /api/super-admin/llm/quotas)。
// 保存先は DB の ai_daily_limits で、AI を使う入口の判定 (consume_ai_usage) がその値を読む (次の AI の利用から効く)。
//   - 上限は 1 日 (日本時間の暦日) の、全機能の合計の回数。空欄で保存すると無制限
//   - 自分の行が無いプランは free の値を使う (「free の値」と表示する)
//   - 変更の理由は必須 (監査ログに残す)
//   - 組織のプランの値 (standard / premium / enterprise) の行も保存できる。どちらにも無いキーの行は入力欄と保存を止める (#1912)
//   - subscription_plans の組織のプランの行 (org_*) は値が判定に使われないので、入力欄と保存を止め、
//     「組織の上限は組織のプランの値 (standard / premium / enterprise) の行で決まります」と案内する (PATCH も 409 PLAN_READ_ONLY で断る。#1912)
//   - 保存が 409 CONFLICT_STALE_DATA (読んでから書くまでに別の運営が先に同じプランの上限を変えた) で断られたら、一覧を読み直して
//     いまの上限を出し、行にその旨を出す。入力欄 (新しい上限・理由) の書きかけは読み直しで消さない (#1917)
//   - 一度表を出したあとの読み直し (保存のあと・409 のあと) は表を外さずに行い (入力欄のフォーカスも外さない)、失敗しても表と
//     書きかけを残して、表の上に文と「再試行」を出す。409 のあとの読み直しに失敗したら、行の文も「読み込み直せなかった」にする。
//     その行の文は、どの経路の読み直し (「再試行」・ほかの行の保存のあとの読み直し) でも、読み直せたら「読み込み直した」文に変える。
//     409 の文の出ている行は「入力した値と理由は残しています」と伝えているので、その行の入力欄はどの読み直しでも上書きしない (#1917)

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isStaleDataConflict } from "@/lib/admin/api-error-message";
import {
  AI_DAILY_LIMIT_READ_ONLY_NOTES,
  aiDailyLimitRowReadOnlyReason,
  parseLimitInput,
} from "@/lib/super-admin/ai-daily-limits";
import { AI_DAILY_LIMIT_MAX, type AiDailyLimitRow } from "@/lib/super-admin/llm-schemas";

/** 一覧の 1 行 (API の型そのもの) */
type QuotaRow = AiDailyLimitRow;

interface QuotaListResponse {
  data: QuotaRow[];
  default_plan_key: string;
  note: string;
}

interface Draft {
  /** 入力欄の文字 (空欄は無制限) */
  limit: string;
  reason: string;
}

function limitLabel(limit: number | null): string {
  return limit === null ? "無制限" : `${limit.toLocaleString()} 回`;
}

/**
 * 保存が 409 CONFLICT_STALE_DATA で断られ、一覧を読み直したときに行に出す文 (#1917)。
 * サーバーの文は「画面を読み込み直して」と頼む文なので使わない (画面が自分で読み直すため)
 */
const STALE_LIMIT_MESSAGE =
  "別の運営が先にこのプランの上限を変えていました。一覧を読み込み直したので、いまの上限を確かめてから、もう一度保存してください（入力した値と理由は残しています）";

/** 保存が 409 CONFLICT_STALE_DATA で断られ、一覧を読み直している最中に行に出す文 (#1917) */
const STALE_LIMIT_RELOADING_MESSAGE =
  "別の運営が先にこのプランの上限を変えていました。一覧を読み込み直しています（入力した値と理由は残しています）";

/** 保存が 409 CONFLICT_STALE_DATA で断られ、一覧の読み直しにも失敗したときに行に出す文 (#1917) */
const STALE_LIMIT_RELOAD_FAILED_MESSAGE =
  "別の運営が先にこのプランの上限を変えていました。一覧を読み込み直せなかったので、表の上の「再試行」で読み込み直し、いまの上限を確かめてから、もう一度保存してください（入力した値と理由は残しています）";

/** 表を出したあとの読み直しに失敗したときに、表の上に出す文 (#1917) */
const RELOAD_FAILED_MESSAGE = "最新の上限を読み込めませんでした。表の値は古いかもしれません";

/**
 * 保存が 409 CONFLICT_STALE_DATA で断られた行の文の段階 (#1917)。
 *   - reloading    : 一覧を読み直している
 *   - reloaded     : 409 のあとに一覧を読み直せた
 *   - reload-failed: 一覧の読み直しに失敗した (表の上に「再試行」が出ている)
 * 段階は一覧の読み込み (load) が結果に合わせて進める。どの経路の読み込みでも、読めたら reloaded にし、
 * 失敗したら reloading を reload-failed にする (「再試行」だけでなく、ほかの行の保存のあとの読み直しで読めたときも、
 * 「読み込み直せなかった」の文を残さない)
 */
type StaleStage = "reloading" | "reloaded" | "reload-failed";

const STALE_LIMIT_MESSAGES: Record<StaleStage, string> = {
  reloading: STALE_LIMIT_RELOADING_MESSAGE,
  reloaded: STALE_LIMIT_MESSAGE,
  "reload-failed": STALE_LIMIT_RELOAD_FAILED_MESSAGE,
};

/** 行に出す文。staleStage は、保存が 409 CONFLICT_STALE_DATA で断られた行の文の段階 (それ以外の文には無い) */
interface RowMessage {
  ok: boolean;
  text: string;
  staleStage?: StaleStage;
}

/** 保存が 409 CONFLICT_STALE_DATA で断られた行の、段階 stage の文 */
function staleRowMessage(stage: StaleStage): RowMessage {
  return { ok: false, text: STALE_LIMIT_MESSAGES[stage], staleStage: stage };
}

/** 409 の文の出ている行の文の段階を、advance で進める (ほかの行の文はそのまま) */
function advanceStaleMessages(
  messages: Record<string, RowMessage>,
  advance: (stage: StaleStage) => StaleStage,
): Record<string, RowMessage> {
  return Object.fromEntries(
    Object.entries(messages).map(([planKey, message]) => [
      planKey,
      message.staleStage === undefined ? message : staleRowMessage(advance(message.staleStage)),
    ]),
  );
}

/** 一覧の読み込みの結果。superseded は、読み込みの最中に新しい読み込みが始まったので結果を捨てた */
type LoadOutcome = "loaded" | "failed" | "superseded";

/** 一覧の行から作る入力欄の初めの値 (保存されている上限。無制限・自分の行が無いときは空欄) */
function initialDraftOf(row: QuotaRow): Draft {
  return { limit: row.configured && row.daily_limit !== null ? String(row.daily_limit) : "", reason: "" };
}

/** 入力欄が書きかけか (最後に読んだ一覧から作った初めの値から、上限か理由を変えている) */
function isDraftEdited(draft: Draft | undefined, loaded: Draft | undefined): boolean {
  if (draft === undefined) return false;
  if (loaded === undefined) return true;
  return draft.limit !== loaded.limit || draft.reason !== loaded.reason;
}

/** 失敗の応答の本文から、画面に出す文 (API の error.message。無ければ HTTP ステータス) */
function errorMessageOfBody(body: unknown, status: number): string {
  const message =
    typeof body === "object" && body !== null ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  return typeof message === "string" ? message : `HTTP ${status}`;
}

async function errorMessageOf(res: Response): Promise<string> {
  return errorMessageOfBody(await res.json().catch(() => null), res.status);
}

export default function LLMQuotasPage() {
  const [rows, setRows] = useState<QuotaRow[]>([]);
  const [note, setNote] = useState("");
  const [defaultPlanKey, setDefaultPlanKey] = useState("free");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 一度表を出したあとの読み直しの最中か・失敗したか (表は外さない。#1917)
  const [isReloading, setIsReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  // 一度一覧を読めたか (読めたあとの読み直しは表を外さない。#1917)
  const hasLoadedRef = useRef(false);
  // 最後に失敗した読み直しの条件 (「再試行」は同じ条件で読み直す。#1917)
  const failedReloadOptions = useRef<{ keepDrafts?: boolean }>({});
  // 読み込みを重ねたとき、古い読み込みの結果で上書きしないための連番
  const loadSeq = useRef(0);
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<string, RowMessage>>({});
  // 行の文のいまの値 (描画を待たずに読むための写し。行の文は updateRowMessages でだけ変える)。
  // 一覧の読み込みが、409 の文の出ている行を見分けて入力欄を残し、文の段階を進めるために読む (#1917)
  const rowMessagesRef = useRef<Record<string, RowMessage>>({});
  // 最後に読んだ一覧から作った入力欄の初めの値 (読み直しのとき、書きかけの行を見分ける。#1917)
  const loadedDrafts = useRef<Record<string, Draft>>({});

  const updateRowMessages = useCallback(
    (update: (prev: Record<string, RowMessage>) => Record<string, RowMessage>) => {
      const next = update(rowMessagesRef.current);
      rowMessagesRef.current = next;
      setRowMessage(next);
    },
    [],
  );

  /**
   * 一覧を読む。keepDrafts のときは、入力欄の書きかけ (新しい上限・理由) を残し、書きかけの無い行だけを読んだ値にする
   * (保存が 409 CONFLICT_STALE_DATA で断られたあとの読み直し。#1917)。
   * 409 の文の出ている行は、keepDrafts でなくても (ほかの行の保存のあとの読み直しでも) 入力欄を残す (文が「入力した値と理由は
   * 残しています」と伝えているため)。その行の文の段階もここで進める (読めたら reloaded、失敗したら reloading を reload-failed。#1917)
   */
  const load = useCallback(async (options: { keepDrafts?: boolean } = {}): Promise<LoadOutcome> => {
    const keepDrafts = options.keepDrafts === true;
    const seq = ++loadSeq.current;
    const isReload = hasLoadedRef.current;
    if (isReload) {
      // 表を出したあとの読み直しは、表を外さずに行う (入力欄のフォーカスも書きかけも残す。#1917)
      setIsReloading(true);
    } else {
      setIsLoading(true);
      setError(null);
    }
    try {
      const res = await fetch("/api/super-admin/llm/quotas");
      if (!res.ok) throw new Error(await errorMessageOf(res));
      const json = (await res.json()) as QuotaListResponse;
      if (seq !== loadSeq.current) return "superseded";
      hasLoadedRef.current = true;
      // 409 の文の出ている行 (入力欄を残すと伝えている行)
      const staleRows = new Set(
        Object.entries(rowMessagesRef.current)
          .filter(([, message]) => message.staleStage !== undefined)
          .map(([planKey]) => planKey),
      );
      setReloadError(null);
      setError(null);
      setRows(json.data);
      setNote(json.note);
      setDefaultPlanKey(json.default_plan_key);
      const previouslyLoaded = loadedDrafts.current;
      const initialDrafts: Record<string, Draft> = Object.fromEntries(
        json.data.map((row) => [row.plan_key, initialDraftOf(row)]),
      );
      loadedDrafts.current = initialDrafts;
      setDrafts((prev) =>
        Object.fromEntries(
          json.data.map((row) => {
            const current = prev[row.plan_key];
            const keep =
              staleRows.has(row.plan_key) || (keepDrafts && isDraftEdited(current, previouslyLoaded[row.plan_key]));
            return [row.plan_key, keep && current !== undefined ? current : initialDrafts[row.plan_key]];
          }),
        ),
      );
      // 読み直せたので、409 の文の出ている行の文を「読み込み直した」文にする (どの経路の読み直しでも。#1917)
      updateRowMessages((prev) => advanceStaleMessages(prev, () => "reloaded"));
      return "loaded";
    } catch (err) {
      if (seq !== loadSeq.current) return "superseded";
      const message = err instanceof Error ? err.message : "読み込みに失敗しました";
      if (isReload) {
        // 表と書きかけは残し、表の上に文と「再試行」を出す (#1917)
        failedReloadOptions.current = options;
        setReloadError(`${RELOAD_FAILED_MESSAGE}（${message}）`);
      } else {
        setError(message);
      }
      // 409 のあとの読み直しの最中だった行の文を「読み込み直せなかった」文にする。すでに読み直せた行 (reloaded) は、
      // 409 のあとに一度読み直せているのでそのまま (#1917)
      updateRowMessages((prev) =>
        advanceStaleMessages(prev, (stage) => (stage === "reloading" ? "reload-failed" : stage)),
      );
      return "failed";
    } finally {
      if (seq === loadSeq.current) {
        setIsLoading(false);
        setIsReloading(false);
      }
    }
  }, [updateRowMessages]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 表の上の「再試行」: 失敗した読み直しを同じ条件でやり直す。409 のあとの読み直しに失敗した行の文は、
   * 読み直せたら load が「読み込み直した」文に変える (#1917)
   */
  const retryReload = async () => {
    await load(failedReloadOptions.current);
  };

  const updateDraft = (planKey: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [planKey]: { ...(prev[planKey] ?? { limit: "", reason: "" }), ...patch } }));
  };

  const save = async (planKey: string) => {
    const draft = drafts[planKey] ?? { limit: "", reason: "" };
    const dailyLimit = parseLimitInput(draft.limit);
    if (dailyLimit === undefined) {
      updateRowMessages((prev) => ({ ...prev, [planKey]: { ok: false, text: `上限は 0〜${AI_DAILY_LIMIT_MAX.toLocaleString()} の整数で入力してください（空欄は無制限）` } }));
      return;
    }
    if (draft.reason.trim() === "") {
      updateRowMessages((prev) => ({ ...prev, [planKey]: { ok: false, text: "変更の理由を入力してください" } }));
      return;
    }
    setSavingPlan(planKey);
    try {
      const res = await fetch("/api/super-admin/llm/quotas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_key: planKey, daily_limit: dailyLimit, reason: draft.reason.trim() }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (isStaleDataConflict(res.status, body)) {
          // 別の運営が先にこのプランの上限を変えていた (API は書いていない)。いまの上限を出すために一覧を読み直し、
          // その旨を行に出す (運営が手で読み直さなくてよいように。#1917)。入力欄の書きかけは消さない。
          // 行の文は「読み直している」にしておき、読み直しの結果で load が進める (読み直せなかったのに「読み込み直した」と出さない。
          // この読み直しが新しい読み込みに追い越されても、その読み込みが進める)
          updateRowMessages((prev) => ({ ...prev, [planKey]: staleRowMessage("reloading") }));
          await load({ keepDrafts: true });
          return;
        }
        throw new Error(errorMessageOfBody(body, res.status));
      }
      updateRowMessages((prev) => ({ ...prev, [planKey]: { ok: true, text: `保存しました（${limitLabel(dailyLimit)}）` } }));
      await load();
    } catch (err) {
      updateRowMessages((prev) => ({
        ...prev,
        [planKey]: { ok: false, text: err instanceof Error ? err.message : "保存に失敗しました" },
      }));
    } finally {
      setSavingPlan(null);
    }
  };

  return (
    <div className="p-8">
      <div className="mb-6">
        <Link href="/super-admin/llm" className="text-slate-400 text-sm hover:text-slate-200">
          ← LLM 使用量
        </Link>
        <h1 className="text-2xl font-bold text-white mt-2">AI の利用上限</h1>
        <p className="text-slate-400 mt-1">プランごとの、AI の 1 日の利用回数の上限</p>
      </div>

      {note && (
        <div className="mb-6 bg-slate-800 border border-slate-700 rounded-xl p-4 text-slate-300 text-sm" data-testid="quota-note">
          {note}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-10 h-10 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div role="alert" className="bg-red-900/50 border border-red-500 rounded-xl p-4 text-red-300 flex items-center justify-between gap-4">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 px-3 py-1 rounded-lg text-sm font-medium border border-red-400 text-red-200 hover:bg-red-900"
          >
            再試行
          </button>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          {reloadError && (
            <div
              role="alert"
              data-testid="quota-reload-error"
              className="mb-4 bg-red-900/50 border border-red-500 rounded-lg px-4 py-3 text-red-300 text-sm flex items-center justify-between gap-4"
            >
              <span>{reloadError}</span>
              <button
                type="button"
                onClick={() => void retryReload()}
                disabled={isReloading}
                className="shrink-0 px-3 py-1 rounded-lg text-sm font-medium border border-red-400 text-red-200 hover:bg-red-900 disabled:opacity-50"
              >
                {isReloading ? "読み込み中…" : "再試行"}
              </button>
            </div>
          )}
          <table className="w-full">
            <thead>
              <tr className="text-slate-400 text-sm border-b border-slate-700">
                <th className="text-left pb-3">プラン</th>
                <th className="text-right pb-3">いまの上限</th>
                <th className="text-left pb-3 pl-6">新しい上限（空欄は無制限）</th>
                <th className="text-left pb-3">変更の理由</th>
                <th className="pb-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {rows.map((row) => {
                const draft = drafts[row.plan_key] ?? { limit: "", reason: "" };
                const message = rowMessage[row.plan_key];
                const readOnlyReason = aiDailyLimitRowReadOnlyReason(row);
                const editable = readOnlyReason === null;
                return (
                  <tr key={row.plan_key} data-testid={`quota-row-${row.plan_key}`}>
                    <td className="py-3">
                      <div className="text-white text-sm">{row.display_name ?? row.plan_key}</div>
                      <div className="text-slate-500 text-xs font-mono">{row.plan_key}</div>
                    </td>
                    <td className="py-3 text-right text-slate-300 text-sm">
                      {limitLabel(row.effective_daily_limit)}
                      {!row.configured && row.plan_key !== defaultPlanKey && (
                        <div className="text-slate-500 text-xs">（{defaultPlanKey} の値）</div>
                      )}
                    </td>
                    <td className="py-3 pl-6">
                      <input
                        type="text"
                        inputMode="numeric"
                        aria-label={`${row.plan_key} の新しい上限`}
                        value={draft.limit}
                        disabled={!editable}
                        onChange={(e) => updateDraft(row.plan_key, { limit: e.target.value })}
                        className="w-28 bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-sm disabled:opacity-50"
                      />
                    </td>
                    <td className="py-3">
                      <input
                        type="text"
                        aria-label={`${row.plan_key} の変更の理由`}
                        value={draft.reason}
                        disabled={!editable}
                        onChange={(e) => updateDraft(row.plan_key, { reason: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-sm disabled:opacity-50"
                      />
                      {readOnlyReason !== null && (
                        <div className="text-slate-500 text-xs mt-1" data-testid={`quota-not-editable-${row.plan_key}`}>
                          {AI_DAILY_LIMIT_READ_ONLY_NOTES[readOnlyReason]}
                        </div>
                      )}
                      {message && (
                        <div className={`text-xs mt-1 ${message.ok ? "text-green-400" : "text-red-400"}`} role="status">
                          {message.text}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => void save(row.plan_key)}
                        // 読み直しの最中は保存しない (読み直しで変わる前の行の値を見て保存させないため。#1917)
                        disabled={!editable || savingPlan !== null || isReloading}
                        className="px-4 py-1.5 rounded-lg text-sm font-medium bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
                      >
                        {savingPlan === row.plan_key ? "保存中…" : "保存"}
                      </button>
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
